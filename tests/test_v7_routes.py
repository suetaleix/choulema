from fastapi.testclient import TestClient

import db
import server


def test_three_page_routes_and_legacy_query_preservation():
    with TestClient(server.app) as client:
        cases={
            '/':'/login.html', '/?invite=abcdEFGH':'/login.html?invite=abcdEFGH',
            '/?app=person':'/play.html?app=person','/?display=run-one':'/play.html?display=run-one',
            '/index.html?app=food':'/play.html?app=food','/home.html?scene=play':'/play.html?scene=play',
            '/payment-return.html?order=one':'/play.html?order=one',
            '/password.html?next=%2Fplay.html':'/login.html?next=%2Fplay.html&mode=password',
        }
        for path,target in cases.items():
            response=client.get(path,follow_redirects=False)
            assert response.status_code==302 and response.headers['location']==target
        assert client.get('/login.html').status_code==200
        document_guest = client.cookies.get('gk')
        assert document_guest
        for endpoint in ('/api/me', '/api/v7/public', '/api/captcha'):
            assert 'gk=' not in client.get(endpoint).headers.get('set-cookie', '')
            assert client.cookies.get('gk') == document_guest
        response=client.get('/admin.html',follow_redirects=False)
        assert response.status_code==302 and response.headers['location']=='/login.html?next=%2Fadmin.html'
        for alias in ('/admin.html/', '/Admin.html', '/admin.html/.'):
            response = client.get(alias)
            assert response.status_code == 200
            assert response.url.path == '/login.html'


def test_admin_page_is_guarded_and_content_updates_are_audited():
    assert db.create_user('13999999001','normalUser','test-password')[0]
    assert db.create_user('13999999002','adminUser','test-password')[0]
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE phone='13999999002'")
    with TestClient(server.app) as client:
        client.post('/api/login',json={'phone':'13999999001','password':'test-password'})
        assert client.get('/admin.html').status_code==403
        assert client.get('/api/v7/admin/system').status_code==403
        client.post('/api/login',json={'phone':'13999999002','password':'test-password'})
        assert client.get('/admin.html').status_code==200
        data={'hero_title':'新的主张','hero_text':'保持免费体验','cta':'免费开始','notice':'仅本地测试'}
        assert client.put('/api/v7/admin/content',json={'content':data,'reason':'更新首屏介绍'}).status_code==200
        published=client.get('/api/v7/public').json()['content']
        assert all(published[key]==value for key,value in data.items())
        assert published['hero_machine']=='capsule' and len(published['faq'])>=1
        assert any(row['action']=='public_content' for row in client.get('/api/v6/admin/audit').json()['events'])
        status=client.get('/api/v7/admin/system').json()
        assert status['sales_enabled'] is False and status['payment_ready'] is False
        assert 'private_file' not in str(status)


def test_metrics_are_debounced_and_dont_accept_roster_information():
    with TestClient(server.app) as client:
        for _ in range(3):
            assert client.post('/api/v7/events',json={'event':'skin_preview'}).status_code==200
        assert client.post('/api/v7/events',json={'event':'skin_preview','names':['someone']}).status_code==422
        with db.conn() as c:
            assert c.execute('SELECT COUNT(*) FROM v7_metrics').fetchone()[0]==1
