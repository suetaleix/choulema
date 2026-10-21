"""Aggregate V7 usage without inspecting candidates or draw results."""
import json
import time
from datetime import datetime, timedelta, timezone

import db
import v7_catalog
import v6_commerce as commerce

CHINA = timezone(timedelta(hours=8))


def _registered_at(value):
    try:
        parsed = datetime.fromisoformat(value)
        # Legacy naive timestamps were produced by the server's local clock.
        return int(parsed.timestamp())
    except (ValueError, TypeError):
        return None


def usage(now=None):
    now = int(time.time()) if now is None else now
    first_day = datetime.fromtimestamp(now, CHINA).date() - timedelta(days=29)
    since = int(datetime.combine(first_day, datetime.min.time(), tzinfo=CHINA).timestamp())
    with db.conn() as c:
        users = {f"user:{r['id']}": dict(r) for r in c.execute('SELECT id,created_at,status,role FROM users')}
        handoffs = {r['guest_scope']: r['owner'] for r in c.execute('SELECT guest_scope,owner FROM v6_guest_handoffs')}
        draws = c.execute('''SELECT r.owner,MIN(d.created_at) first_at,MAX(d.created_at) last_at
            FROM v6_draws d JOIN v6_runs r ON r.id=d.run_id
            WHERE r.rehearsal=0 AND d.created_at>=? AND d.created_at<=? GROUP BY r.owner''', (since,now)).fetchall()
        previews = c.execute("SELECT subject,first_at FROM v7_metrics WHERE event='skin_preview' AND first_at>=? AND first_at<=?", (since,now)).fetchall()
        orders = c.execute('SELECT owner,paid_at,snapshot FROM v6_orders WHERE paid_at>=? AND paid_at<=?', (since,now)).fetchall()
    def canonical(subject):
        return handoffs.get(subject,subject)

    participation = {}
    for row in draws:
        subject = canonical(row['owner'])
        if users.get(subject, {}).get('role') == 'superadmin':
            continue
        existing = participation.get(subject)
        participation[subject] = (min(existing[0],row['first_at']),max(existing[1],row['last_at'])) if existing else (row['first_at'],row['last_at'])
    active_accounts = sum(subject in users for subject in participation)
    preview_times = {}
    for row in previews:
        preview_times.setdefault(canonical(row['subject']), []).append(row['first_at'])
    paid_times = {}
    for row in orders:
        if json.loads(row['snapshot']).get('provider') == 'alipay':
            paid_times.setdefault(row['owner'], []).append(row['paid_at'])

    # A bounded cohort: guests who drew in this window, including new accounts
    # after their first draw. Existing accounts are excluded, not called failures.
    experienced = registered = previewed = paid = 0
    for subject,(first,_) in participation.items():
        account = users.get(subject)
        signup = _registered_at(account['created_at']) if account else None
        if account and (signup is None or signup < first):
            continue
        experienced += 1
        if signup is None or signup > now:
            continue
        registered += 1
        after_signup = [stamp for stamp in preview_times.get(subject,[]) if stamp >= signup]
        if not after_signup:
            continue
        previewed += 1
        if any(stamp >= min(after_signup) for stamp in paid_times.get(subject,[])):
            paid += 1
    rate = lambda n,d: round(n/d*100,1) if d else None
    return {
        'since':since, 'until':now, 'days':30,
        'active_accounts':active_accounts, 'guest_scopes':sum(s.startswith('guest:') for s in participation),
        'cohort':{'experienced':experienced,'registered':registered,'previewed':previewed,'paid':paid,
                  'registration_rate':rate(registered,experienced),'preview_rate':rate(previewed,registered),'payment_rate':rate(paid,previewed)},
        'definition':'最近 30 个中国时区自然日内正式抽取的游客身份；可识别的新账号按先体验、后注册、后预览、后支付顺序统计。已有账号及超管不进入转化分母。',
        'limitations':'游客按浏览器身份去重，不等于自然人数；登录衔接后合并身份。预演不计；无时间戳的历史预览不推算转化；支付成功含后续退款。',
    }


def entitlement_sources(now=None):
    now = int(time.time()) if now is None else now
    kinds = ('paid','card','referral','manual','legacy','other')
    owners = {kind:set() for kind in kinds}
    features = {feature:{kind:set() for kind in kinds} for feature in {p['feature'] for p in v7_catalog.PRODUCTS.values()}}
    with db.conn() as c:
        eligible = {f"user:{r['id']}" for r in c.execute("SELECT id FROM users WHERE status='active' AND role<>'superadmin'")}
        rows = c.execute('''SELECT e.owner,e.feature,e.source,e.expires_at,o.snapshot,o.state,o.paid_at
            FROM v6_entitlements e LEFT JOIN v6_entitlement_revocations r
            ON r.owner=e.owner AND r.feature=e.feature AND r.source=e.source
            LEFT JOIN v6_orders o ON o.order_no=e.source
            WHERE r.source IS NULL AND (e.expires_at IS NULL OR e.expires_at>?)''',(now,)).fetchall()
        for row in rows:
            owner,feature,source = row['owner'],row['feature'],row['source']
            if owner not in eligible:
                continue
            kind = 'referral' if source.startswith('invite:') else 'card' if source.startswith('card:') else 'manual' if source.startswith('admin:') else 'other'
            if row['state']=='paid' and row['paid_at'] and row['snapshot'] and json.loads(row['snapshot']).get('provider')=='alipay':
                kind = 'paid'
            owners[kind].add(owner)
            if feature in features:
                features[feature][kind].add(owner)
        for owner in eligible:
            for feature in features:
                if commerce._legacy_expiry(c,owner,feature)>now:
                    owners['legacy'].add(owner)
                    features[feature]['legacy'].add(owner)
    return {'total_accounts':len(set().union(*owners.values())),
            'feature_totals':{feature:len(set().union(*groups.values())) for feature,groups in features.items()},
            'accounts':{kind:len(value) for kind,value in owners.items()},
            'features':{feature:{kind:len(value) for kind,value in groups.items()} for feature,groups in features.items()},
            'definition':'仅统计正常普通账号的未撤销、未到期权益来源；购买、卡密、邀请、人工、历史分别去重，同一账号可属于多个来源，不能相加作为会员总人数。'}
