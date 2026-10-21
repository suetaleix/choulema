"""Portable delivery must preserve provenance and isolate local startup from production."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import zipfile

import pytest

from scripts import package_preview as package
from scripts import start_local as launcher

PROJECT = Path(__file__).resolve().parents[1]


def unpacked_source(tmp_path, monkeypatch):
    (tmp_path / 'release.json').write_text('{"version":"8.0.0"}', encoding='utf-8')
    (tmp_path / 'server.py').write_text('# example source', encoding='utf-8')
    (tmp_path / 'PACKAGE.json').write_text(json.dumps({
        'revision': 'prior-revision', 'files': {'release.json': {}, 'server.py': {}}
    }), encoding='utf-8')
    monkeypatch.setattr(package, 'ROOT', tmp_path)
    monkeypatch.setattr(package, 'git_checkout', lambda: False)
    monkeypatch.setattr(package, 'REQUIRED', {'server.py', 'release.json'})


def test_extracted_source_repackages_without_git_and_detects_tampering(tmp_path, monkeypatch):
    unpacked_source(tmp_path, monkeypatch)
    (tmp_path / 'static').mkdir()
    (tmp_path / 'static' / 'new.js').write_text('// newly authored', encoding='utf-8')
    (tmp_path / 'data').mkdir()
    (tmp_path / 'data' / 'private.sqlite').write_bytes(b'private runtime')
    assert 'static/new.js' not in dict(package.sources())
    output = tmp_path / 'delivery.zip'
    package.build(output, include_untracked=True)
    assert package.verify(output)['verified']
    with zipfile.ZipFile(output) as archive:
        manifest = json.loads(archive.read('lottery-platform/PACKAGE.json'))
        assert manifest['source_origin'] == 'unpacked-bundle'
        assert manifest['revision'] == 'prior-revision'
        assert manifest['working_tree_modified'] is None
        assert 'static/new.js' in manifest['files']
        assert 'data/private.sqlite' not in manifest['files']
        members = {name: archive.read(name) for name in archive.namelist()}
    with pytest.raises(ValueError, match='new path'):
        package.build(output, True)
    members['lottery-platform/server.py'] = b'changed after packaging'
    tampered = tmp_path / 'tampered.zip'
    with zipfile.ZipFile(tampered, 'w') as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    with pytest.raises(ValueError, match='Checksum mismatch'):
        package.verify(tampered)


@pytest.mark.parametrize('unsafe', ['../secret.txt', 'static/../../secret.txt', 'C:/secret.txt', 'static\\secret.txt'])
def test_extracted_manifest_cannot_escape_root(tmp_path, monkeypatch, unsafe):
    unpacked_source(tmp_path, monkeypatch)
    (tmp_path / 'PACKAGE.json').write_text(json.dumps({'files': {unsafe: {}}}), encoding='utf-8')
    with pytest.raises(ValueError, match='Unsafe source'):
        list(package.sources())


def test_symlinked_parent_cannot_package_external_files(tmp_path, monkeypatch):
    unpacked_source(tmp_path, monkeypatch)
    outside = tmp_path.parent / (tmp_path.name + '-outside')
    outside.mkdir()
    (outside / 'secret.txt').write_text('outside project', encoding='utf-8')
    try:
        (tmp_path / 'static').symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('OS does not permit symbolic links')
    (tmp_path / 'PACKAGE.json').write_text(json.dumps({'files': {'static/secret.txt': {}}}), encoding='utf-8')
    with pytest.raises(ValueError, match='Symlink'):
        list(package.sources())


def test_local_environment_drops_production_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    env = launcher.local_environment(8908, {
        'PATH': 'preserved', 'LOTTERY_ENV': 'production', 'LOTTERY_DB': '/live/users.sqlite',
        'LOTTERY_CARD_SECRET': 'live-secret', 'LOTTERY_ADMIN_PASSWORD': 'live-password',
        'ALIPAY_PRIVATE_KEY_FILE': '/live/key.pem', 'ALIPAY_APP_ID': 'live-merchant', 'V6_SALES_ENABLED': '1',
    })
    assert env['PATH'] == 'preserved'
    assert env['LOTTERY_ENV'] == 'development'
    assert Path(env['LOTTERY_DB']) == tmp_path / 'data/v8-local.sqlite'
    assert env['V6_SALES_ENABLED'] == '0'
    assert not any(key.startswith('ALIPAY_') for key in env)
    assert 'LOTTERY_CARD_SECRET' not in env and 'LOTTERY_ADMIN_PASSWORD' not in env


def run_launcher(tmp_path, body):
    code = "from pathlib import Path\nfrom scripts import start_local as app\nimport sys, os\nsys.path.insert(0, str(app.ROOT))\napp.ROOT = Path(sys.argv[1])\n" + body
    result = subprocess.run([sys.executable, '-c', code, str(tmp_path)], cwd=PROJECT,
                            text=True, capture_output=True, timeout=40)
    assert result.returncode == 0, result.stderr + result.stdout
    return result


def test_check_does_not_create_local_database(tmp_path):
    result = run_launcher(tmp_path, "sys.argv = ['start_local', '--check']\napp.main()\n")
    assert json.loads(result.stdout)['version'] == '8.0.0'
    assert not (tmp_path / 'data').exists()


def test_admin_bootstrap_precedes_import_and_rerun_preserves_credentials(tmp_path):
    body = """
import builtins, uvicorn
builtins.input = lambda _: '19900000808'
app.getpass.getpass = lambda _: 'LocalOnlyTest808!'
def startup(*args, **kwargs):
    import db
    db.init_db()
    assert kwargs['host'] == '127.0.0.1'
uvicorn.run = startup
sys.argv = ['start_local', '--admin']
app.main()
"""
    run_launcher(tmp_path, body)
    database = tmp_path / 'data/v8-local.sqlite'
    with sqlite3.connect(database) as connection:
        first = connection.execute("SELECT phone,custom_id,password_hash FROM users WHERE role='superadmin'").fetchone()
    assert first[:2] == ('19900000808', 'localadmin')
    secret = (tmp_path / 'data/.local-card-secret').read_bytes()
    run_launcher(tmp_path, body.replace("'LocalOnlyTest808!'", "'DifferentTest808!'"))
    with sqlite3.connect(database) as connection:
        second = connection.execute("SELECT phone,custom_id,password_hash FROM users WHERE role='superadmin'").fetchone()
    assert second == first
    assert (tmp_path / 'data/.local-card-secret').read_bytes() == secret
