"""Versioned operating controls and recorded, local-only maintenance tasks."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from datetime import datetime
from contextlib import closing

import db
from v6_engine import DomainError

DEFAULT = {"version": 1, "sales_open": True, "maintenance": False,
           "maintenance_message": "系统维护中，暂不开放新注册、新场次与新订单。已有场次、订单查询和售后仍可使用。"}


def init_schema():
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS v7_operation_jobs(
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id INTEGER,
            request_id TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
            started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT NOT NULL DEFAULT '{}',
            UNIQUE(kind,actor_id,request_id))""")


def _read(c):
    row = c.execute("SELECT v FROM settings WHERE k='v7_operations'").fetchone()
    return {**DEFAULT, **(json.loads(row['v']) if row else {})}


def controls():
    with db.conn() as c:
        return _read(c)


def ensure_new_work(c):
    current = _read(c)
    if current['maintenance']:
        raise DomainError(current['maintenance_message'], 503)


def ensure_available():
    with db.conn() as c:
        ensure_new_work(c)


def public_status():
    current = controls()
    return {'enabled': current['maintenance'],
            'message': current['maintenance_message'] if current['maintenance'] else ''}


def sales_allowed():
    current = controls()
    return current['sales_open'] and not current['maintenance']


def _audit(c, actor, action, target, detail):
    if actor is not None:
        c.execute('INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)',
                  (actor,action,target,json.dumps(detail,ensure_ascii=False),datetime.now().isoformat(timespec='seconds')))


def update(values, reason, actor):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        previous = _read(c)
        if previous['version'] != values['version']:
            raise DomainError('运营设置已更新，请重新读取后确认', 409)
        current = {**values, 'version': previous['version']+1}
        c.execute("INSERT INTO settings(k,v) VALUES('v7_operations',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                  (json.dumps(current,ensure_ascii=False),))
        _audit(c,actor,'operations_update','v7_operations',{'before':previous,'after':current,'reason':reason})
    return current


def _job(row):
    if not row:
        return None
    result = json.loads(row['result'])
    # Filesystem locations are internal; no download URL or raw database is exposed.
    path = result.pop('path', None)
    if path:
        try:
            file = Path(path)
            result['file_status'] = 'present_size_matches' if file.is_file() and file.stat().st_size == result['bytes'] else 'missing_or_changed'
        except OSError:
            result['file_status'] = 'unavailable'
    return {**{key:row[key] for key in ('id','kind','actor_id','request_id','reason','state','started_at','finished_at')}, 'result':result}


def job(job_id):
    with db.conn() as c:
        row = c.execute('SELECT * FROM v7_operation_jobs WHERE id=?',(job_id,)).fetchone()
    if not row:
        raise DomainError('任务记录不存在',404)
    return _job(row)


def status():
    with db.conn() as c:
        jobs = [_job(row) for row in c.execute('SELECT * FROM v7_operation_jobs ORDER BY started_at DESC,rowid DESC LIMIT 20')]
        backup = c.execute("SELECT * FROM v7_operation_jobs WHERE kind='backup' AND state='succeeded' ORDER BY finished_at DESC,rowid DESC LIMIT 1").fetchone()
        pending = c.execute("SELECT COUNT(*) FROM v7_referrals WHERE status IN ('pending','held') AND manual_hold=0").fetchone()[0]
    return {'controls':controls(),'jobs':jobs,'latest_backup':_job(backup),'pending_referrals':pending,
            'task_note':'仅记录启动时及管理员触发的任务，没有自动定时备份。执行中是最后写入状态，不代表进程仍在运行；异常退出后须核对。文件状态仅核对存在及大小，哈希记录于备份完成时。'}


def _run(kind, actor, request_id, reason, work):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        existing = c.execute('SELECT * FROM v7_operation_jobs WHERE kind=? AND actor_id IS ? AND request_id=?',
                             (kind,actor,request_id)).fetchone()
        if existing:
            if existing['reason'] != reason:
                raise DomainError('重试任务不能修改原操作原因',409)
            return _job(existing)
        job_id = secrets.token_hex(16)
        c.execute("INSERT INTO v7_operation_jobs(id,kind,actor_id,request_id,reason,state,started_at) VALUES(?,?,?,?,?,'running',?)",
                  (job_id,kind,actor,request_id,reason,int(time.time())))
        _audit(c,actor,'operation_start',job_id,{'kind':kind,'reason':reason,'request_id':request_id})
    try:
        result = work(job_id)
        state = 'succeeded'
    except Exception:
        # Do not expose exception strings containing database paths or credentials.
        result = {'message':'执行中断，请核对已有记录后再决定是否发起新任务。'}
        state = 'failed'
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute('UPDATE v7_operation_jobs SET state=?,result=?,finished_at=? WHERE id=?',
                  (state,json.dumps(result,ensure_ascii=False),int(time.time()),job_id))
        _audit(c,actor,'operation_finished',job_id,{'kind':kind,'state':state})
    return job(job_id)


def _backup(job_id):
    source = Path(db.DB_PATH).resolve()
    directory = Path(os.getenv('LOTTERY_BACKUP_DIR') or source.parent/'backups').resolve()
    public = (Path(__file__).resolve().parent/'static').resolve()
    if directory == public or directory.is_relative_to(public):
        raise ValueError('Backup directory cannot be public')
    directory.mkdir(parents=True,exist_ok=True)
    target = directory/f'backup-{datetime.now().strftime("%Y%m%d-%H%M%S")}-{job_id}.sqlite'
    # Exclusive creation: never replace any previous backup.
    with target.open('xb'):
        pass
    with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Backup integrity check failed')
    return {'name':target.name,'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
            'bytes':target.stat().st_size,'verified_at':int(time.time()),'message':'备份完成时完整性检查通过；恢复前仍须停服并复核。'}


def run_task(kind, actor, request_id, reason):
    if kind not in ('backup','referral_retry'):
        raise DomainError('任务类型无效',400)
    if kind == 'backup':
        work = _backup
    else:
        def work(_):
            import v7_referrals
            return v7_referrals.retry_pending(limit=200)
    return _run(kind,actor,request_id,reason,work)


def startup_recovery():
    return run_task('referral_retry',None,secrets.token_hex(16),'服务启动时恢复待发邀请奖励')
