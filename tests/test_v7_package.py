"""A development preview must not silently omit new V7 entry modules."""
import pytest

from scripts import package_preview as package


def test_missing_untracked_entrypoint_stops_before_creating_archive(tmp_path, monkeypatch):
    monkeypatch.setattr(package, 'sources', lambda include: iter([('server.py', b'# server')]))
    output = tmp_path / 'incomplete.zip'
    with pytest.raises(ValueError, match='v7_api.py'):
        package.build(output)
    assert not output.exists()


def test_explicit_new_sources_are_included_but_runtime_paths_are_excluded(tmp_path, monkeypatch):
    monkeypatch.setattr(package, 'ROOT', tmp_path)
    monkeypatch.setattr(package, 'git_checkout', lambda: True)
    listed = ['server.py', 'v7_api.py', 'static/play.html', 'artifacts/test-accounts.json', '.env', 'data/private.sqlite']
    for name in listed:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name, encoding='utf-8')
    calls = []
    def git(arguments, **_):
        calls.append(arguments)
        return ('\0'.join(listed) + '\0').encode()
    monkeypatch.setattr(package.subprocess, 'check_output', git)
    assert set(dict(package.sources(True))) == {'server.py', 'v7_api.py', 'static/play.html'}
    assert '--others' in calls[0] and '--exclude-standard' in calls[0]


@pytest.mark.parametrize('private_name', ['static/.env.local', 'scripts/merchant.key', 'tests/private.sqlite3'])
def test_secret_shaped_files_in_source_directories_are_rejected(tmp_path, monkeypatch, private_name):
    monkeypatch.setattr(package, 'ROOT', tmp_path)
    monkeypatch.setattr(package, 'git_checkout', lambda: True)
    path = tmp_path / private_name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('private fixture', encoding='utf-8')
    monkeypatch.setattr(package.subprocess, 'check_output', lambda *args, **kwargs: private_name.encode() + b'\0')
    with pytest.raises(ValueError, match='private/runtime'):
        list(package.sources(True))
