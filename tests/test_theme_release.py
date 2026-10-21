import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
import server
import db
import v6_engine as engine
import v6_payments as payments


def test_legacy_configs_and_cross_theme_sounds(cfg):
    assert cfg.sound == ''
    for theme, prefix in [('classic','slot-default'),('cosmic','slot-cosmic')]:
        for n in range(1,4):
            assert engine.DrawConfig.model_validate({**cfg.model_dump(), 'theme':theme,'sound':prefix+str(n)}).sound
    with pytest.raises(ValidationError):
        engine.DrawConfig.model_validate({**cfg.model_dump(),'sound':'slot-cosmic1'})


def test_appearance_preserves_no_repeat_records_and_inventory(cfg):
    for mode in ['no_repeat','inventory']:
        config=engine.DrawConfig.model_validate({**cfg.model_dump(),'app':'prize','mode':mode})
        run=engine.new_run('guest:theme',config)
        first=engine.draw('guest:theme',run['id'],'first-draw',run['control_token'])
        before=engine.get_run('guest:theme',run['id'])
        engine.change_appearance('guest:theme',run['id'],run['control_token'],'capsule','classic','slot-default3')
        after=engine.get_run('guest:theme',run['id'])
        assert after['draws']==before['draws'] and after['events']==before['events']
        assert after['config']['items']==before['config']['items']
        second=engine.draw('guest:theme',run['id'],'second-draw',run['control_token'])
        assert first['results'][0]['id']!=second['results'][0]['id']


def test_appearance_authority_entitlements_and_busy_state(cfg):
    run=engine.new_run('guest:theme',cfg)
    args=('guest:theme',run['id'],run['control_token'],'sphere','cosmic','slot-cosmic1')
    with pytest.raises(engine.DomainError) as err: engine.change_appearance(*args)
    assert err.value.status==403
    with pytest.raises(engine.DomainError): engine.change_appearance('guest:other',*args[1:])
    with pytest.raises(engine.DomainError): engine.change_appearance(args[0],args[1],'invalid-control',*args[3:])
    with db.conn() as c:
        c.execute('INSERT INTO v6_entitlements VALUES(?,?,?,?)',('guest:theme','cosmic',None,'card:existing'))
    for machine in ['sphere','capsule','wheel']:
        assert engine.change_appearance(*args[:3],machine,*args[4:])['machine']==machine
    engine.start(*args[:2],'active-draw',args[2],controller_id='test-controller')
    with pytest.raises(engine.DomainError) as err: engine.change_appearance(*args)
    assert err.value.status==409


def test_rehearsal_and_group_compatibility(cfg):
    config=engine.DrawConfig.model_validate({**cfg.model_dump(),'mode':'groups'})
    run=engine.new_run('guest:theme',config,rehearsal=True)
    result=engine.change_appearance('guest:theme',run['id'],run['control_token'],'sphere','cosmic','slot-cosmic2')
    assert result['theme']=='cosmic'
    with pytest.raises(engine.DomainError) as err:
        engine.change_appearance('guest:theme',run['id'],run['control_token'],'wheel','cosmic','slot-cosmic2')
    assert err.value.status==422
    engine.archive('guest:theme',run['id'],run['control_token'])
    with pytest.raises(engine.DomainError) as err:
        engine.change_appearance('guest:theme',run['id'],run['control_token'],'sphere','classic','slot-default1')
    assert err.value.status==409


def test_http_appearance_rejects_paid_upgrade_and_keeps_existing_prices(cfg):
    with TestClient(server.app) as client:
        client.get('/api/v6/status')
        run=client.post('/api/v6/runs',json={'config':cfg.model_dump()}).json()
        body={'machine':'capsule','theme':'classic','sound':'slot-default2','control_token':run['control_token']}
        path=f"/api/v6/runs/{run['id']}/appearance"
        assert client.post(path,json=body).status_code==200
        assert client.post(path,json={**body,'theme':'cosmic','sound':'slot-cosmic1'}).status_code==403
        assert client.post(path,json={**body,'sound':'slot-cosmic1'}).status_code==422
        view=client.get(f"/api/v6/display/{run['id']}",headers={'X-View-Token':run['view_token']}).json()
        assert view['sound']=='slot-default2' and 'control_token' not in view
        product=next(p for p in client.get('/api/v6/shop').json()['products'] if p['slug']=='cosmic')
        assert set(product['machines'])=={'capsule','wheel','sphere'}
        assert product['price_cents']==990 and product['sale_enabled'] is False
