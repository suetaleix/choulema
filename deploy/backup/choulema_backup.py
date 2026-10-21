#!/usr/bin/env python3
"""Daily, encrypted, verified Choulema backups. No business writes or mirror sync."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid

TZ = timezone(timedelta(hours=8))
JOB = "choulema-fnos-offsite-v1"
BASE = Path("/var/backups/choulema-offsite")
STATE = Path("/var/lib/choulema-backup")
SETTINGS = Path("/etc/choulema-backup")
REMOTE = "choulema_fnos_backup:"
RCLONE_CONFIG = Path("/root/.config/rclone/rclone.conf")
NAME_RE = re.compile(r"choulema-full-(\d{8})-(\d{6})-([a-f0-9]{8})\.tar\.gz\.age")
EXCLUDED = {".venv", "venv", "node_modules", ".git", "__pycache__", ".pytest_cache", ".mypy_cache", "artifacts"}


def now():
    return datetime.now(TZ)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_json(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)


def run(arguments, **kwargs):
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        # Subprocess output can include private configuration; keep failure logs concise.
        raise RuntimeError(f"{Path(arguments[0]).name} failed (exit {result.returncode})")
    return result.stdout


def rc(*arguments, timeout=900):
    return run(["/usr/bin/rclone", "--config", str(RCLONE_CONFIG),
                "--retries", "3", "--retries-sleep", "15s", "--low-level-retries", "3",
                "--contimeout", "15s", "--timeout", "2m", "--transfers", "1",
                "--checkers", "2", "--bwlimit", "4M", *arguments], timeout=timeout)


def record_is_valid(record, expected_name=None):
    if not isinstance(record, dict) or record.get("job") != JOB:
        return False
    name = record.get("archive", "")
    match = NAME_RE.fullmatch(name)
    if not match or (expected_name and name != expected_name):
        return False
    try:
        stamp = datetime.fromisoformat(record["created_at"])
        if stamp.tzinfo is None or stamp.astimezone(TZ).strftime("%Y%m%d-%H%M%S") != "-".join(match.group(1, 2)):
            return False
        return bool(re.fullmatch(r"[a-f0-9]{64}", record["sha256"])) and int(record["bytes"]) > 0
    except (ValueError, KeyError, TypeError):
        return False


def keep_archives(records, current):
    """Keep 30 calendar days, first successful snapshot of each of 12 months, latest."""
    cutoff = current.astimezone(TZ).date() - timedelta(days=29)
    month_index = current.year * 12 + current.month - 1
    valid = [r for r in records if record_is_valid(r) and r.get("verified")]
    keep = set()
    monthly = {}
    for record in valid:
        stamp = datetime.fromisoformat(record["created_at"]).astimezone(TZ)
        if stamp.date() >= cutoff:
            keep.add(record["archive"])
        index = stamp.year * 12 + stamp.month - 1
        if month_index - 11 <= index <= month_index:
            existing = monthly.get(index)
            if existing is None or record["created_at"] < existing["created_at"]:
                monthly[index] = record
    keep.update(r["archive"] for r in monthly.values())
    if valid:
        keep.add(max(valid, key=lambda r: r["created_at"])["archive"])
    return keep


def local_records():
    result = []
    for path in BASE.glob("choulema-full-*.tar.gz.age.record.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            raise RuntimeError("Local backup record is unreadable; refusing cleanup")
        expected = path.name.removesuffix(".record.json")
        if not record_is_valid(record, expected):
            raise RuntimeError("Local backup record is invalid; refusing cleanup")
        result.append(record)
    return result


def snapshot_database(source, destination):
    if destination.exists():
        raise RuntimeError("Snapshot output already exists")
    source_connection = sqlite3.connect(Path(source).resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    destination_connection = sqlite3.connect(destination)
    try:
        source_connection.backup(destination_connection, pages=128, sleep=0.02)
        if destination_connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite snapshot integrity check failed")
    finally:
        destination_connection.close()
        source_connection.close()


def create_backup():
    release = Path("/opt/choulema/current").resolve(strict=True)
    if not release.is_relative_to(Path("/opt/choulema/releases")):
        raise RuntimeError("Unexpected release path")
    database = Path("/var/lib/choulema/lottery.sqlite")
    stamp = now()
    name = f"choulema-full-{stamp:%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.tar.gz.age"
    encrypted = BASE / name
    with tempfile.TemporaryDirectory(prefix="build-", dir=BASE) as temporary:
        temporary = Path(temporary)
        database_copy = temporary / "lottery.sqlite"
        snapshot_database(database, database_copy)
        manifest = {"job": JOB, "created_at": stamp.isoformat(), "release": str(release),
                    "database_integrity": "ok", "files": {}}
        plaintext = temporary / "backup.tar.gz"
        with tarfile.open(plaintext, "w:gz", compresslevel=6) as archive:
            def add_file(source, destination):
                source = Path(source)
                if source.is_symlink():
                    raise RuntimeError("Unexpected symlink in backup source")
                if not source.is_file():
                    raise RuntimeError("Required backup source is missing")
                digest = sha256(source)
                archive.add(source, arcname=destination, recursive=False)
                # Config/deploy changes concurrent with a backup must not pass silently.
                if digest != sha256(source):
                    raise RuntimeError("Backup source changed during capture")
                manifest["files"][destination] = {"sha256": digest, "bytes": source.stat().st_size}

            def add_tree(source, destination, exclude_state=False):
                source = Path(source)
                for directory, dirs, files in os.walk(source, followlinks=False):
                    dirs[:] = sorted(d for d in dirs if d not in EXCLUDED and
                                     not (exclude_state and d.startswith("release-validation-")))
                    for directory_name in dirs:
                        if (Path(directory) / directory_name).is_symlink():
                            raise RuntimeError("Unexpected directory symlink")
                    for filename in sorted(files):
                        if exclude_state and filename in {"lottery.sqlite", "lottery.sqlite-wal", "lottery.sqlite-shm", "lottery.sqlite-journal"}:
                            continue
                        file = Path(directory) / filename
                        add_file(file, f"{destination}/{file.relative_to(source).as_posix()}")

            add_tree(release, "application")
            add_file(database_copy, "data/lottery.sqlite")
            add_tree(database.parent, "data", exclude_state=True)
            add_tree("/etc/choulema", "config/choulema")
            add_tree("/etc/choulema-keys", "config/choulema-keys")
            add_file("/etc/systemd/system/choulema.service", "config/systemd/choulema.service")
            overrides = Path("/etc/systemd/system/choulema.service.d")
            if overrides.exists():
                add_tree(overrides, "config/systemd/choulema.service.d")
            add_file(__file__, "maintenance/choulema_backup.py")
            add_file(RCLONE_CONFIG, "maintenance/rclone.conf")
            for unit in ("choulema-backup.service", "choulema-backup.timer"):
                add_file(Path("/etc/systemd/system") / unit, "maintenance/" + unit)
            add_file(SETTINGS / "recipients.txt", "maintenance/recipients.txt")
            manifest_path = temporary / "manifest.json"
            save_json(manifest_path, manifest)
            archive.add(manifest_path, arcname="manifest.json", recursive=False)
        run(["/usr/bin/age", "-R", str(SETTINGS / "recipients.txt"), "-o", str(encrypted) + ".partial", str(plaintext)], timeout=300)
        Path(str(encrypted) + ".partial").replace(encrypted)
    record = {"job": JOB, "archive": name, "created_at": stamp.isoformat(),
              "sha256": sha256(encrypted), "bytes": encrypted.stat().st_size,
              "files": len(manifest["files"]), "database_integrity": "ok", "verified": False}
    save_json(BASE / (name + ".record.json"), record)
    return record


def upload_and_verify(record):
    archive = BASE / record["archive"]
    if not archive.is_file() or sha256(archive) != record["sha256"]:
        raise RuntimeError("Local encrypted archive failed checksum validation")
    rc("copyto", str(archive), REMOTE + archive.name, "--ignore-times")
    with tempfile.TemporaryDirectory(prefix="verify-", dir=BASE) as temporary:
        downloaded = Path(temporary) / archive.name
        rc("copyto", REMOTE + archive.name, str(downloaded))
        if sha256(downloaded) != record["sha256"]:
            raise RuntimeError("Remote download checksum mismatch")
    completed = dict(record, verified=True, verified_at=now().isoformat())
    marker = BASE / (archive.name + ".complete.json")
    save_json(marker, completed)
    rc("copyto", str(marker), REMOTE + marker.name, "--ignore-times")
    remote_marker = json.loads(rc("cat", REMOTE + marker.name, timeout=90))
    if remote_marker != completed:
        raise RuntimeError("Remote completion record verification failed")
    save_json(BASE / (archive.name + ".record.json"), completed)
    print(json.dumps({"event": "backup_verified", "archive": archive.name,
                      "bytes": completed["bytes"], "files": completed["files"]}), flush=True)
    return completed


def cleanup():
    listing = json.loads(rc("lsjson", REMOTE, "--files-only", timeout=180))
    remote_records = []
    for entry in listing:
        name = entry.get("Name", "")
        if not name.endswith(".complete.json") or not NAME_RE.fullmatch(name.removesuffix(".complete.json")):
            continue
        record = json.loads(rc("cat", REMOTE + name, timeout=90))
        if not record_is_valid(record, name.removesuffix(".complete.json")) or not record.get("verified"):
            raise RuntimeError("Remote backup record invalid; refusing cleanup")
        remote_records.append(record)
    keep = keep_archives(remote_records, now())
    deleted = 0
    for record in remote_records:
        if record["archive"] not in keep:
            # Only explicit, validated names belonging to this task can be removed.
            rc("deletefile", REMOTE + record["archive"], timeout=180)
            rc("deletefile", REMOTE + record["archive"] + ".complete.json", timeout=90)
            deleted += 1
    local_cutoff = now().date() - timedelta(days=6)
    remote_names = {r["archive"] for r in remote_records}
    for record in local_records():
        if record.get("verified") and datetime.fromisoformat(record["created_at"]).date() < local_cutoff and record["archive"] in remote_names:
            for suffix in ("", ".record.json", ".complete.json"):
                (BASE / (record["archive"] + suffix)).unlink(missing_ok=True)
    return deleted


def main(force=False):
    import fcntl
    os.umask(0o077)
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    Path("/run/choulema-backup").mkdir(mode=0o700, exist_ok=True)
    lock = open("/run/choulema-backup/lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('{"event":"already_running"}')
        return
    status_path = STATE / "status.json"
    status = json.loads(status_path.read_text()) if status_path.exists() else {"job": JOB}
    status.update(state="running", last_attempt=now().isoformat())
    save_json(status_path, status)
    try:
        if shutil.disk_usage(BASE).free < 512 * 1024 * 1024:
            raise RuntimeError("Insufficient free disk space for safe backup")
        records = local_records()
        for record in records:
            if not record.get("verified"):
                upload_and_verify(record)
        records = local_records()
        today_done = any(r.get("verified") and datetime.fromisoformat(r["created_at"]).date() == now().date() for r in records)
        if force or not today_done:
            upload_and_verify(create_backup())
        latest = max((r for r in local_records() if r.get("verified")), key=lambda r: r["created_at"])
        status.update(state="success", last_success=latest["verified_at"], archive=latest["archive"], bytes=latest["bytes"], last_error=None)
        # Preserve verified success even if a separate retention operation later fails.
        save_json(status_path, status)
        status["expired_remote_archives_removed"] = cleanup()
        status["last_completed"] = now().isoformat()
        save_json(status_path, status)
        print(json.dumps(status), flush=True)
    except Exception as error:
        status.update(state="failed", last_error=str(error) if isinstance(error, RuntimeError) else type(error).__name__, failed_at=now().isoformat())
        save_json(status_path, status)
        print(json.dumps(status), flush=True)
        raise SystemExit(1)
    finally:
        lock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Create another snapshot even if today's backup succeeded")
    args = parser.parse_args()
    main(args.force)
