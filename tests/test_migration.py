import hashlib
import sqlite3

import pytest

import db
import v6_engine
from scripts.manage_db import backup, migrate


def test_legacy_snapshot_upgrade_repeat_and_restore(tmp_path):
    # A v4-shaped fixture, not a claim of having inspected a production DB.
    source = tmp_path / "legacy.sqlite"
    with sqlite3.connect(source) as c:
        c.executescript("""
          CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL,
            custom_id TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',
            status TEXT NOT NULL DEFAULT 'active',daily_count INTEGER NOT NULL DEFAULT 0,
            last_play_date TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
        """)
        c.execute("INSERT INTO users(phone,custom_id,password_hash,created_at) VALUES(?,?,?,?)", ("13800000009", "legacy", hashlib.sha256(b"legacy-test").hexdigest(), "2020-01-01"))
    snapshot, second, restored = tmp_path / "before.sqlite", tmp_path / "after.sqlite", tmp_path / "restored.sqlite"
    migrate(source, snapshot)
    migrate(source, second)
    with sqlite3.connect(source) as c:
        assert c.execute("SELECT phone FROM users").fetchone()[0] == "13800000009"
        assert c.execute("SELECT count(*) FROM v6_schema").fetchone()[0] == 1
        assert "must_change_password" in {column[1] for column in c.execute("PRAGMA table_info(users)")}
        assert c.execute("SELECT COUNT(*) FROM v6_price_history").fetchone()[0] == 2
        assert c.execute("SELECT COUNT(*) FROM v6_card_batches").fetchone()[0] == 0
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    backup(snapshot, restored)
    with sqlite3.connect(restored) as c:
        assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='v6_schema'").fetchone()
        assert c.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    with pytest.raises(ValueError):
        backup(snapshot, restored)


def test_legacy_templates_paid_membership_and_order_survive(tmp_path):
    import v6_payments
    assert db.create_user("13800000008", "legacyuser", "test-pass")[0]
    uid = db.authenticate("13800000008", "test-pass")["id"]
    products = db.list_products()
    product = next(p for p in products if p["kind"] == "membership")
    order = db.create_order("user", uid, product["price_cents"], product_id=product["id"])
    assert db.mark_order_paid(order, "legacy-trade", "test")
    templates = db.list_templates(uid)
    before = backup(db.DB_PATH, tmp_path / "legacy-populated.sqlite")
    db.init_db()
    v6_engine.init_schema()
    v6_payments.init_schema()
    assert db.list_templates(uid) == templates
    assert db.get_order(order)["status"] == "paid"
    assert {"pro", "cosmic"} <= v6_engine.features(f"user:{uid}")
    restored = tmp_path / "populated-restored.sqlite"
    backup(before["path"], restored)
    with sqlite3.connect(restored) as c:
        assert c.execute("SELECT status FROM orders WHERE order_no=?", (order,)).fetchone()[0] == "paid"
