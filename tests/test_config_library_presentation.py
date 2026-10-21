import db
import server
from fastapi.testclient import TestClient


def test_only_unchanged_starter_lists_are_presented_as_recommendations():
    assert db.create_user('19900006001', 'librarytest', 'library-test-pass')[0]
    uid = db.authenticate('19900006001', 'library-test-pass')['id']
    with TestClient(server.app) as client:
        assert client.post('/api/login', json={'phone': '19900006001', 'password': 'library-test-pass'}).status_code == 200
        original = client.get('/api/v6/configs').json()
        assert len(original['legacy']) == 3
        assert all(row['recommended'] for row in original['legacy'])
        template = db.list_templates(uid)[0]
        template['items'][0]['name'] = '用户自己修改的候选'
        assert db.update_template(uid, template['id'], template)
        current = client.get('/api/v6/configs').json()['legacy']
        changed = next(row for row in current if row['legacy_id'] == template['id'])
        assert changed['recommended'] is False
        assert changed['config']['items'][0]['name'] == '用户自己修改的候选'
        assert sum(row['recommended'] for row in current) == 2
