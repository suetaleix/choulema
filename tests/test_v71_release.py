import copy
import json
import sqlite3
import tempfile
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

import db
import server
import v7_catalog
import v7_release as release
from scripts import manage_db, package_preview


def production_env(tmp_path):
    tmp_path = Path(tempfile.gettempdir()) / ('choulema-check-' + uuid.uuid4().hex)
    return {'LOTTERY_ENV': 'production', 'LOTTERY_DB': str(tmp_path / 'live.sqlite'),
            'LOTTERY_BACKUP_DIR': str(tmp_path / 'backups'), 'LOTTERY_PUBLIC_URL': 'https://lottery.example.org',
            'LOTTERY_CARD_SECRET': 'abcdefgh12345678ABCDEFGHIJKLMNOP87654321', 'V6_SALES_ENABLED': '0',
            'LOTTERY_ADMIN_PHONE': '13500008801', 'LOTTERY_ADMIN_PASSWORD': 'a-strong-test-password'}


def test_preflight_rejects_private_paths_and_incomplete_production_config_without_writing(tmp_path):
    env = production_env(tmp_path)
    assert release.preflight(env)['ok']
    assert not Path(env['LOTTERY_DB']).exists()
    for patch in ({'LOTTERY_DB': 'data/live.sqlite'}, {'LOTTERY_DB': str(release.ROOT / 'data/live.sqlite')},
                  {'LOTTERY_PUBLIC_URL': 'http://lottery.example.org'}, {'LOTTERY_PUBLIC_URL': 'https://replace.example'},
                  {'LOTTERY_BACKUP_DIR': ''}, {'LOTTERY_CARD_SECRET': 'x' * 32}, {'LOTTERY_ADMIN_PASSWORD': ''},
                  {'ALIPAY_PRIVATE_KEY_FILE': 'merchant.key'}, {'V6_SALES_ENABLED': '1'}):
        assert not release.preflight({**env, **patch})['ok']
    assert not Path(env['LOTTERY_DB']).exists()


def test_initial_admin_password_minimum_is_ten_characters(tmp_path):
    env = production_env(tmp_path)
    assert release.preflight({**env, 'LOTTERY_ADMIN_PASSWORD': 'Testpass9!'})['ok']
    report = release.preflight({**env, 'LOTTERY_ADMIN_PASSWORD': 'Testpas9!'})
    assert not report['ok']
    assert 'Initial administrator password must contain at least 10 characters' in report['errors']


def test_health_is_readonly_and_does_not_disclose_runtime_paths(tmp_path):
    nonexistent = tmp_path / 'not-created.sqlite'
    assert release.health(nonexistent)['status'] == 'unavailable'
    assert not nonexistent.exists()
    with TestClient(server.app) as client:
        with db.conn() as c:
            before = c.execute('SELECT COUNT(*) FROM guests').fetchone()[0]
        response = client.get('/healthz')
        assert response.status_code == 200
        assert response.json()['version'] == release.RELEASE['version'] == v7_catalog.CONTENT['version']
        assert 'set-cookie' not in response.headers
        assert set(response.json()) == {'status', 'version', 'channel'}
        with db.conn() as c:
            assert c.execute('SELECT COUNT(*) FROM guests').fetchone()[0] == before


def test_free_launch_contract_and_product_compatibility_cannot_be_silently_changed():
    data = copy.deepcopy(v7_catalog.CONTENT)
    data['machines']['capsule']['feature'] = 'pro'
    with pytest.raises(ValueError, match='remain free'):
        v7_catalog.validate_catalog(data)
    data = copy.deepcopy(v7_catalog.CONTENT)
    data['products']['cosmic']['machines'] = ['sphere']
    with pytest.raises(ValueError, match='compatibility mismatch'):
        v7_catalog.validate_catalog(data)


def test_release_filter_keeps_approved_audio_and_rejects_missing_or_changed_files():
    root = package_preview.ROOT
    files = {p.relative_to(root).as_posix(): p.read_bytes() for p in (root / 'static/v7/audio').iterdir() if p.is_file()}
    files['static/v7/content-catalog.json'] = (root / 'static/v7/content-catalog.json').read_bytes()
    files.update({'static/v7-preview/old.mp3': b'old', 'tests/test_example.py': b'test', 'scripts/build_game_audio.py': b'build', 'scripts/preflight.py': b'check'})
    result = package_preview.release_files(files)
    assert 'scripts/preflight.py' in result
    assert not any(n.startswith(('static/v7-preview/', 'tests/')) for n in result)
    assert 'scripts/build_game_audio.py' not in result
    path = 'static/v7/audio/slot-default1-v3-start.mp3'
    with pytest.raises(ValueError, match='changed audio'):
        package_preview.release_files({**files, path: b'changed'})
    del files[path]
    with pytest.raises(ValueError, match='Missing or changed'):
        package_preview.release_files(files)


def test_upgrade_and_restore_preserve_existing_prices_and_records(tmp_path):
    db.set_setting('v6_price_cosmic', '1688')
    before = db.DB_PATH
    upgraded = tmp_path / 'upgrade.sqlite'
    backup = tmp_path / 'before-upgrade.sqlite'
    manage_db.backup(before, upgraded)
    result = manage_db.migrate(upgraded, backup)
    assert result['preserved_original_tables']
    assert db.DB_PATH == before
    restored = tmp_path / 'restored.sqlite'
    manage_db.backup(backup, restored)
    with sqlite3.connect(upgraded) as c:
        assert c.execute("SELECT v FROM settings WHERE k='v6_price_cosmic'").fetchone()[0] == '1688'
    with pytest.raises(ValueError):
        manage_db.backup(backup, restored)
