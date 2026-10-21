import importlib.util
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("choulema_backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def record(day, verified=True):
    stamp = datetime.fromisoformat(day).replace(tzinfo=backup.TZ)
    return {"job": backup.JOB, "archive": f"choulema-full-{stamp:%Y%m%d-%H%M%S}-abcdef12.tar.gz.age",
            "created_at": stamp.isoformat(), "sha256": "a" * 64, "bytes": 100, "verified": verified}


class BackupTests(unittest.TestCase):
    def test_retention_calendar_boundaries_and_future_protection(self):
        current = datetime(2026, 10, 3, tzinfo=backup.TZ)
        records = [record(day) for day in ["2026-10-03", "2026-09-04", "2026-09-03", "2026-09-01", "2025-11-01", "2025-10-31", "2027-01-01"]]
        keep = backup.keep_archives(records, current)
        self.assertIn(records[0]["archive"], keep)
        self.assertIn(records[1]["archive"], keep)
        self.assertNotIn(records[2]["archive"], keep)
        self.assertIn(records[3]["archive"], keep)
        self.assertIn(records[4]["archive"], keep)
        self.assertNotIn(records[5]["archive"], keep)
        self.assertIn(records[6]["archive"], keep)

    def test_never_delete_only_copy_even_if_old(self):
        old = record("2024-01-01")
        self.assertEqual(backup.keep_archives([old], datetime(2026, 10, 3, tzinfo=backup.TZ)), {old["archive"]})

    def test_record_rejects_wrong_job_traversal_date_and_hash(self):
        valid = record("2026-10-03")
        self.assertTrue(backup.record_is_valid(valid))
        for changes in [{"job": "other"}, {"archive": "../important.txt"}, {"created_at": "2025-10-03T00:00:00+08:00"}, {"sha256": "bad"}]:
            self.assertFalse(backup.record_is_valid(dict(valid, **changes)))

    def test_live_wal_snapshot_contains_committed_rows_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "live.sqlite"
            target = Path(directory) / "snapshot.sqlite"
            with closing(sqlite3.connect(source)) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE entries (value TEXT)")
                connection.execute("INSERT INTO entries VALUES ('committed')")
                connection.commit()
                backup.snapshot_database(source, target)
                self.assertEqual(connection.execute("SELECT * FROM entries").fetchall(), [("committed",)])
            with closing(sqlite3.connect(target)) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(connection.execute("SELECT * FROM entries").fetchall(), [("committed",)])
            with self.assertRaises(RuntimeError):
                backup.snapshot_database(source, target)


if __name__ == "__main__":
    unittest.main()
