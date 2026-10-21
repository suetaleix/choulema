"""Offline upgrade and non-destructive SQLite backup/restore helpers."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def backup(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file():
        raise ValueError("Source database does not exist")
    if destination.exists() or source == destination:
        raise ValueError("Destination must be a new file; existing data is never overwritten")
    destination.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Backup integrity check failed")
    finally:
        dst.close()
        src.close()
    return {"path": str(destination), "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def _quoted(name):
    return '"' + name.replace('"', '""') + '"'


def _fingerprint(c, table, columns, max_rowid):
    names = ','.join(_quoted(name) for name in columns)
    digest = hashlib.sha256()
    count = 0
    query = f'SELECT rowid,{names} FROM {_quoted(table)} WHERE rowid<=? ORDER BY rowid'
    for row in c.execute(query, (max_rowid,)):
        data = repr(tuple(row)).encode('utf-8')
        digest.update(len(data).to_bytes(8, 'big'))
        digest.update(data)
        count += 1
    return count, digest.hexdigest()


def _baseline(c):
    """Capture original columns and rows, ignoring newly added migration rows."""
    baseline = {}
    names = [row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for table in names:
        if table == 'v6_schema':
            continue  # schema version is expected to advance
        columns = [row[1] for row in c.execute(f'PRAGMA table_info({_quoted(table)})')]
        max_rowid = c.execute(f'SELECT MAX(rowid) FROM {_quoted(table)}').fetchone()[0]
        baseline[table] = {'columns': columns, 'max_rowid': max_rowid or 0,
                           'fingerprint': _fingerprint(c, table, columns, max_rowid or 0)}
    return baseline


def _verify_original_rows(c, baseline):
    for table, record in baseline.items():
        present = {row[1] for row in c.execute(f'PRAGMA table_info({_quoted(table)})')}
        if not set(record['columns']) <= present:
            raise ValueError(f'Migration removed original columns from {table}')
        current = _fingerprint(c, table, record['columns'], record['max_rowid'])
        if current != record['fingerprint']:
            raise ValueError(f'Migration changed original rows in {table}')
    return len(baseline)


def migrate(source, snapshot):
    evidence = backup(source, snapshot)
    with sqlite3.connect(snapshot) as original:
        baseline = _baseline(original)
    import db
    import v6_engine
    import v6_payments
    import v7_referrals
    import v7_entitlements
    previous = db.DB_PATH
    try:
        db.DB_PATH = str(Path(source).resolve())
        db.init_db()
        v6_engine.init_schema()
        v6_payments.init_schema()
        v7_referrals.init_schema()
        v7_entitlements.init_schema()
        import v7_operations
        v7_operations.init_schema()
        with db.conn() as c:
            if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Upgraded database integrity check failed")
            preserved = _verify_original_rows(c, baseline)
    finally:
        db.DB_PATH = previous
    return {"backup": evidence, "upgraded": str(Path(source).resolve()),
            "preserved_original_tables": preserved}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stop the application before migrate. Restore always writes a new file.")
    parser.add_argument("action", choices=["backup", "migrate", "restore"])
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True, help="New backup file; for restore, new restored database path")
    args = parser.parse_args()
    result = migrate(args.database, args.output) if args.action == "migrate" else backup(args.database, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))
