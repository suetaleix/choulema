"""V7 public presentation, referral and operations endpoints."""
import json
import os
import time
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

import db
import v6_commerce as commerce
import v6_payments as payments
import v7_analytics as analytics
import v7_entitlements as manual_entitlements
import v7_referrals as referrals
import v7_operations as operations
import v7_catalog as content_catalog
import v8_feedback
from v6_engine import DomainError

class VisitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")


class CampaignUpdate(referrals.CampaignInput):
    reason: str = Field(min_length=2, max_length=200)
    expected_version: int | None = Field(default=None, ge=1, strict=True)


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra='forbid',str_strip_whitespace=True)
    action: Literal['retry','revoke','hold','release']
    reason: str = Field(min_length=2, max_length=200)


class PlainContent(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class FAQItem(PlainContent):
    question: str = Field(min_length=1, max_length=100)
    answer: str = Field(min_length=1, max_length=500)


class SceneDescriptions(PlainContent):
    food: str = Field(default="给每一餐一点新鲜感", min_length=1, max_length=180)
    play: str = Field(default="发现下一个好主意，只抽活动，不安排日程", min_length=1, max_length=180)
    prize: str = Field(default="抽一个奖品，或为奖品抽出幸运的人", min_length=1, max_length=180)
    person: str = Field(default="课堂点名与随机分组，让每个人都有机会", min_length=1, max_length=180)


class ContentFields(PlainContent):
    hero_title: str = Field(default="让选择，值得期待。", min_length=1, max_length=40)
    hero_text: str = Field(default="吃什么，玩什么，下一位是谁。交给机台，收获一点意料之外。", min_length=1, max_length=180)
    cta: str = Field(default="免费玩一局", min_length=1, max_length=20)
    notice: str = Field(default="", max_length=300)
    hero_machine: Literal["capsule", "wheel", "sphere"] = "capsule"
    intro_text: str = Field(default="选择一个场景，放入你的候选，然后按下抽取。三台基础机台都可以自由使用。", min_length=1, max_length=300)
    scene_descriptions: SceneDescriptions = Field(default_factory=SceneDescriptions)
    free_description: str = Field(default="四种用途、三台基础机台，完整 3D 演出，免费不限次。免费注册后可以保存个人配置。", min_length=1, max_length=300)
    skin_description: str = Field(default="星空主题适用于胶囊、转盘和姓名星球，包含三种可选音效。独立开通，不改变结果。", min_length=1, max_length=300)
    pro_description: str = Field(default="多班课次、多奖项、品牌舞台、导入与导出等专业功能。功能会员与皮肤分别开通。", min_length=1, max_length=300)
    faq: list[FAQItem] = Field(default_factory=lambda: [
        FAQItem(question="一定要注册或付费吗？", answer="不用。四种基础玩法与三台基础机台可直接免费使用，不限抽取次数；注册后可保存个人配置。"),
        FAQItem(question="皮肤和会员有什么区别？", answer="皮肤改变机台外观与演出，功能会员增加已上架的专业功能。二者独立计时，付费不改变抽取概率。"),
        FAQItem(question="邀请奖励如何领取？", answer="登录后复制专属邀请链接。好友按当前活动规则完成新注册后，服务端核验并自动发放奖励；具体天数和上限以活动说明为准。"),
    ], min_length=1, max_length=8)


DEFAULT_CONTENT = ContentFields().model_dump()


def content():
    try:
        saved = json.loads(db.get_setting("v7_public_content", "{}"))
        return ContentFields.model_validate(saved).model_dump()
    except (ValueError, TypeError):
        return ContentFields().model_dump()


class ContentIn(PlainContent):
    content: ContentFields
    reason: str = Field(min_length=2, max_length=200)


class SystemIn(PlainContent):
    registration_open: bool = Field(strict=True)
    reason: str = Field(min_length=2, max_length=200)


class OperationsIn(PlainContent):
    version: int = Field(ge=1,strict=True)
    sales_open: bool = Field(strict=True)
    maintenance: bool = Field(strict=True)
    maintenance_message: str = Field(min_length=5,max_length=300)
    reason: str = Field(min_length=2,max_length=200)


class OperationTaskIn(PlainContent):
    kind: Literal['backup','referral_retry']
    request_id: str = Field(min_length=16,max_length=80,pattern=r'^[A-Za-z0-9_-]+$')
    reason: str = Field(min_length=2,max_length=200)


class ManualGrantIn(PlainContent):
    feature: str = Field(min_length=1, max_length=50)
    days: int = Field(ge=1,le=3650,strict=True)
    reason: str = Field(min_length=2,max_length=200)
    request_id: str = Field(min_length=16,max_length=80,pattern=r'^[A-Za-z0-9_-]+$')


class RevokeIn(PlainContent):
    reason: str = Field(min_length=2,max_length=200)


class RefundIn(PlainContent):
    action: Literal['submit','query']
    reason: str = Field(default='',max_length=200)
    expected_amount: int = Field(gt=0,strict=True)


class ProductMetadataIn(PlainContent):
    sort_order: int = Field(ge=0,le=999,strict=True)
    giftable: bool = Field(strict=True)
    metadata_version: int = Field(ge=1,strict=True)
    reason: str = Field(min_length=2,max_length=200)


class ContentStateIn(PlainContent):
    enabled: bool = Field(strict=True)
    version: int = Field(ge=1, strict=True)
    reason: str = Field(min_length=2, max_length=200)


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: str = Field(pattern=r"^skin_preview$")


def overview():
    base = commerce.admin_overview()
    now = datetime.now(referrals.CHINA)
    day = now.date()
    beginning = datetime.combine(day-timedelta(days=6), datetime.min.time(), tzinfo=referrals.CHINA).timestamp()
    with db.conn() as c:
        counts = {row["status"]: row["n"] for row in c.execute("SELECT status,COUNT(*) n FROM v7_referrals GROUP BY status")}
        # Registrations are stored in the legacy application's local ISO format.
        registrations = {row["day"]: row["n"] for row in c.execute("SELECT substr(created_at,1,10) day,COUNT(*) n FROM users GROUP BY day")}
        draw_rows = c.execute("SELECT d.created_at FROM v6_draws d JOIN v6_runs r ON r.id=d.run_id WHERE r.rehearsal=0 AND d.created_at>=?", (beginning,)).fetchall()
        total_draws = c.execute("SELECT COUNT(*) FROM v6_draws d JOIN v6_runs r ON r.id=d.run_id WHERE r.rehearsal=0").fetchone()[0]
        previews = c.execute("SELECT COUNT(*) FROM v7_metrics WHERE event='skin_preview'").fetchone()[0]
        needs_review = c.execute('SELECT COUNT(*) FROM v7_referrals WHERE manual_hold=1').fetchone()[0]
    draws = {}
    for row in draw_rows:
        key = datetime.fromtimestamp(row["created_at"], referrals.CHINA).date().isoformat()
        draws[key] = draws.get(key, 0)+1
    return {**base, "order_issues": payments.admin_issue_counts(), "feedback": v8_feedback.counts(),
            "referrals": {"rewarded": counts.get("rewarded",0), "pending": counts.get("pending",0)+counts.get("held",0), "revoked": counts.get("revoked",0),"needs_review":needs_review},
            "trend": [{"date": (day-timedelta(days=i)).isoformat(), "registrations": registrations.get((day-timedelta(days=i)).isoformat(),0),
                       "draws": draws.get((day-timedelta(days=i)).isoformat(),0)} for i in reversed(range(7))],
            "funnel": {"registrations": base["accounts"], "draws": total_draws, "skin_previews": previews, "paid_orders": base["alipay_paid_orders"]},
            "usage": analytics.usage(), "entitlement_sources": analytics.entitlement_sources()}


def install(app, current_user, current_subject):
    router = APIRouter(prefix="/api/v7")

    def admin(req):
        user = current_user(req)
        if user["role"] != "superadmin":
            raise DomainError("无权限",403)
        return user

    @router.get("/public")
    def public():
        import email_auth
        maintenance=operations.public_status()
        return {"content": content(), "campaign": referrals.public_campaign(), "registration_open": db.get_setting("registration_open","1")=="1" and not maintenance['enabled'],
                "maintenance":maintenance,"email_verification_ready":email_auth.configured()}

    @router.get("/catalog")
    def catalog():
        return content_catalog.public_catalog()

    @router.put("/admin/catalog/{section}/{key}")
    def content_state(section: str, key: str, body: ContentStateIn, req: Request):
        actor = admin(req)
        return content_catalog.update_state(section, key, body.enabled, body.version, body.reason, actor['id'])

    @router.post("/referrals/visit")
    def visit(body: VisitIn, req: Request):
        subject = current_subject(req)
        if not subject or subject["kind"] != "guest":
            return {"attributed": False, "campaign": None}
        return referrals.attribute(subject["id"],body.code)

    @router.get("/referrals/me")
    def mine(req: Request):
        return referrals.mine(current_user(req)["id"])

    @router.get("/admin/referrals/settings")
    def campaign(req: Request):
        admin(req)
        return {"campaign": referrals.current_campaign(), "skins": referrals.skins()}

    @router.put("/admin/referrals/settings")
    def change_campaign(body: CampaignUpdate, req: Request):
        actor = admin(req)
        config = referrals.CampaignInput(**body.model_dump(exclude={"reason", "expected_version"}))
        return {"campaign": referrals.update_campaign(config, actor["id"], body.reason, expected_version=body.expected_version)}

    @router.get("/admin/referrals")
    def records(req: Request, q: str="", status: str="", page: int=1, page_size: int=25, needs_review:bool=False):
        admin(req)
        return referrals.list_records(q.strip(),status,page,page_size,needs_review=needs_review)

    @router.get('/admin/users/{uid}/referrals')
    def user_referrals(uid:int,req:Request,page:int=1,page_size:int=10):
        admin(req)
        if not db.get_user(uid):
            raise DomainError('账号不存在',404)
        return referrals.list_records(page=page,page_size=page_size,user_id=uid)

    @router.post("/admin/referrals/{record_id}/review")
    def review(record_id: int, body: ReviewIn, req: Request):
        return {"record": referrals.review(record_id,body.action,body.reason,admin(req)["id"])}

    @router.get("/admin/overview")
    def admin_overview(req: Request):
        admin(req)
        return overview()

    @router.get("/admin/content")
    def get_content(req: Request):
        admin(req)
        return {"content": content()}

    @router.get('/admin/orders/{number}/refund')
    def refund_info(number:str,req:Request):
        admin(req)
        return payments.refund_detail(number)

    @router.post('/admin/orders/{number}/refund')
    def refund_order(number:str,body:RefundIn,req:Request):
        actor=admin(req)
        return payments.admin_refund(number,actor['id'],action=body.action,
                                     reason=body.reason,expected_amount=body.expected_amount)

    @router.post('/admin/users/{uid}/grants')
    def grant_manual(uid:int,body:ManualGrantIn,req:Request):
        actor = admin(req)
        return {'grant':manual_entitlements.grant(uid,body.feature,body.days,body.reason,body.request_id,actor['id'])}

    @router.post('/admin/grants/{grant_id}/revoke')
    def revoke_manual(grant_id:int,body:RevokeIn,req:Request):
        return manual_entitlements.revoke(grant_id,body.reason,admin(req)['id'])

    @router.put('/admin/products/{slug}/metadata')
    def product_metadata(slug:str,body:ProductMetadataIn,req:Request):
        actor=admin(req)
        return {'metadata':commerce.set_product_metadata(slug,body.sort_order,body.giftable,body.metadata_version,body.reason,actor['id'],payments.CATALOG)}

    @router.put("/admin/content")
    def change_content(body: ContentIn, req: Request):
        actor = admin(req)
        if len(body.reason.strip()) < 2:
            raise DomainError("请填写至少两字的修改原因")
        with db.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            before = c.execute("SELECT v FROM settings WHERE k='v7_public_content'").fetchone()
            previous = ContentFields.model_validate(json.loads(before[0]) if before else {}).model_dump()
            patch = body.content.model_dump(exclude_unset=True)
            if "scene_descriptions" in patch:
                patch["scene_descriptions"] = {**previous["scene_descriptions"], **patch["scene_descriptions"]}
            values = ContentFields.model_validate({**previous, **patch}).model_dump()
            c.execute("INSERT INTO settings(k,v) VALUES('v7_public_content',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (json.dumps(values,ensure_ascii=False),))
            referrals.audit(c,actor["id"],"public_content","v7",{"before":previous,"after":values,"reason":body.reason.strip()})
        return {"content": values}

    @router.get("/admin/system")
    def system(req: Request):
        actor = admin(req)
        return {"registration_open": db.get_setting("registration_open","1")=="1", "sales_enabled": payments.enabled(),
                "deployment_sales_enabled": os.getenv('V6_SALES_ENABLED')=='1', "operations": operations.status(),
                "payment_ready": payments.configured(), "products": payments.catalog(f"user:{actor['id']}"),
                "card_secret_configured": len(os.getenv("LOTTERY_CARD_SECRET",""))>=32,
                "backup_note": "请在停服后的旧库副本执行迁移验证；备份与恢复始终写入新文件。"}

    @router.put("/admin/system")
    def change_system(body: SystemIn, req: Request):
        actor = admin(req)
        with db.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            before = c.execute("SELECT v FROM settings WHERE k='registration_open'").fetchone()
            c.execute("INSERT INTO settings(k,v) VALUES('registration_open',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", ("1" if body.registration_open else "0",))
            referrals.audit(c,actor["id"],"registration_setting","registration_open",{"before":not before or before[0]=="1","after":body.registration_open,"reason":body.reason})
        return {"registration_open": body.registration_open}

    @router.put('/admin/operations')
    def change_operations(body:OperationsIn, req:Request):
        actor=admin(req)
        return {'controls':operations.update(body.model_dump(exclude={'reason'}),body.reason,actor['id'])}

    @router.post('/admin/operations/tasks')
    def operation_task(body:OperationTaskIn,req:Request):
        actor=admin(req)
        return {'job':operations.run_task(body.kind,actor['id'],body.request_id,body.reason)}

    @router.get('/admin/operations/tasks/{job_id}')
    def operation_job(job_id:str,req:Request):
        admin(req)
        return {'job':operations.job(job_id)}

    @router.post("/events")
    def event(body: EventIn, req: Request):
        subject = current_subject(req)
        if subject:
            day = datetime.now(referrals.CHINA).date().isoformat()
            with db.conn() as c:
                c.execute("""INSERT INTO v7_metrics(day,subject,event,first_at) VALUES(?,?,?,?)
                    ON CONFLICT(day,subject,event) DO UPDATE SET first_at=COALESCE(v7_metrics.first_at,excluded.first_at)""",
                    (day,f"{subject['kind']}:{subject['id']}",body.event,int(time.time())))
        return {"ok": True}

    app.include_router(router)
    v8_feedback.install(app, current_user, current_subject)
