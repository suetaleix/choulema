#!/usr/bin/env python3
"""Download and decrypt an offsite backup in a temporary, private directory."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("choulema_backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def main():
    records = [r for r in backup.local_records() if r.get("verified")]
    if not records:
        raise RuntimeError("No verified backup available")
    record = max(records, key=lambda r: r["created_at"])
    with tempfile.TemporaryDirectory(prefix="restore-check-", dir=backup.BASE) as directory:
        directory = Path(directory)
        encrypted = directory / record["archive"]
        identity = directory / "restore-key.txt"
        backup.rc("copyto", backup.REMOTE + record["archive"], str(encrypted))
        backup.rc("copyto", backup.REMOTE + "choulema-restore-key-20261003.txt", str(identity))
        identity.chmod(0o600)
        if backup.sha256(encrypted) != record["sha256"]:
            raise RuntimeError("Downloaded backup checksum mismatch")
        plaintext = directory / "restore.tar.gz"
        backup.run(["/usr/bin/age", "-d", "-i", str(identity), "-o", str(plaintext), str(encrypted)], timeout=300)
        restored = directory / "restored"
        restored.mkdir(mode=0o700)
        with tarfile.open(plaintext, "r:gz") as archive:
            seen = set()
            for member in archive.getmembers():
                name = Path(member.name)
                if name.is_absolute() or ".." in name.parts or member.name in seen or not member.isfile():
                    raise RuntimeError("Archive contains unsafe or duplicate members")
                seen.add(member.name)
            archive.extractall(restored, filter="data")
        manifest = json.loads((restored / "manifest.json").read_text(encoding="utf-8"))
        expected = manifest["files"]
        if seen != set(expected) | {"manifest.json"}:
            raise RuntimeError("Archive file inventory does not match manifest")
        for filename, evidence in expected.items():
            if backup.sha256(restored / filename) != evidence["sha256"]:
                raise RuntimeError("Restored file checksum mismatch")
        connection = sqlite3.connect((restored / "data/lottery.sqlite").as_uri() + "?mode=ro", uri=True)
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            table_count = connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        finally:
            connection.close()
        if integrity != "ok" or not table_count:
            raise RuntimeError("Restored database validation failed")
        if not (restored / "config/choulema/production.env").is_file():
            raise RuntimeError("Application configuration missing from backup")
        if not list((restored / "config/choulema-keys").glob("*private.pem")):
            raise RuntimeError("Payment private key missing from encrypted backup")
        report = {"job": backup.JOB, "archive": record["archive"], "verified_at": backup.now().isoformat(),
                  "download_sha256_match": True, "decryption_key_source": "NAS backup directory",
                  "decryption_success": True, "verified_files": len(expected),
                  "database_integrity": integrity, "database_tables": table_count,
                  "production_database_modified": False}
    backup.save_json(backup.STATE / "restore-verification.json", report)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
