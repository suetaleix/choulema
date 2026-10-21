"""Account controls must preserve the last administrator and revoke disabled sessions."""
from fastapi.testclient import TestClient

import db
import server


def _user(phone, name, role="user"):
    assert db.create_user(phone, name, "test-password")[0]
    uid = db.authenticate(phone, "test-password")["id"]
    if role != "user":
        with db.conn() as c:
            c.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
    return uid


def test_account_list_search_status_and_pagination():
    _user("10000000101", "admin101", "superadmin")
    first = _user("10000000102", "alpha102")
    second = _user("10000000103", "beta103")
    with db.conn() as c:
        c.execute("UPDATE users SET status='disabled' WHERE id=?", (second,))
    with TestClient(server.app) as admin, TestClient(server.app) as regular:
        assert admin.post("/api/login", json={"phone": "10000000101", "password": "test-password"}).status_code == 200
        assert regular.post("/api/login", json={"phone": "10000000102", "password": "test-password"}).status_code == 200
        assert admin.get("/api/v6/status").json()["role"] == "superadmin"
        assert regular.get("/api/v6/status").json()["role"] == "user"
        assert regular.get("/api/admin/users").status_code == 403
        one = admin.get("/api/admin/users?page=1&page_size=2").json()
        two = admin.get("/api/admin/users?page=2&page_size=2").json()
        assert one["total"] == 3 and one["pages"] == 2
        assert len(one["users"]) == 2 and len(two["users"]) == 1
        assert {u["id"] for u in one["users"] + two["users"]} == {1, first, second}
        found = admin.get("/api/admin/users?q=beta103&status=disabled").json()
        assert [u["id"] for u in found["users"]] == [second]
        assert admin.get("/api/admin/users?status=invalid").status_code == 400


def test_admin_status_changes_revoke_sessions_and_are_audited():
    admin_id = _user("10000000051", "admin51", "superadmin")
    user_id = _user("10000000052", "member52")
    with TestClient(server.app) as admin, TestClient(server.app) as user:
        assert admin.post("/api/login", json={"phone": "10000000051", "password": "test-password"}).status_code == 200
        assert user.post("/api/login", json={"phone": "10000000052", "password": "test-password"}).status_code == 200
        assert user.get("/api/me").status_code == 200
        assert user.post(f"/api/admin/users/{admin_id}/status", json={"status": "disabled"}).status_code == 403

        assert admin.post(f"/api/admin/users/{user_id}/status", json={"status": "disabled"}).status_code == 200
        assert user.get("/api/me").status_code == 401
        assert db.get_user(user_id)["status"] == "disabled"
        assert admin.post(f"/api/admin/users/{user_id}/status", json={"status": "active"}).status_code == 200
        assert db.get_user(user_id)["status"] == "active"
        with db.conn() as c:
            rows = c.execute("SELECT actor_id,action,target FROM admin_audit ORDER BY id").fetchall()
        assert [(r["actor_id"], r["action"], r["target"]) for r in rows] == [
            (admin_id, "user_status", f"user:{user_id}"),
            (admin_id, "user_status", f"user:{user_id}"),
        ]


def test_last_admin_and_self_cannot_be_disabled():
    first = _user("10000000053", "admin53", "superadmin")
    second = _user("10000000054", "admin54", "superadmin")
    with TestClient(server.app) as admin:
        assert admin.post("/api/login", json={"phone": "10000000053", "password": "test-password"}).status_code == 200
        assert admin.post(f"/api/admin/users/{first}/status", json={"status": "banned"}).status_code == 400
        assert admin.post(f"/api/admin/users/{second}/status", json={"status": "disabled"}).status_code == 200
        assert admin.post(f"/api/admin/users/{first}/status", json={"status": "disabled"}).status_code == 400
        assert db.get_user(first)["status"] == "active"
        assert db.get_user(second)["status"] == "disabled"
        assert admin.post(f"/api/admin/users/{second}/status", json={"status": "active"}).status_code == 200


def test_free_account_can_draw_after_legacy_daily_counter_is_high():
    uid = _user("10000000055", "member55")
    with db.conn() as c:
        c.execute("UPDATE users SET daily_count=900 WHERE id=?", (uid,))
    assert db.user_public(db.get_user(uid))["can_draw"] is True


def test_password_reset_requires_first_login_change_and_revokes_sessions():
    admin_id = _user("10000000056", "admin56", "superadmin")
    user_id = _user("10000000057", "member57")
    with TestClient(server.app) as admin, TestClient(server.app) as user:
        assert admin.post("/api/login", json={"phone": "10000000056", "password": "test-password"}).status_code == 200
        assert user.post("/api/login", json={"phone": "10000000057", "password": "test-password"}).status_code == 200
        assert user.post(f"/api/admin/users/{user_id}/reset-password").status_code == 403
        assert admin.post(f"/api/admin/users/{admin_id}/reset-password").status_code == 400
        response = admin.post(f"/api/admin/users/{user_id}/reset-password")
        assert response.status_code == 200
        temporary = response.json()["temporary_password"]
        assert len(temporary) >= 20
        assert user.get("/api/me").status_code == 401
        assert db.authenticate("10000000057", "test-password") is None
        assert user.post("/api/login", json={"phone": "10000000057", "password": temporary}).json()["must_change_password"]
        assert user.get("/api/me").json()["user"]["must_change_password"]
        assert user.get("/api/v6/status").status_code == 403
        assert user.post("/api/password/change", json={"current_password": "wrong", "new_password": "new-password-57"}).status_code == 400
        assert user.post("/api/password/change", json={"current_password": temporary, "new_password": "new-password-57"}).status_code == 200
        assert user.get("/api/me").status_code == 401
        assert user.post("/api/login", json={"phone": "10000000057", "password": "new-password-57"}).json()["must_change_password"] is False
        assert user.get("/api/v6/status").status_code == 200
        with db.conn() as c:
            audit = c.execute("SELECT action,target FROM admin_audit WHERE actor_id=?", (admin_id,)).fetchone()
        assert (audit["action"], audit["target"]) == ("password_reset", f"user:{user_id}")


def test_cross_origin_account_mutation_is_rejected():
    admin_id = _user("10000000058", "admin58", "superadmin")
    user_id = _user("10000000059", "member59")
    with TestClient(server.app) as client:
        assert client.post("/api/login", json={"phone": "10000000058", "password": "test-password"}).status_code == 200
        rejected = client.post(f"/api/admin/users/{user_id}/status", json={"status": "disabled"}, headers={"Origin": "https://foreign.example"})
        assert rejected.status_code == 403
        assert db.get_user(user_id)["status"] == "active"
        assert client.post(f"/api/admin/users/{user_id}/status", json={"status": "disabled"}, headers={"Origin": "http://testserver"}).status_code == 200
        assert db.get_user(user_id)["status"] == "disabled"
