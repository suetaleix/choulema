import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["V6_SALES_ENABLED"] = "0"
os.environ["ALIPAY_APP_ID"] = ""
os.environ["ALIPAY_SELLER_ID"] = ""
os.environ["ALIPAY_PRIVATE_KEY_FILE"] = ""
os.environ["ALIPAY_PUBLIC_KEY_FILE"] = ""
os.environ["LOTTERY_ADMIN_PHONE"] = ""
os.environ["LOTTERY_ADMIN_PASSWORD"] = ""

import db
import v6_engine as engine


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    # Each disposable database represents a fresh server, including abuse counters.
    import server
    import email_auth
    # Never send external mail from automated tests, even with local runtime credentials.
    for key in tuple(os.environ):
        if key.startswith('LOTTERY_SMTP_') or key == 'LOTTERY_MAIL_CONFIG_FILE':
            monkeypatch.delenv(key, raising=False)
    def forbidden_delivery(*args):
        raise AssertionError('External mail delivery is disabled in tests')
    monkeypatch.setattr(email_auth, 'send_code', forbidden_delivery)
    from collections import defaultdict, deque
    monkeypatch.setattr(server, '_RATE', defaultdict(deque))
    monkeypatch.setattr(server, '_LOGIN_FAIL', defaultdict(deque))
    monkeypatch.setattr(server, '_CAPTCHAS', {})
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.sqlite"))
    db.init_db()
    engine.init_schema()
    import v6_payments
    v6_payments.init_schema()
    import v7_referrals
    v7_referrals.init_schema()
    import v7_entitlements
    v7_entitlements.init_schema()
    import v7_operations
    v7_operations.init_schema()


@pytest.fixture
def email_outbox(monkeypatch):
    import email_auth
    messages = []
    monkeypatch.setattr(email_auth, 'configured', lambda: True)
    monkeypatch.setattr(email_auth, 'send_code', lambda email, code: messages.append((email, code)))
    return messages


@pytest.fixture
def email_registration(email_outbox):
    def payload(client, email, custom_id=None, password='test-password'):
        response = client.post('/api/register/email-code', json={'email': email})
        assert response.status_code == 200, response.text
        result = dict(email=email, password=password, challenge_id=response.json()['challenge_id'], email_code=email_outbox[-1][1])
        if custom_id:
            result['custom_id'] = custom_id
        return result
    return payload


@pytest.fixture
def cfg():
    return engine.DrawConfig(app="person", machine="sphere", mode="no_repeat", items=[engine.Candidate(id=str(i), name="同名" if i < 2 else f"同学{i}") for i in range(10)])
