"""Read-only release checks. Never print credentials or create a production database."""
import json
import os
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
RELEASE = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))


def preflight(environment=None):
    env = os.environ if environment is None else environment
    errors, warnings = [], []
    production = env.get('LOTTERY_ENV', 'development') == 'production'
    if sys.version_info < (3, 11):
        errors.append('Python 3.11 or later is required')
    from v7_catalog import CONTENT
    if RELEASE['version'] != CONTENT['version'] or RELEASE['catalog_schema'] != CONTENT['schema_version']:
        errors.append('Release and content catalog versions differ')
    for relative in ('static/login.html', 'static/play.html', 'static/admin.html', 'static/v7/content-catalog.mjs', 'static/v7/theme-stage.mjs'):
        if not (ROOT / relative).is_file():
            errors.append('Missing runtime file: ' + relative)
    audio = json.loads((ROOT / 'static/v7/audio/manifest.json').read_text(encoding='utf-8'))
    # Audio byte integrity is validated by the release packager, not every request.
    if not audio:
        errors.append('Audio manifest is empty')
    if production:
        for key in ('LOTTERY_DB', 'LOTTERY_BACKUP_DIR'):
            value = env.get(key, '')
            path = Path(value)
            if not value or not path.is_absolute() or path.resolve().is_relative_to(ROOT):
                errors.append(key + ' must be an absolute path outside the release directory')
        database = Path(env.get('LOTTERY_DB', ''))
        backup = Path(env.get('LOTTERY_BACKUP_DIR', ''))
        if str(database) == str(backup):
            errors.append('Database and backup directory must be different paths')
        url = urlparse(env.get('LOTTERY_PUBLIC_URL', ''))
        if url.scheme != 'https' or not url.hostname or url.hostname in ('localhost', '127.0.0.1', '::1') or url.hostname.endswith('.example') or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            errors.append('LOTTERY_PUBLIC_URL must be a public HTTPS origin')
        secret = env.get('LOTTERY_CARD_SECRET', '')
        if len(secret) < 32 or len(set(secret)) < 8:
            errors.append('LOTTERY_CARD_SECRET must be a persistent random secret of at least 32 characters')
        for key in ('ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE'):
            if env.get(key):
                path = Path(env[key])
                if not path.is_absolute() or path.resolve().is_relative_to(ROOT) or not path.is_file():
                    errors.append(key + ' must point to a private file outside the release directory')
        if env.get('LOTTERY_ADMIN_PASSWORD') and len(env['LOTTERY_ADMIN_PASSWORD']) < 10:
            errors.append('Initial administrator password must contain at least 10 characters')
        if not database.is_file() and (not env.get('LOTTERY_ADMIN_PHONE') or not env.get('LOTTERY_ADMIN_PASSWORD')):
            errors.append('A fresh production database requires an initial administrator phone and password')
        if env.get('V6_SALES_ENABLED') == '1':
            if environment is not None:
                errors.append('Payment readiness must be checked using the actual process environment')
            else:
                import v6_payments
                if not v6_payments.configured():
                    errors.append('Sales are enabled but Alipay configuration is incomplete or invalid')
        else:
            warnings.append('New online sales are closed; callbacks and order recovery remain available')
    else:
        warnings.append('Development checks only; not a production readiness approval')
    import email_auth
    declared_mail = bool(env.get('LOTTERY_MAIL_CONFIG_FILE') or env.get('LOTTERY_SMTP_HOST'))
    if declared_mail:
        try:
            email_auth.mail_config(env)
        except (OSError, ValueError, TypeError, email_auth.EmailError):
            errors.append('Registration email configuration is incomplete or invalid')
        if production:
            for key in ('LOTTERY_MAIL_CONFIG_FILE', 'LOTTERY_SMTP_PASSWORD_FILE'):
                if env.get(key):
                    path = Path(env[key])
                    if not path.is_absolute() or path.resolve().is_relative_to(ROOT) or not path.is_file():
                        errors.append(key + ' must point to a private file outside the release directory')
    else:
        warnings.append('Email registration is unavailable until SMTP is configured; existing account login remains available')
    return {'version': RELEASE['version'], 'environment': 'production' if production else 'development', 'ok': not errors, 'errors': errors, 'warnings': warnings}


def health(database):
    try:
        with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=2) as connection:
            connection.execute('SELECT version FROM v6_schema LIMIT 1').fetchone()
        return {'status': 'ok', 'version': RELEASE['version'], 'channel': RELEASE['channel']}
    except sqlite3.Error:
        return {'status': 'unavailable', 'version': RELEASE['version'], 'channel': RELEASE['channel']}
