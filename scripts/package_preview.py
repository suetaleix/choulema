"""Build/verify complete source or deployment bundles without runtime data or secrets."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'lottery-platform/'
ROOT_FILES = {'pytest.ini', 'README.md', '.gitignore', '.env.example', 'requirements.txt', 'requirements-dev.txt',
              'server.py', 'request_security.py', 'email_auth.py', 'v8_feedback.py', 'db.py', 'v6_api.py', 'v6_engine.py', 'v6_commerce.py', 'v6_payments.py',
              'v7_api.py', 'v7_referrals.py', 'v7_analytics.py', 'v7_entitlements.py', 'v7_operations.py',
              'v7_catalog.py', 'v7_release.py', 'release.json',
              'PLAN_v6_3D抽奖系统整体产品规划.md'}
TREES = {'static', 'tests', 'scripts', 'planning', 'deploy'}
EXCLUDED = {'__pycache__', '.pytest_cache', '.git', '.venv', 'artifacts', 'data', '_old'}
REQUIRED = {'server.py', 'request_security.py', 'email_auth.py', 'v8_feedback.py', 'static/v7/feedback.mjs', 'static/v7/feedback.css', 'static/v7/feedback-state.mjs', 'static/v7/admin-feedback.mjs', 'db.py', 'v7_api.py', 'v7_referrals.py', 'v7_analytics.py', 'v7_entitlements.py', 'v7_operations.py',
            'static/login.html', 'static/play.html', 'static/admin.html',
            'static/v7/auth.js', 'static/v7/email-verification.mjs', 'static/v7/admin.js', 'static/v7/game-shell.css',
            'static/v7/ui.js', 'static/v7/styles.css', 'static/v7/surfaces.css', 'static/v7/invite-poster.mjs',
            'static/v6/studio.js', 'static/v6/stage.js', 'planning/v7/MASTER_PLAN.md',
            'v7_catalog.py', 'v7_release.py', 'release.json', 'static/v7/content-catalog.json',
            'static/v7/content-catalog.mjs', 'static/v7/content-policy.mjs', 'static/v7/theme-stage.mjs',
            'static/v7/game-audio.mjs', 'static/v7/sound-catalog.mjs', 'static/v7/audio/manifest.json',
            'static/v7/stellar-stage.js', 'static/v7/stellar-profiles.mjs', 'static/v7/slot-audio-transport.mjs',
            'scripts/preflight.py', 'scripts/manage_db.py', 'deploy/README.md', 'deploy/lottery.service',
            'static/v7/aurora-wheel.mjs', 'static/v7/responsive.css', 'scripts/start_local.py',
            'scripts/start_v8.ps1', 'planning/v8/README.md', 'planning/v8/MASTER_PLAN.md',
            'planning/v8/ARCHITECTURE.md', 'planning/v8/DEVELOPMENT_PLAN.md',
            'planning/v8/ACCEPTANCE.md', 'planning/v8/DELIVERY.md'}


def git_checkout():
    try:
        top = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT,
                                      stderr=subprocess.DEVNULL, text=True).strip()
        return Path(top).resolve() == ROOT.resolve()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def package_paths():
    """Allowlisted tree scan used only for explicitly included files in unpacked sources."""
    result = {name for name in ROOT_FILES if (ROOT / name).is_file()}
    for tree in TREES:
        directory = ROOT / tree
        if directory.is_dir():
            result.update(path.relative_to(ROOT).as_posix() for path in directory.rglob('*')
                          if path.is_file() or path.is_symlink())
    return result


def sources(include_untracked=False):
    arguments = ['git', 'ls-files', '-z']
    if include_untracked:
        arguments += ['--cached', '--others', '--exclude-standard']
    if git_checkout():
        listed = subprocess.check_output(arguments, cwd=ROOT).decode('utf-8').split('\0')
    else:
        # An extracted ZIP must work without Git or the original author's checkout.
        manifest_path = ROOT / 'PACKAGE.json'
        if not manifest_path.is_file():
            raise ValueError('No project Git checkout or PACKAGE.json; cannot establish source provenance')
        listed = set(json.loads(manifest_path.read_text(encoding='utf-8'))['files'])
        if include_untracked:
            listed.update(package_paths())
    for name in sorted(set(filter(None, listed))):
        if PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or '\\' in name or ':' in name:
            raise ValueError('Unsafe source path: ' + name)
        relative = Path(name)
        path = ROOT / relative
        if any(part in EXCLUDED for part in relative.parts):
            continue
        if any(ROOT.joinpath(*relative.parts[:i]).is_symlink() for i in range(1, len(relative.parts) + 1)):
            raise ValueError(f'Symlink is not allowed: {relative}')
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError(f'Source escapes project root: {relative}')
        if not path.is_file():
            continue
        if relative.as_posix() not in ROOT_FILES and relative.parts[0] not in TREES:
            continue
        if path.suffix.lower() in {'.sqlite', '.sqlite3', '.db', '.pyc', '.pem', '.key', '.p12', '.pfx', '.log'} or (path.name.startswith('.env') and relative.as_posix() != '.env.example'):
            raise ValueError(f'Unexpected private/runtime file: {relative}')
        yield relative.as_posix(), path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def release_files(files):
    scripts = {'manage_db.py', 'preflight.py', 'package_preview.py', 'start_local.py', 'start_v8.ps1'}
    result = {name: data for name, data in files.items()
              if not name.startswith(('static/v7-preview/', 'tests/'))
              and name != 'static/design-preview.html'
              and (not name.startswith('scripts/') or Path(name).name in scripts)}
    # Every allowed sound and its four event layers must be delivered byte-for-byte.
    catalog = json.loads(result['static/v7/content-catalog.json'])
    manifest = json.loads(result['static/v7/audio/manifest.json'])
    for theme in catalog['themes'].values():
        for sound in theme['sounds']:
            preset = manifest['candidates'].get(sound)
            if not preset:
                raise ValueError('Missing approved sound: ' + sound)
            for asset in [preset['clip'], *preset['slotClips'].values()]:
                path = 'static' + asset['url']
                if path not in result or digest(result[path]) != asset['sha256']:
                    raise ValueError('Missing or changed audio asset: ' + path)
    return result


def build(destination, include_untracked=False, release=False):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('Output must be a new path')
    files = dict(sources(include_untracked))
    missing = sorted(REQUIRED - files.keys())
    if missing:
        raise ValueError('Required runtime/V8 documentation is missing; review sources or explicitly use --include-untracked: ' + ', '.join(missing))
    if release:
        files = release_files(files)
    else:
        files['data/.gitkeep'] = b''
    if git_checkout():
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT).strip())
        origin = 'git-working-tree'
    else:
        prior = json.loads((ROOT / 'PACKAGE.json').read_text(encoding='utf-8'))
        revision = prior.get('revision')
        dirty = None  # Never imply an extracted and possibly edited source tree is clean.
        origin = 'unpacked-bundle'
    manifest = {'format': 1, 'kind': 'deployment-bundle' if release else 'source-bundle', 'production_approved': False,
                'version': json.loads(files['release.json'])['version'],
                'source_origin': origin,
                'revision': revision, 'working_tree_modified': dirty, 'includes_untracked_sources': include_untracked,
                'files': {name: {'sha256': digest(data), 'bytes': len(data)} for name, data in sorted(files.items())}}
    files['PACKAGE.json'] = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(PREFIX + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    verify(destination)
    return {'path': str(destination), 'sha256': digest(destination.read_bytes()), 'files': len(files), 'revision': revision, 'working_tree_modified': dirty}


def verify(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive member')
        for name in names:
            pure = PurePosixPath(name)
            if not name.startswith(PREFIX) or '..' in pure.parts or pure.is_absolute() or '\\' in name or ':' in name:
                raise ValueError('Unsafe archive member')
        manifest = json.loads(archive.read(PREFIX + 'PACKAGE.json'))
        expected = {PREFIX + n for n in manifest['files']} | {PREFIX + 'PACKAGE.json'}
        if expected != set(names):
            raise ValueError('Archive and manifest differ')
        for name, record in manifest['files'].items():
            data = archive.read(PREFIX + name)
            if len(data) != record['bytes'] or digest(data) != record['sha256']:
                raise ValueError(f'Checksum mismatch: {name}')
    return {'verified': True, 'files': len(names)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output')
    group.add_argument('--verify')
    parser.add_argument('--release', action='store_true', help='Package runtime sources and approved audio, excluding preview content and test data')
    parser.add_argument('--include-untracked', action='store_true', help='Explicitly include non-ignored new sources within the same allowlisted source paths')
    args = parser.parse_args()
    if args.verify and args.include_untracked:
        parser.error('--include-untracked is only valid with --output')
    print(json.dumps(build(args.output, args.include_untracked, args.release) if args.output else verify(args.verify), ensure_ascii=False, indent=2))
