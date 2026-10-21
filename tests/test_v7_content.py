"""Published content and registration controls use only disposable databases."""
import json

import pytest
from fastapi.testclient import TestClient

import db
import server


@pytest.fixture
def administrator():
    assert db.create_user('13999999101', 'contentAdmin', 'test-password')[0]
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE phone='13999999101'")
    with TestClient(server.app) as client:
        assert client.post('/api/login', json={'phone':'13999999101', 'password':'test-password'}).status_code == 200
        yield client


def test_legacy_content_and_partial_updates_preserve_other_copy(administrator):
    db.set_setting('v7_public_content', json.dumps({'hero_title':'原有标题', 'hero_text':'原有介绍', 'cta':'开始玩', 'notice':'保留公告'}))
    client = administrator
    old = client.get('/api/v7/public').json()['content']
    assert old['hero_title'] == '原有标题' and old['hero_machine'] == 'capsule'
    assert len(old['faq']) == 3
    update = {
        'hero_machine':'sphere', 'intro_text':'  换一种方式选择  ',
        'scene_descriptions':{'food':'今天的晚餐'},
        'faq':[{'question':'可以免费玩吗？', 'answer':'可以。<b>这仍是纯文本</b>'}],
    }
    response = client.put('/api/v7/admin/content', json={'content':update, 'reason':'调整登录介绍'})
    assert response.status_code == 200
    current = client.get('/api/v7/public').json()['content']
    assert current['hero_title'] == old['hero_title'] and current['notice'] == old['notice']
    assert current['hero_machine'] == 'sphere' and current['intro_text'] == '换一种方式选择'
    assert current['scene_descriptions'] == {**old['scene_descriptions'], 'food':'今天的晚餐'}
    assert current['faq'] == update['faq']
    assert client.put('/api/v7/admin/content', json={'content':{'notice':''}, 'reason':'清空公告'}).status_code == 200
    latest = client.get('/api/v7/public').json()['content']
    assert latest == {**current, 'notice':''}
    with db.conn() as c:
        events = c.execute("SELECT detail FROM admin_audit WHERE action='public_content' ORDER BY id").fetchall()
    assert len(events) == 2
    first = json.loads(events[0]['detail'])
    assert first['before'] == old and first['after'] == current


@pytest.mark.parametrize('bad_content', [
    {'hero_machine':'javascript:alert(1)'},
    {'hero_title':'   '},
    {'faq':[]},
    {'faq':[{'question':'问题', 'answer':'   '}]},
    {'faq':[{'question':'问题', 'answer':'回答', 'script':'x'}]},
    {'faq':[{'question':'问题', 'answer':'回答'}] * 9},
    {'scene_descriptions':{'other':'未知用途'}},
    {'scene_descriptions':{'food':None}},
])
def test_invalid_content_cannot_partially_publish(administrator, bad_content):
    previous = administrator.get('/api/v7/public').json()['content']
    response = administrator.put('/api/v7/admin/content', json={'content':bad_content, 'reason':'非法输入测试'})
    assert response.status_code == 422
    assert administrator.get('/api/v7/public').json()['content'] == previous
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='public_content'").fetchone()[0] == 0


def test_registration_toggle_changes_real_registration_and_keeps_existing_login(administrator, email_registration):
    client = administrator
    assert client.put('/api/v7/admin/system', json={'registration_open':False, 'reason':'临时停止新注册'}).status_code == 200
    assert client.get('/api/v7/public').json()['registration_open'] is False
    with TestClient(server.app) as guest:
        registration = {'email':'fresh@example.test', 'custom_id':'freshUser', 'password':'test-password'}
        assert guest.post('/api/register', json=registration).status_code == 403
        assert guest.post('/api/login', json={'phone':'13999999101', 'password':'test-password'}).status_code == 200
    assert client.put('/api/v7/admin/system', json={'registration_open':True, 'reason':'恢复新用户注册'}).status_code == 200
    with TestClient(server.app) as guest:
        registration = email_registration(guest, 'fresh@example.test', 'freshUser')
        assert guest.post('/api/register', json=registration).status_code == 200
    with db.conn() as c:
        events = [json.loads(row[0]) for row in c.execute("SELECT detail FROM admin_audit WHERE action='registration_setting' ORDER BY id")]
    assert [(e['before'], e['after']) for e in events] == [(True, False), (False, True)]


def test_settings_reject_extra_flags_wrong_types_blank_reasons_and_non_admin(administrator):
    for body in (
        {'registration_open':False, 'reason':'关闭注册', 'sales_enabled':True},
        {'registration_open':'false', 'reason':'关闭注册'},
        {'registration_open':0, 'reason':'关闭注册'},
        {'registration_open':False, 'reason':'  '},
    ):
        assert administrator.put('/api/v7/admin/system', json=body).status_code == 422
    assert administrator.put('/api/v7/admin/content', json={'content':{'notice':'公告'}, 'reason':'  '}).status_code == 422
    assert administrator.get('/api/v7/public').json()['registration_open'] is True
    assert db.create_user('13999999103', 'ordinaryUser', 'test-password')[0]
    with TestClient(server.app) as client:
        for logged_in in (False, True):
            if logged_in:
                client.post('/api/login', json={'phone':'13999999103', 'password':'test-password'})
            expected = 403 if logged_in else 401
            assert client.put('/api/v7/admin/system', json={'registration_open':False, 'reason':'无权更改'}).status_code == expected
            assert client.put('/api/v7/admin/content', json={'content':{'notice':'无权公告'}, 'reason':'无权更改'}).status_code == expected
