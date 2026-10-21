"""Portable V8 local launcher. Never inherits production data or merchant settings."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]


def local_environment(port, inherited=None, mail_config=None):
    environment = dict(os.environ if inherited is None else inherited)
    for key in list(environment):
        if key.startswith(('LOTTERY_', 'ALIPAY_')) or key == 'V6_SALES_ENABLED':
            environment.pop(key)
    folder = ROOT / 'data'
    environment.update(LOTTERY_ENV='development', LOTTERY_DB=str(folder / 'v8-local.sqlite'),
                       LOTTERY_BACKUP_DIR=str(folder / 'backups'), LOTTERY_PUBLIC_URL=f'http://127.0.0.1:{port}',
                       V6_SALES_ENABLED='0')
    if mail_config:
        path = Path(mail_config).expanduser().resolve()
        if not path.is_file() or path.is_relative_to(ROOT / 'static'):
            raise ValueError('Mail configuration must be a private file outside static/')
        environment['LOTTERY_MAIL_CONFIG_FILE'] = str(path)
    return environment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8908)
    parser.add_argument('--admin', action='store_true', help='Prompt for an initial local admin; never resets an existing admin')
    parser.add_argument('--check', action='store_true', help='Check dependencies and version without creating a database')
    parser.add_argument('--mail-config', help='Explicit private SMTP JSON file; inherited production mail settings are ignored')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    try:
        environment = local_environment(args.port, mail_config=args.mail_config)
    except ValueError as error:
        parser.error(str(error))
    for key in list(os.environ):
        if key not in environment:
            os.environ.pop(key)
    os.environ.update(environment)
    # db.py captures bootstrap settings at import time. Prepare everything first.
    if not args.check:
        prepare_local_data(args.admin)
    try:
        import uvicorn
        from v7_release import preflight
        import server  # Import only; the lifespan does not execute until serving.
    except ImportError as error:
        raise SystemExit(f'Missing dependency: {error.name}. Run: python -m pip install -r requirements.txt') from error
    report = preflight()
    if not report['ok']:
        raise SystemExit(json.dumps(report, ensure_ascii=False))
    if args.check:
        print(json.dumps({'version': report['version'], 'ok': True, 'sales_enabled': False, 'database_created': False}))
        return
    print(f'Choulema V8: http://127.0.0.1:{args.port}/login.html (local data only; online sales disabled)')
    uvicorn.run(server.app, host='127.0.0.1', port=args.port, access_log=False)


def prepare_local_data(admin=False):
    folder = ROOT / 'data'
    folder.mkdir(exist_ok=True)
    secret_path = folder / '.local-card-secret'
    try:
        with secret_path.open('x', encoding='utf-8') as stream:
            stream.write(secrets.token_urlsafe(48))
        secret_path.chmod(0o600)
    except FileExistsError:
        pass
    os.environ['LOTTERY_CARD_SECRET'] = secret_path.read_text(encoding='utf-8').strip()
    if admin:
        database = Path(os.environ['LOTTERY_DB'])
        exists = False
        if database.is_file():
            with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as connection:
                if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
                    exists = bool(connection.execute("SELECT 1 FROM users WHERE role='superadmin' LIMIT 1").fetchone())
        if exists:
            print('A local administrator already exists; its account and password are unchanged.')
        else:
            phone = input('Local administrator phone (11 digits): ').strip()
            if len(phone) != 11 or not phone.isascii() or not phone.isdigit():
                raise SystemExit('Invalid phone; no administrator created.')
            password = getpass.getpass('Local administrator password (at least 10 characters): ')
            confirmation = getpass.getpass('Repeat password: ')
            if len(password) < 10 or password != confirmation:
                raise SystemExit('Password mismatch or too short; no administrator created.')
            os.environ.update(LOTTERY_ADMIN_PHONE=phone, LOTTERY_ADMIN_ID='localadmin', LOTTERY_ADMIN_PASSWORD=password)


if __name__ == '__main__':
    main()
