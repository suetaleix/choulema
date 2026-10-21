"""End-to-end domain scenarios using only disposable local databases."""
import io
import csv
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from pydantic import ValidationError

import db
import server
import v6_engine as e


def test_500_people_event_rehearsal_formal_and_recovery():
    owner = "guest:500"
    cfg = e.DrawConfig(app="prize", mode="winners", machine="sphere", count=10,
        items=[e.Candidate(id=str(i), name="同名" if i < 2 else f"嘉宾{i}") for i in range(500)],
        awards=[e.Award(id="a", name="三等奖", count=300), e.Award(id="b", name="二等奖", count=150), e.Award(id="c", name="一等奖", count=50)])
    preview = e.new_run(owner, cfg, True)
    e.draw(owner, preview["id"], "preview-request", preview["control_token"], "a")
    with db.conn() as c:
        c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", (owner, "pro", None, "test"))
    run = e.new_run(owner, cfg)
    winners = []
    for award in cfg.awards:
        for batch in range(award.count // 10):
            request = f"{award.id}-batch-{batch}"
            e.start(owner, run["id"], request, run["control_token"], award.id, "host-one")
            state = e.get_run(owner, run["id"])
            assert state["presentation"]["phase"] == "spinning"
            answer = e.draw(owner, run["id"], request, run["control_token"], award.id, "host-one")
            assert answer == e.draw(owner, run["id"], request, run["control_token"], award.id, "host-one")
            winners += answer["results"]
        with pytest.raises(e.DomainError, match="抽满"):
            e.draw(owner, run["id"], "full-" + award.id, run["control_token"], award.id)
    assert len(winners) == len({i["id"] for i in winners}) == 500
    assert len(e.get_run(owner, run["id"])["draws"]) == 50
    assert len(e.get_run(owner, preview["id"])["draws"]) == 1
    assert e.view_run(run["id"], run["view_token"])["presentation"]["phase"] == "revealed"


def test_stale_browser_scope_cannot_save_into_switched_account(cfg):
    with TestClient(server.app) as client:
        guest_scope = client.get('/api/v6/status').json()['draft_scope']
        assert guest_scope.startswith('guest:')
        assert db.create_user('10000000031', 'scopecheck', 'local-test-password')[0]
        login = client.post('/api/login', json={'phone':'10000000031','password':'local-test-password'}).json()
        assert login['guest_draft_scope'] == guest_scope
        scope = client.get('/api/v6/status').json()['draft_scope']
        assert login['draft_scope'] == scope
        stale = client.post('/api/v6/configs', json={'config':cfg.model_dump()}, headers={'X-Draft-Scope':guest_scope})
        assert stale.status_code == 409
        assert client.get('/api/v6/configs').json()['configs'] == []
        assert client.post('/api/v6/configs', json={'config':cfg.model_dump()}, headers={'X-Draft-Scope':scope}).status_code == 200
        client.post('/api/logout')
        assert client.get('/api/v6/status').json()['draft_scope'] != guest_scope
        assert client.get('/api/v6/configs',headers={'X-Draft-Scope':scope}).status_code == 409


def test_free_registration_save_logout_find_and_exclusive_guest_handoff(cfg, email_registration):
    with TestClient(server.app) as client:
        guest = client.get('/api/v6/status').json()['draft_scope']
        old_guest_cookie = client.cookies.get('gk')
        run = client.post('/api/v6/runs', json={'config':cfg.model_dump()}).json()
        registered = client.post('/api/register', json=email_registration(client, 'freeflow41@example.test', 'freeflow41', 'local-test-password'))
        assert registered.status_code == 200, registered.text
        credentials = {'identifier':'freeflow41@example.test','password':'local-test-password'}
        assert client.post('/api/login',json=credentials).json()['guest_draft_scope'] == guest
        status = client.get('/api/v6/status').json()
        assert status['features'] == []
        assert guest in status['guest_draft_scopes']
        assert client.get(f"/api/v6/runs/{run['id']}").status_code == 200
        saved = client.post('/api/v6/configs',json={'config':cfg.model_dump()}).json()
        client.post('/api/logout')
        assert client.get('/api/v6/configs').json()['configs'] == []
        client.post('/api/login',json=credentials)
        assert client.get('/api/v6/configs').json()['configs'][0]['id'] == saved['id']
        assert guest in client.get('/api/v6/status').json()['guest_draft_scopes']
        client.post('/api/logout')
        # Even a retained old guest cookie cannot reassign the handoff to user B.
        client.cookies.clear()
        client.cookies.set('gk',old_guest_cookie)
        assert db.create_user('10000000042','otherfree42','local-test-password')[0]
        other = client.post('/api/login',json={'phone':'10000000042','password':'local-test-password'}).json()
        assert other['guest_draft_scope'] is None
        assert guest not in client.get('/api/v6/status').json()['guest_draft_scopes']
        assert client.get(f"/api/v6/runs/{run['id']}").status_code == 404
        assert client.get('/api/v6/configs').json()['configs'] == []


def test_host_takeover_revokes_old_page_and_keeps_request(cfg):
    owner = "guest:1"
    run = e.new_run(owner, cfg)
    e.start(owner, run["id"], "pending-request", run["control_token"], controller_id="tab-one")
    with pytest.raises(e.DomainError):
        e.start(owner, run["id"], "different-request", run["control_token"], controller_id="tab-two")
    with pytest.raises(e.DomainError):
        e.draw(owner, run["id"], "pending-request", run["control_token"], controller_id="tab-two")
    with pytest.raises(e.DomainError):
        e.take_control("guest:other", run["id"], "tab-two")
    restored = e.take_control(owner, run["id"], "tab-two")
    with pytest.raises(e.DomainError):
        e.draw(owner, run["id"], "pending-request", run["control_token"], controller_id="tab-one")
    with ThreadPoolExecutor(max_workers=5) as pool:
        answers = list(pool.map(lambda _: e.draw(owner, run["id"], "pending-request", restored["control_token"], controller_id="tab-two"), range(5)))
    assert all(a == answers[0] for a in answers)
    assert len(e.get_run(owner, run["id"])["draws"]) == 1
    for token in (run["view_token"], restored["view_token"]):
        visible = e.view_run(run["id"], token)
        assert "controller_id" not in visible["presentation"]
        assert set(visible["draws"][0]["results"][0]) == {"id", "name"}


def login(client, phone="13800000001", username="testuser"):
    assert db.create_user(phone, username, "test-password")[0]
    response = client.post("/api/login", json={"phone": phone, "password": "test-password"})
    assert response.status_code == 200
    return db.authenticate(phone, "test-password")["id"]


def test_guest_login_merge_saved_revision_and_session_restart(cfg):
    with TestClient(server.app) as client:
        run = client.post("/api/v6/runs", json={"config": cfg.model_dump()}).json()
        uid = login(client)
        assert client.get(f"/api/v6/runs/{run['id']}").status_code == 200
        saved = client.post("/api/v6/configs", json={"config": cfg.model_dump()}).json()
        assert client.post("/api/v6/configs", json={"config": cfg.model_dump(), "id": saved["id"], "revision": 0}).status_code == 409
        cookies = dict(client.cookies)
    with TestClient(server.app) as new_process:
        new_process.cookies.update(cookies)
        assert new_process.get("/api/v6/status").json()["kind"] == "user"
        assert new_process.get("/api/v6/configs").json()["configs"][0]["id"] == saved["id"]
        login(new_process, "13800000002", "otheruser")
        assert new_process.get(f"/api/v6/runs/{run['id']}").status_code == 404
        assert new_process.post("/api/v6/configs", json={"config": cfg.model_dump(), **saved}).status_code == 404


def test_class_sessions_import_export_and_owner_boundaries(cfg):
    with TestClient(server.app) as client:
        uid = login(client)
        owner = f"user:{uid}"
        assert client.post("/api/v6/import", files={"file": ("names.csv", b"name\nA", "text/csv")}).status_code == 403
        with db.conn() as c:
            c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", (owner, "pro", None, "test"))
        saved = e.save_config(owner, cfg)
        cfg.source_config_id = saved["id"]
        for rehearsal in (False, False, True):
            run = e.new_run(owner, cfg, rehearsal)
            e.draw(owner, run["id"], "class-draw", run["control_token"])
        report = client.get(f"/api/v6/configs/{saved['id']}/report").json()
        assert report["sessions"] == 2
        assert sum(s["count"] for s in report["students"]) == 2
        assert client.get(f"/api/v6/runs/{run['id']}/export").status_code == 200
        for name, data, status in [("names.csv", b"name,id\nA,0\nA,1", 200), ("bad.xlsx", b"not-a-zip", 400), ("names.csv", b"a\n" * 1002, 400), ("bad.pdf", b"fake", 400)]:
            response = client.post("/api/v6/import", files={"file": (name, data)})
            assert response.status_code == status, response.text
        workbook = Workbook()
        workbook.active.append(["name", "id"])
        workbook.active.append(["同学", 0])
        stream = io.BytesIO()
        workbook.save(stream)
        response = client.post("/api/v6/import", files={"file": ("names.xlsx", stream.getvalue())})
        assert response.json()["rows"][1] == ["同学", "0"]
        cfg.source_config_id = "another-user-config"
        with pytest.raises(e.DomainError):
            e.new_run(owner, cfg)


def test_bad_media_and_wheel_capacity():
    with pytest.raises(ValidationError, match="图片"):
        e.DrawConfig(items=[e.Candidate(id="a", name="a")], logo="data:image/png;base64,YWJj")
    with pytest.raises(ValidationError, match="48"):
        e.DrawConfig(machine="wheel", items=[e.Candidate(id=str(i), name=str(i)) for i in range(49)])


def test_tag_filter_and_exclusion_apply_to_authoritative_pool():
    cfg = e.DrawConfig(tag_filter="双人", app="play", items=[
        e.Candidate(id="a", name="看电影", tags=["双人"]),
        e.Candidate(id="b", name="聚餐", tags=["多人"]),
        e.Candidate(id="c", name="逛展", tags=["双人"], excluded=True)])
    run = e.new_run("guest:1", cfg)
    result = e.draw("guest:1", run["id"], "tag-request", run["control_token"])
    assert [i["id"] for i in result["results"]] == ["a"]


def test_class_switch_lists_latest_formal_session_and_stale_revision(cfg):
    with TestClient(server.app) as client:
        uid = login(client)
        owner = f"user:{uid}"
        assert client.get("/api/v6/classes").status_code == 403
        with db.conn() as c:
            c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", (owner, "pro", None, "class-switch"))
        saved = e.save_config(owner, cfg)
        cfg.source_config_id = saved["id"]
        cfg.source_config_revision = saved["revision"]
        first = e.new_run(owner, cfg)
        second = e.new_run(owner, cfg)
        e.new_run(owner, cfg, True)
        cfg.title = "新的班级名称"
        updated = e.save_config(owner, cfg, saved["id"], saved["revision"])
        row = client.get("/api/v6/classes").json()["classes"][0]
        assert row["active_run_id"] == second["id"]
        assert row["sessions"] == 2 and row["pending_changes"]
        assert row["title"] == "新的班级名称"
        with pytest.raises(e.DomainError) as stale:
            e.new_run(owner, cfg)
        assert stale.value.status == 409
        # An existing session remains valid after the roster is saved again.
        e.draw(owner, first["id"], "still-valid", first["control_token"])
        cfg.source_config_revision = updated["revision"]
        latest = e.new_run(owner, cfg)
        row = client.get("/api/v6/classes").json()["classes"][0]
        assert row["active_run_id"] == latest["id"] and not row["pending_changes"]
        login(client, "13800000002", "otherteacher")
        with db.conn() as c:
            c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", ("user:2", "pro", None, "other-teacher"))
        assert client.get("/api/v6/classes").json()["classes"] == []


def test_audience_projection_returns_latest_only_without_private_roster(cfg):
    owner = "guest:view-latest"
    run = e.new_run(owner, cfg)
    for i in range(3):
        last = e.draw(owner, run["id"], f"latest-{i}", run["control_token"])
    public = e.view_run(run["id"], run["view_token"])
    assert public["draw_count"] == 3 and len(public["draws"]) == 1
    assert public["draws"][0]["results"] == [{"id": r["id"], "name": r["name"]} for r in last["results"]]
    assert "items" not in public and "config" not in public
    assert len(e.get_run(owner, run["id"])["draws"]) == 3


def test_award_export_keeps_forfeit_replacement_and_formula_safety():
    with TestClient(server.app) as client:
        uid = login(client)
        owner = f"user:{uid}"
        cfg = e.DrawConfig(app="prize", mode="winners", machine="sphere", title="=危险标题",
            items=[e.Candidate(id=str(i), name="  =候选" + str(i)) for i in range(5)],
            awards=[e.Award(id="one", name="一等奖", count=1), e.Award(id="two", name="二等奖", count=1)])
        run = e.new_run(owner, cfg, True)
        assert client.get(f"/api/v6/runs/{run['id']}/export").status_code == 403
        with db.conn() as c:
            c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", (owner, "pro", None, "export-test"))
        first = e.draw(owner, run["id"], "award-first", run["control_token"], "one")
        record = e.get_run(owner, run["id"])["draws"][0]
        reason = '=异常原因,"测试"\n第二行'
        e.forfeit(owner, run["id"], run["control_token"], record["id"], first["results"][0]["id"], reason)
        replacement = e.draw(owner, run["id"], "award-replacement", run["control_token"], "one")
        e.draw(owner, run["id"], "award-second", run["control_token"], "two")
        response = client.get(f"/api/v6/runs/{run['id']}/export?award_id=one")
        assert response.status_code == 200
        rows = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
        assert len(rows) == 2
        assert {r["奖项"] for r in rows} == {"一等奖"}
        assert {r["状态"] for r in rows} == {"有效", "弃奖"}
        assert all(r["演练"] == "True" and r["场次"].startswith("'") and r["姓名/结果"].startswith("'") for r in rows)
        old = next(r for r in rows if r["状态"] == "弃奖")
        assert old["弃奖原因"] == "'" + reason and old["弃奖时间"]
        valid = next(r for r in rows if r["状态"] == "有效")
        assert valid["编号"] == replacement["results"][0]["id"]
        assert valid["编号"] != old["编号"]
        assert valid["弃奖原因"] == ""
        all_rows = list(csv.DictReader(io.StringIO(client.get(f"/api/v6/runs/{run['id']}/export").text.lstrip("\ufeff"))))
        assert len(all_rows) == 3
        assert client.get(f"/api/v6/runs/{run['id']}/export?award_id=missing").status_code == 404
        other_uid = login(client, "13800000002", "otherexport")
        with db.conn() as c:
            c.execute("INSERT INTO v6_entitlements VALUES(?,?,?,?)", (f"user:{other_uid}", "pro", None, "other-export"))
        assert client.get(f"/api/v6/runs/{run['id']}/export?award_id=one").status_code == 404


def test_start_rejects_exhausted_award_before_animation():
    owner = "guest:preflight"
    cfg = e.DrawConfig(app="prize", mode="winners", machine="sphere", count=1,
        items=[e.Candidate(id="one", name="一"), e.Candidate(id="two", name="二")],
        awards=[e.Award(id="award", name="幸运奖", count=1)])
    run = e.new_run(owner, cfg, True)
    e.start(owner, run["id"], "first", run["control_token"], "award", "host")
    assert not e.get_run(owner, run["id"])["draws"]
    e.draw(owner, run["id"], "first", run["control_token"], "award", "host")
    with pytest.raises(e.DomainError, match="抽满"):
        e.start(owner, run["id"], "overflow", run["control_token"], "award", "host")
    state = e.get_run(owner, run["id"])
    assert state["presentation"]["phase"] == "revealed" and len(state["draws"]) == 1
    assert e.start(owner, run["id"], "first", run["control_token"], "award", "host")["phase"] == "revealed"


def test_audience_forfeit_updates_status_without_exposing_reason():
    owner = "guest:forfeit-view"
    cfg = e.DrawConfig(app="prize", mode="winners", machine="sphere", count=1,
        items=[e.Candidate(id="a", name="甲"), e.Candidate(id="b", name="乙")],
        awards=[e.Award(id="award", name="幸运奖", count=1)])
    run = e.new_run(owner, cfg, True)
    first = e.draw(owner, run["id"], "first", run["control_token"], "award")
    before = e.view_run(run["id"], run["view_token"])
    assert before["draws"][0]["forfeited"] == []
    candidate = first["results"][0]["id"]
    e.forfeit(owner, run["id"], run["control_token"], first["id"], candidate, "private reason not for audience")
    after = e.view_run(run["id"], run["view_token"])
    assert after["draws"][0]["id"] == before["draws"][0]["id"]
    assert after["draws"][0]["forfeited"] == [candidate]
    assert "private reason" not in str(after)
    assert after["draw_count"] == 1
    second = e.draw(owner, run["id"], "replacement", run["control_token"], "award")
    assert second["results"][0]["id"] != candidate
    assert e.view_run(run["id"], run["view_token"])["draws"][0]["forfeited"] == []
    assert e.get_run(owner, run["id"])["events"][0]["payload"]["reason"] == "private reason not for audience"
