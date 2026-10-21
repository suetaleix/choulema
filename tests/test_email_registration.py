"""Email registration acceptance with captured transport, never external delivery."""
import json
import sqlite3
import ssl
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import db
import email_auth as mail
from email_auth import send_code as real_send_code
import server
import v7_operations
import v7_referrals


@pytest.mark.parametrize('address,expected', [
    ('  A.B+Tag@EXAMPLE.com ', 'a.b+tag@example.com'),
    ('test@例子.中国', 'test@xn--fsqu00a.xn--fiqs8s'),
])
def test_email_normalization(address, expected):
    assert mail.normalize_email(address) == expected


@pytest.mark.parametrize('address', ['plain', 'a@localhost', 'a..b@example.com', '.a@example.com',
    'a@example..com', 'a@-example.com', 'a@exam ple.com', 'a@example.com\r\nBcc:x@y.com',
    'a'*65+'@example.com', '用户@example.com', 'a@@example.com'])
def test_invalid_email_rejected_before_sending(address, email_outbox):
    with TestClient(server.app) as client:
        assert client.post('/api/register/email-code', json={'email': address}).status_code == 400
    assert email_outbox == []


def test_email_only_registration_login_and_admin_search(email_registration):
    with TestClient(server.app) as client:
        payload = email_registration(client, 'First+Tag@Example.test')
        assert 'custom_id' not in payload
        assert client.post('/api/register', json=payload).status_code == 200
        assert client.post('/api/login', json={'identifier': 'FIRST+TAG@example.test', 'password': payload['password']}).status_code == 200
        user = client.get('/api/me').json()['user']
        assert user['email'] == 'first+tag@example.test' and user['email_verified']
        assert user['phone'] is None and user['custom_id'].startswith('u')
        assert len(db.list_templates(user['id'])) > 0
        client.post('/api/logout')
        assert client.post('/api/login', json={'identifier': user['custom_id'], 'password': payload['password']}).status_code == 200
        assert client.post('/api/register', json=payload).status_code == 400
        assert client.post('/api/register/email-code', json={'email': payload['email']}).status_code == 409
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (user['id'],))
        matches = client.get('/api/admin/users?q=FIRST%2BTAG').json()['users']
        assert [u['id'] for u in matches] == [user['id']]
        assert matches[0]['email_verified'] is True
        with db.conn() as c:
            c.execute("UPDATE users SET status='disabled' WHERE id=?", (user['id'],))
        assert client.post('/api/login', json={'identifier': payload['email'], 'password': payload['password']}).status_code == 403


def test_legacy_id_and_phone_login_and_no_captcha_bypass():
    assert db.create_user('19900001111', 'existing', 'test-password')[0]
    with TestClient(server.app) as client:
        for credentials in ({'identifier': 'existing'}, {'phone': '19900001111'}):
            assert client.post('/api/login', json={**credentials, 'password': 'test-password'}).status_code == 200
        captcha = client.get('/api/captcha').json()['id']
        response = client.post('/api/register', json={'phone': '19900002222', 'custom_id': 'bypass', 'password': 'test-password',
            'captcha_id': captcha, 'captcha_code': server._CAPTCHAS[captcha][0]})
        assert response.status_code == 400
        assert db.count_users() == 1


def test_code_hash_not_plaintext_and_wrong_attempts_lock(email_registration):
    with TestClient(server.app) as client:
        payload = email_registration(client, 'attempts@example.test')
        with db.conn() as c:
            row = dict(c.execute('SELECT * FROM email_registration_codes').fetchone())
            assert len(row['digest']) == 64 and payload['email_code'] not in json.dumps(row)
        wrong = '000000' if payload['email_code'] != '000000' else '999999'
        for _ in range(5):
            assert client.post('/api/register', json={**payload, 'email_code': wrong}).status_code == 400
        assert client.post('/api/register', json=payload).status_code == 400
        with db.conn() as c:
            row = c.execute('SELECT * FROM email_registration_codes').fetchone()
            assert row['attempts'] == 5 and row['state'] == 'locked'
        assert db.count_users() == 0


def test_email_challenge_binding_expiry_and_resend(email_registration, email_outbox, monkeypatch):
    clock = [time.time()]
    monkeypatch.setattr(mail.time, 'time', lambda: clock[0])
    with TestClient(server.app) as client:
        first = email_registration(client, 'resend@example.test')
        for change in ({'email': 'different@example.test'}, {'challenge_id': 'not-issued'}):
            assert client.post('/api/register', json={**first, **change}).status_code == 400
        blocked = client.post('/api/register/email-code', json={'email': first['email']})
        assert blocked.status_code == 429 and int(blocked.headers['retry-after']) > 0
        clock[0] += 61
        second = email_registration(client, first['email'])
        assert first['challenge_id'] != second['challenge_id']
        assert client.post('/api/register', json=first).status_code == 400
        clock[0] += 601
        assert client.post('/api/register', json=second).status_code == 400
        third = email_registration(client, first['email'])
        assert client.post('/api/register', json=third).status_code == 200
        assert len(email_outbox) == 3


