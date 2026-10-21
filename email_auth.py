"""Registration email delivery and single-use challenges; no plaintext codes at rest."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

import db

TTL = 600
COOLDOWN = 60
MAX_ATTEMPTS = 5
_LOCAL_SECRET = secrets.token_bytes(32)
logger = logging.getLogger(__name__)


class EmailError(Exception):
    def __init__(self, message, status=400, retry_after=0):
        super().__init__(message)
        self.status, self.retry_after = status, retry_after


def normalize_email(value):
    value = str(value or '').strip()
    if len(value) > 254 or value.count('@') != 1 or re.search(r'[\s\x00-\x1f\x7f]', value):
        raise EmailError('请输入有效的邮箱地址')
    local, domain = value.rsplit('@', 1)
    try:
        domain = domain.encode('idna').decode('ascii').lower()
    except UnicodeError:
        raise EmailError('请输入有效的邮箱地址') from None
    if (not re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}", local)
            or local.startswith('.') or local.endswith('.') or '..' in local
            or len(domain) > 253 or '.' not in domain
            or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in domain.split('.'))):
        raise EmailError('请输入有效的邮箱地址')
    result = local.lower() + '@' + domain
    if len(result) > 254:
        raise EmailError('请输入有效的邮箱地址')
    return result


def mail_config(environment=None):
    env = os.environ if environment is None else environment
    path = env.get('LOTTERY_MAIL_CONFIG_FILE', '')
    data = json.loads(Path(path).read_text(encoding='utf-8-sig')) if path else {}
    if not isinstance(data, dict):
        raise ValueError('Invalid SMTP configuration')
    host = str(data.get('host', env.get('LOTTERY_SMTP_HOST', ''))).strip()
    username = str(data.get('username', env.get('LOTTERY_SMTP_USERNAME', ''))).strip()
    password = data.get('password', '')
    password_file = data.get('password_file', env.get('LOTTERY_SMTP_PASSWORD_FILE', ''))
    if password_file:
        password = Path(password_file).read_text(encoding='utf-8-sig').strip()
    mode = str(data.get('security', env.get('LOTTERY_SMTP_SECURITY', 'ssl')))
    port = int(data.get('port', env.get('LOTTERY_SMTP_PORT', '465')))
    sender = normalize_email(data.get('sender', env.get('LOTTERY_SMTP_SENDER', username)))
    if (not host or re.search(r'[\s/\x00-\x1f]', host) or not username or not password
            or not isinstance(password, str) or mode not in ('ssl', 'starttls') or not 1 <= port <= 65535):
        raise ValueError('Incomplete SMTP configuration')
    return dict(host=host, port=port, username=username, password=password, sender=sender, security=mode)


def configured():
    try:
        mail_config()
        return True
    except (OSError, ValueError, TypeError, EmailError):
        return False


def smtp_connection(config):
    context = ssl.create_default_context()
    if config['security'] == 'ssl':
        smtp = smtplib.SMTP_SSL(config['host'], config['port'], timeout=12, context=context)
    else:
        smtp = smtplib.SMTP(config['host'], config['port'], timeout=12)
    try:
        if config['security'] == 'starttls':
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(config['username'], config['password'])
        return smtp
    except Exception:
        smtp.close()
        raise


def send_code(address, code):
    config = mail_config()
    message = EmailMessage()
    message['Subject'] = '抽了马 · 注册邮箱验证码'
    message['From'] = formataddr(('抽了马', config['sender']))
    message['To'] = address
    message['Date'] = formatdate(localtime=False)
    message['Message-ID'] = make_msgid(domain=config['sender'].split('@')[1])
    message.set_content(f'你的抽了马注册验证码：{code}\n\n10 分钟内有效，仅用于本次注册。请勿转发给他人。\n如果不是你本人申请，请忽略本邮件。\n\n抽了马 · 免费抽，尽兴玩')
    smtp = smtp_connection(config)
    try:
        refused = smtp.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
    finally:
        # SMTP acceptance is authoritative; a QUIT transport error is not a failed delivery.
        smtp.close()


def _digest(value):
    secret = os.getenv('LOTTERY_CARD_SECRET', '').encode() or _LOCAL_SECRET
    return hmac.new(secret, ('email-registration\0' + value).encode(), hashlib.sha256).hexdigest()


def init_schema(connection):
    connection.executescript('''
        CREATE TABLE IF NOT EXISTS email_registration_codes(
          email TEXT PRIMARY KEY COLLATE NOCASE, challenge_id TEXT NOT NULL,
          digest TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS email_send_attempts(
          id TEXT PRIMARY KEY, email_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_email_send_time ON email_send_attempts(created_at);
        CREATE INDEX IF NOT EXISTS idx_email_send_address ON email_send_attempts(email_hash,created_at);
        CREATE INDEX IF NOT EXISTS idx_email_send_ip ON email_send_attempts(ip_hash,created_at);
    ''')


def request_code(email, ip):
    email = normalize_email(email)
    if not configured():
        raise EmailError('邮箱验证服务暂不可用，请稍后再试', 503)
    now = int(time.time())
    challenge = secrets.token_urlsafe(24)
    code = f'{secrets.randbelow(1000000):06d}'
    eh, ih = _digest('email:' + email), _digest('ip:' + ip)
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise EmailError('该邮箱已注册，请直接登录', 409)
        c.execute('DELETE FROM email_send_attempts WHERE created_at<?', (now - 86400,))
        c.execute('DELETE FROM email_registration_codes WHERE created_at<?', (now - 86400,))
        latest = c.execute('SELECT MAX(created_at) FROM email_send_attempts WHERE email_hash=?', (eh,)).fetchone()[0]
        if latest is not None and now - latest < COOLDOWN:
            raise EmailError('请稍后再获取验证码', 429, max(1, COOLDOWN - (now - latest)))
        limits = [('email_hash=?', (eh,), 86400, 5), ('ip_hash=?', (ih,), 3600, 10),
                  ('ip_hash=?', (ih,), 86400, 30), ('1=1', (), 3600, 60), ('1=1', (), 86400, 500)]
        for condition, params, window, maximum in limits:
            count = c.execute(f'SELECT COUNT(*) FROM email_send_attempts WHERE {condition} AND created_at>?', (*params, now-window)).fetchone()[0]
            if count >= maximum:
                raise EmailError('验证码发送过于频繁，请稍后再试', 429, window)
        c.execute('INSERT INTO email_send_attempts VALUES(?,?,?,?)', (challenge, eh, ih, now))
        c.execute('''INSERT INTO email_registration_codes VALUES(?,?,?,?,0,'pending',?)
          ON CONFLICT(email) DO UPDATE SET challenge_id=excluded.challenge_id,digest=excluded.digest,
          expires_at=excluded.expires_at,attempts=0,state='pending',created_at=excluded.created_at''',
                  (email, challenge, _digest(email+'\0'+challenge+'\0'+code), now+TTL, now))
    try:
        send_code(email, code)
    except Exception as error:
        with db.conn() as c:
            c.execute("UPDATE email_registration_codes SET state='failed',digest='' WHERE email=? AND challenge_id=?", (email,challenge))
        logger.warning('Registration email delivery failed (%s)', type(error).__name__)
        raise EmailError('验证码发送失败，请稍后重试；也请确认邮箱地址是否正确', 503, COOLDOWN) from None
    with db.conn() as c:
        updated = c.execute("UPDATE email_registration_codes SET state='sent',expires_at=? WHERE email=? AND challenge_id=? AND state='pending'", (int(time.time())+TTL,email,challenge)).rowcount
        if not updated:
            raise EmailError('本次验证码已被更新，请使用最新一次发送的验证码', 409)
    return {'success': True, 'challenge_id': challenge, 'expires_in': TTL, 'retry_after': COOLDOWN}


def consume_code(connection, email, challenge, code):
    """Called inside the account transaction. Failure counters must be committed by caller."""
    row = connection.execute('SELECT * FROM email_registration_codes WHERE email=?', (email,)).fetchone()
    invalid = '验证码错误、已过期或已使用，请重新获取'
    if (not row or row['challenge_id'] != challenge or row['state'] != 'sent'
            or row['expires_at'] <= int(time.time()) or row['attempts'] >= MAX_ATTEMPTS):
        return invalid
    if not re.fullmatch(r'[0-9]{6}', code) or not secrets.compare_digest(row['digest'], _digest(email+'\0'+challenge+'\0'+code)):
        connection.execute("UPDATE email_registration_codes SET attempts=attempts+1,state=CASE WHEN attempts+1>=? THEN 'locked' ELSE state END WHERE email=?", (MAX_ATTEMPTS,email))
        return invalid
    connection.execute("UPDATE email_registration_codes SET state='consumed',digest='' WHERE email=?", (email,))
    return ''
