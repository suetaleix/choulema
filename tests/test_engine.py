from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

import db
import v6_engine as e


def test_empty_and_repeated_migration():
    db.init_db()
    e.init_schema()
    assert len(db.list_products()) == 3
    with db.conn() as c:
        assert c.execute("SELECT count(*) FROM users").fetchone()[0] == 0


def test_duplicate_names_are_distinct_and_exhaustion_is_explicit(cfg):
    run = e.new_run("guest:1", cfg)
    got = []
    for i in range(10):
        got.extend(e.draw("guest:1", run["id"], f"request-{i}", run["control_token"])["results"])
    assert len({i["id"] for i in got}) == 10
    assert sum(i["name"] == "同名" for i in got) == 2
    with pytest.raises(e.DomainError, match="候选不足"):
        e.draw("guest:1", run["id"], "request-11", run["control_token"])


def test_concurrent_retry_spends_one_place(cfg):
    run = e.new_run("guest:1", cfg)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: e.draw("guest:1", run["id"], "same-request", run["control_token"]), range(8)))
    assert all(r == results[0] for r in results)
    assert len(e.get_run("guest:1", run["id"])["draws"]) == 1


def test_groups_are_balanced_and_include_every_candidate_once(cfg):
    cfg.mode, cfg.group_count = "groups", 3
    run = e.new_run("guest:1", cfg)
    result = e.draw("guest:1", run["id"], "group-request", run["control_token"])
    assert sorted(map(len, result["groups"])) == [3, 3, 4]
    assert len({i["id"] for g in result["groups"] for i in g}) == 10
    assert sorted(map(len, db.draw_groups([str(i) for i in range(10)], 3))) == [3, 3, 4]


def test_inventory_depletes_atomically():
    cfg = e.DrawConfig(app="prize", mode="inventory", count=2, items=[e.Candidate(id="a", name="礼物", stock=3)])
    run = e.new_run("guest:1", cfg)
    assert len(e.draw("guest:1", run["id"], "stock-one", run["control_token"])["results"]) == 2
    with pytest.raises(e.DomainError):
        e.draw("guest:1", run["id"], "stock-two", run["control_token"])
    assert len(e.get_run("guest:1", run["id"])["draws"]) == 1


def test_owner_controller_viewer_boundaries(cfg):
    run = e.new_run("guest:1", cfg)
    with pytest.raises(e.DomainError):
        e.get_run("guest:2", run["id"])
    with pytest.raises(e.DomainError):
        e.draw("guest:1", run["id"], "bad-control", run["view_token"])
    public = e.view_run(run["id"], run["view_token"])
    assert "config" not in public and "owner" not in public


def test_rehearsal_separate_and_paid_theme_enforced(cfg):
    cfg.theme = "cosmic"
    with pytest.raises(e.DomainError):
        e.new_run("guest:1", cfg)
    run = e.new_run("guest:1", cfg, True)
    assert e.draw("guest:1", run["id"], "preview-request", run["control_token"])["rehearsal"]
    cfg.theme = "classic"
    formal = e.new_run("guest:1", cfg)
    assert not e.get_run("guest:1", formal["id"])["draws"]


@pytest.mark.parametrize("feature", ["cosmic", "pro"])
def test_annual_expiry_retains_data_and_free_use(cfg, monkeypatch, feature):
    now = 2_000_000_000
    monkeypatch.setattr(e.time, "time", lambda: now)
    owner = "user:1"
    with db.conn() as c:
        c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)",
                  (owner, feature, now + 10, "expiry-regression"))
    if feature == "cosmic":
        cfg.theme = "cosmic"
    else:
        cfg.brand = "本地到期验收"
    saved = e.save_config(owner, cfg)
    run = e.new_run(owner, cfg)
    first = e.draw(owner, run["id"], "before-expiry", run["control_token"])
    original = e.get_run(owner, run["id"])

    now += 10
    assert feature not in e.features(owner)
    assert e.list_configs(owner)[0]["id"] == saved["id"]
    assert e.list_configs(owner)[0]["config"] == cfg.model_dump()
    assert e.get_run(owner, run["id"]) == original
    with pytest.raises(e.DomainError) as denied:
        e.draw(owner, run["id"], "after-expiry", run["control_token"])
    assert denied.value.status == 403
    assert e.get_run(owner, run["id"]) == original
    free_cfg = cfg.model_copy(update={"theme": "classic", "brand": ""})
    free = e.new_run(owner, free_cfg)
    assert e.draw(owner, free["id"], "free-still-works", free["control_token"])["results"]

    with db.conn() as c:
        c.execute("UPDATE v6_entitlements SET expires_at=? WHERE owner=? AND feature=?",
                  (now + 365 * 86400, owner, feature))
    resumed = e.draw(owner, run["id"], "after-renewal", run["control_token"])
    assert resumed["results"][0]["id"] != first["results"][0]["id"]
    assert len(e.get_run(owner, run["id"])["draws"]) == 2


def test_award_forfeit_preserves_history_and_allows_replacement(cfg):
    cfg.app, cfg.mode = "prize", "winners"
    cfg.awards = [e.Award(id="first", name="一等奖", count=1)]
    run = e.new_run("guest:1", cfg)
    first = e.draw("guest:1", run["id"], "award-first", run["control_token"], "first")
    with pytest.raises(e.DomainError, match="抽满"):
        e.draw("guest:1", run["id"], "award-full", run["control_token"], "first")
    e.forfeit("guest:1", run["id"], run["control_token"], first["id"], first["results"][0]["id"], "本人弃奖")
    second = e.draw("guest:1", run["id"], "award-replace", run["control_token"], "first")
    assert first["results"][0]["id"] != second["results"][0]["id"]
    assert len(e.get_run("guest:1", run["id"])["draws"]) == 2


def test_session_and_legacy_password_upgrade():
    import hashlib
    with db.conn() as c:
        c.execute("INSERT INTO users(phone,custom_id,password_hash,created_at) VALUES(?,?,?,?)", ("13800000000", "old", hashlib.sha256(b"test-password").hexdigest(), "2020-01-01"))
    user = db.authenticate("13800000000", "test-password")
    assert user
    assert db.get_user(user["id"])["password_hash"].startswith("pbkdf2_sha256$")
    token = db.create_session(user["id"])
    assert db.session_user(token) == user["id"]
    db.delete_session(token)
    assert db.session_user(token) is None


def test_api_first_request_and_foreign_owner(cfg):
    from fastapi.testclient import TestClient
    import server
    with TestClient(server.app) as client:
        res = client.post("/api/v6/runs", json={"config": cfg.model_dump()})
        assert res.status_code == 200, res.text
        run = res.json()
        assert client.get(f"/api/v6/runs/{run['id']}").status_code == 200
        client.cookies.clear()
        assert client.get(f"/api/v6/runs/{run['id']}").status_code == 404