def test_send_failure_is_generic_and_cannot_create_account(email_outbox, monkeypatch, caplog):
    def fail(*_):
        raise RuntimeError('private-password-must-not-escape')
    monkeypatch.setattr(mail, 'send_code', fail)
    with TestClient(server.app) as client:
        response = client.post('/api/register/email-code', json={'email': 'fail@example.test'})
        assert response.status_code == 503
        assert 'private-password' not in response.text + caplog.text
        with db.conn() as c:
            row = c.execute('SELECT * FROM email_registration_codes').fetchone()
            assert row['state'] == 'failed' and not row['digest']
            assert c.execute('SELECT COUNT(*) FROM email_send_attempts').fetchone()[0] == 1
        assert client.post('/api/register', json={'email': 'fail@example.test', 'password': 'test-password',
            'challenge_id': row['challenge_id'], 'email_code': '000000'}).status_code == 400


def test_smtp_unconfigured_registration_fails_closed():
    with TestClient(server.app) as client:
        assert client.get('/api/v7/public').json()['email_verification_ready'] is False
        assert client.post('/api/register/email-code', json={'email': 'test@example.test'}).status_code == 503


@pytest.mark.parametrize('budget,key,maximum,window', [('email','email_hash',5,86400), ('ip-hour','ip_hash',10,3600),
    ('ip-day','ip_hash',30,86400), ('global-hour',None,60,3600), ('global-day',None,500,86400)])
def test_persistent_send_budgets(budget, key, maximum, window, email_outbox):
    now = int(time.time())
    age = 3601 if window == 86400 and budget != 'email' else 61
    with db.conn() as c:
        for i in range(maximum):
            c.execute('INSERT INTO email_send_attempts VALUES(?,?,?,?)', (str(i),
                mail._digest('email:limited@example.test') if key == 'email_hash' else str(i),
                mail._digest('ip:budget-client') if key == 'ip_hash' else str(i), now-age))
    with pytest.raises(mail.EmailError) as error:
        mail.request_code('limited@example.test', 'budget-client')
    assert error.value.status == 429 and not email_outbox


def test_signup_referral_failure_rolls_back_code_and_account(email_registration, monkeypatch):
    original = v7_referrals.register_created
    def fail(*args):
        raise RuntimeError('simulated referral failure')
    with TestClient(server.app, raise_server_exceptions=False) as client:
        payload = email_registration(client, 'rollback@example.test')
        monkeypatch.setattr(v7_referrals, 'register_created', fail)
        assert client.post('/api/register', json=payload).status_code == 500
        assert db.count_users() == 0
        with db.conn() as c:
            assert c.execute('SELECT state FROM email_registration_codes').fetchone()[0] == 'sent'
            assert c.execute('SELECT COUNT(*) FROM templates').fetchone()[0] == 0
        monkeypatch.setattr(v7_referrals, 'register_created', original)
        assert client.post('/api/register', json=payload).status_code == 200


def test_concurrent_code_consumption_creates_only_one_account(email_registration):
    with TestClient(server.app) as client:
        payload = email_registration(client, 'race@example.test')
    def register():
        with TestClient(server.app) as other:
            return other.post('/api/register', json=payload).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: register(), range(2))) == [200, 400]
    assert db.count_users() == 1


def test_closed_registration_and_maintenance_prevent_delivery(email_outbox):
    with TestClient(server.app) as client:
        db.set_setting('registration_open', '0')
        response = client.post('/api/register/email-code', json={'email': 'closed@example.test'})
        assert response.status_code == 403
        db.set_setting('registration_open', '1')
        controls = v7_operations.controls()
        v7_operations.update({**controls, 'maintenance': True}, 'isolated test maintenance', 1)
        assert client.post('/api/register/email-code', json={'email': 'closed@example.test'}).status_code == 503
    assert not email_outbox


def test_legacy_migration_preserves_rows_foreign_keys_indexes_triggers_and_sequence(tmp_path):
    path = tmp_path / 'legacy.sqlite'
    c = sqlite3.connect(path)
    c.executescript('''
      PRAGMA foreign_keys=ON;
      CREATE TABLE "users"(id INTEGER PRIMARY KEY AUTOINCREMENT, "phone" TEXT UNIQUE NOT NULL, custom_id TEXT UNIQUE, password_hash TEXT);
      CREATE TABLE child(user_id INTEGER REFERENCES users(id), value TEXT);
      CREATE TABLE audit(value TEXT);
      CREATE INDEX user_custom ON users(custom_id);
      CREATE TRIGGER user_audit AFTER UPDATE OF custom_id ON users BEGIN INSERT INTO audit VALUES(new.custom_id); END;
      INSERT INTO users VALUES(7,'19900003333','keep','hash');
      INSERT INTO child VALUES(7,'owned-value');
      INSERT INTO users VALUES(99,'19900004444','deleted','hash');
      DELETE FROM users WHERE id=99;
    ''')
    before = list(c.execute('SELECT * FROM users'))
    db._migrate_email_identity(c)
    db._migrate_email_identity(c)
    assert list(c.execute('SELECT id,phone,custom_id,password_hash FROM users')) == before
    assert list(c.execute('SELECT * FROM child')) == [(7, 'owned-value')]
    assert not c.execute('PRAGMA foreign_key_check').fetchall()
    assert c.execute('PRAGMA foreign_keys').fetchone()[0] == 1
    c.execute("INSERT INTO users(custom_id,email) VALUES('new','one@example.test')")
    assert c.execute("SELECT id FROM users WHERE custom_id='new'").fetchone()[0] == 100
    c.execute("UPDATE users SET custom_id='changed' WHERE id=7")
    assert c.execute('SELECT value FROM audit').fetchone()[0] == 'changed'
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO users(custom_id,email) VALUES('duplicate','ONE@example.test')")
    c.close()


