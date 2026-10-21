"""Offline migration keeps prior account, order, and entitlement rows intact."""
import json
import sqlite3

import pytest

import db
from scripts import manage_db


def test_migrate_preserves_old_rows_and_adds_new_columns(tmp_path):
    assert db.create_user("10000000771", "migrate771", "test-password")[0]
    uid = db.authenticate("10000000771", "test-password")["id"]
    with db.conn() as c:
        c.execute("INSERT INTO memberships(subject_type,subject_id,plan,expires_at,created_at) VALUES(?,?,?,?,?)",
                  ("user", uid, "year", "2027-09-27T00:00:00", "2026-09-27T00:00:00"))
        c.execute("""INSERT INTO orders(order_no,subject_type,subject_id,amount,status,created_at)
            VALUES(?,?,?,?,?,?)""", ("OLD-ORDER", "user", uid, 9900, "paid", "2026-09-27T00:00:00"))
        c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)",
                  (f"user:{uid}", "pro", 1821984000, "OLD-ORDER"))
        c.execute("DROP TABLE v6_orders")
        c.execute("""CREATE TABLE v6_orders(order_no TEXT PRIMARY KEY, owner TEXT NOT NULL,
            request_id TEXT NOT NULL, snapshot TEXT NOT NULL, amount INTEGER NOT NULL,
            state TEXT NOT NULL, pay_order_id TEXT, pay_data TEXT, created_at INTEGER NOT NULL,
            paid_at INTEGER, query_at INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request_id))""")
        c.execute("INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,created_at) VALUES(?,?,?,?,?,'paid',?)",
                  ("V6-OLD", f"user:{uid}", "old-request", json.dumps({"slug": "pro", "name": "专业", "feature": "pro", "days": 365, "provider": "alipay"}), 9900, 1790467200))
    snapshot = tmp_path / "before.sqlite"
    result = manage_db.migrate(db.DB_PATH, snapshot)
    assert result["preserved_original_tables"] >= 20 and snapshot.is_file()
    with db.conn() as c:
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert c.execute("SELECT COUNT(*) FROM memberships WHERE subject_id=?", (uid,)).fetchone()[0] == 1
        assert c.execute("SELECT amount,status FROM orders WHERE order_no='OLD-ORDER'").fetchone()[:] == (9900, "paid")
        assert c.execute("SELECT expires_at FROM v6_entitlements WHERE source='OLD-ORDER'").fetchone()[0] == 1821984000
        assert c.execute("SELECT amount,state,refund_cents FROM v6_orders WHERE order_no='V6-OLD'").fetchone()[:] == (9900, "paid", 0)
    with pytest.raises(ValueError, match="new file"):
        manage_db.backup(db.DB_PATH, snapshot)


def test_migrate_detects_changed_original_account_and_keeps_backup(tmp_path, monkeypatch):
    assert db.create_user("10000000772", "migrate772", "test-password")[0]
    original_init = db.init_db

    def changed_init():
        original_init()
        with db.conn() as c:
            c.execute("UPDATE users SET custom_id='changed772' WHERE phone='10000000772'")

    monkeypatch.setattr(db, "init_db", changed_init)
    snapshot = tmp_path / "before-mutated.sqlite"
    with pytest.raises(ValueError, match="changed original rows in users"):
        manage_db.migrate(db.DB_PATH, snapshot)
    with sqlite3.connect(snapshot) as c:
        assert c.execute("SELECT custom_id FROM users WHERE phone='10000000772'").fetchone()[0] == "migrate772"