def test_failed_migration_restores_original_schema(tmp_path):
    c = sqlite3.connect(tmp_path / 'bad-legacy.sqlite')
    c.executescript('''CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,phone TEXT UNIQUE NOT NULL);
      CREATE TABLE child(user_id INTEGER REFERENCES users(id)); INSERT INTO child VALUES(999);''')
    with pytest.raises(RuntimeError, match='Foreign key'):
        db._migrate_email_identity(c)
    assert next(row for row in c.execute('PRAGMA table_info(users)') if row[1] == 'phone')[3] == 1
    assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='users_email_upgrade'").fetchone()
    c.close()


@pytest.mark.parametrize('security', ['ssl', 'starttls'])
def test_smtp_transport_uses_validated_tls(security, monkeypatch):
    events = []
    class SMTP:
        def __init__(self, host, port, **kwargs):
            if 'context' in kwargs:
                assert kwargs['context'].verify_mode == ssl.CERT_REQUIRED and kwargs['context'].check_hostname
            events.append('connect')
        def ehlo(self): events.append('ehlo')
        def starttls(self, context):
            assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
            events.append('tls')
        def login(self, username, password): events.append('login')
        def close(self): events.append('close')
    monkeypatch.setattr(mail.smtplib, 'SMTP_SSL' if security == 'ssl' else 'SMTP', SMTP)
    connection = mail.smtp_connection(dict(host='smtp.example.test',port=465,security=security,username='user',password='secret'))
    if security == 'starttls': assert events.index('tls') < events.index('login')
    connection.close()


def test_smtp_configuration_and_safe_message(tmp_path, monkeypatch):
    config = tmp_path / 'mail.json'
    config.write_text('[]')
    with pytest.raises(ValueError): mail.mail_config({'LOTTERY_MAIL_CONFIG_FILE': str(config)})
    data = dict(host='smtp.example.test', port=465, security='ssl', username='sender@example.test', sender='sender@example.test', password='secret')
    config.write_text(json.dumps(data))
    monkeypatch.setenv('LOTTERY_MAIL_CONFIG_FILE', str(config))
    assert mail.configured()
    messages = []
    class SMTP:
        def send_message(self, message): messages.append(message); return {}
        def close(self): pass
    monkeypatch.setattr(mail, 'smtp_connection', lambda _: SMTP())
    real_send_code('recipient@example.test', '123456')
    assert messages[0]['To'] == 'recipient@example.test'
    assert '123456' in messages[0].get_content()
    assert 'secret' not in messages[0].as_string()
    config.write_text(json.dumps({**data, 'security': 'plain'}))
    assert not mail.configured()


def test_local_launcher_uses_only_explicit_private_mail_file(tmp_path, monkeypatch):
    from scripts import start_local
    monkeypatch.setattr(start_local, 'ROOT', tmp_path)
    inherited = {'LOTTERY_MAIL_CONFIG_FILE': 'production-secret', 'LOTTERY_SMTP_HOST': 'production-host',
                 'LOTTERY_DB': 'production.sqlite', 'ALIPAY_APP_ID': 'merchant', 'V6_SALES_ENABLED': '1'}
    clean = start_local.local_environment(8911, inherited)
    assert 'LOTTERY_MAIL_CONFIG_FILE' not in clean and 'LOTTERY_SMTP_HOST' not in clean
    assert 'ALIPAY_APP_ID' not in clean and clean['V6_SALES_ENABLED'] == '0'
    private = tmp_path / 'private.json'
    private.write_text('{}')
    explicit = start_local.local_environment(8911, inherited, private)
    assert explicit['LOTTERY_MAIL_CONFIG_FILE'] == str(private.resolve())
    public = tmp_path / 'static' / 'mail.json'
    public.parent.mkdir()
    public.write_text('{}')
    with pytest.raises(ValueError): start_local.local_environment(8911, inherited, public)
    with pytest.raises(ValueError): start_local.local_environment(8911, inherited, tmp_path / 'absent.json')


def test_preflight_does_not_expose_bad_mail_secrets(tmp_path):
    import v7_release
    file = tmp_path / 'bad-mail.json'
    file.write_text('{"password":"do-not-disclose"}')
    report = v7_release.preflight({'LOTTERY_MAIL_CONFIG_FILE': str(file)})
    assert not report['ok'] and 'do-not-disclose' not in str(report)
    assert any('email configuration' in error for error in report['errors'])
