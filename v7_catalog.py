"""Trusted, versioned content definitions. Database overrides may only suspend use."""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import db

CATALOG_PATH = Path(__file__).parent / 'static/v7/content-catalog.json'
SECTIONS = ('machines', 'themes', 'capabilities')


def validate_catalog(data):
    if data.get('schema_version') != 1:
        raise ValueError('Unsupported content catalog version')
    for section in (*SECTIONS, 'products'):
        if not isinstance(data.get(section), dict) or not data[section]:
            raise ValueError('Missing catalog section: ' + section)
        for key, entry in data[section].items():
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,49}', key) or not entry.get('name'):
                raise ValueError('Invalid content ID or name: ' + key)
    rights = {p['feature'] for p in data['products'].values()}
    for key in ('wheel', 'capsule', 'sphere'):
        if key not in data['machines'] or data['machines'][key].get('feature'):
            raise ValueError('Launch machines must remain free: ' + key)
    if 'classic' not in data['themes'] or data['themes']['classic'].get('feature'):
        raise ValueError('Classic theme must remain free')
    for key, machine in data['machines'].items():
        if key not in data['themes']['classic']['machines']:
            raise ValueError('Every machine must include the free baseline theme: ' + key)
        if machine.get('feature') and machine['feature'] not in rights:
            raise ValueError('Machine entitlement missing: ' + key)
        if not machine.get('stage_id') or not machine.get('modes') or not 1 <= machine['max_items'] <= 1000 or not 1 <= machine['max_count'] <= 50:
            raise ValueError('Machine limits missing: ' + key)
    for key, theme in data['themes'].items():
        if not theme.get('renderer') or not theme.get('sounds') or not theme.get('machines') or set(theme['machines']) - data['machines'].keys():
            raise ValueError('Theme compatibility missing: ' + key)
        if theme.get('feature') and theme['feature'] not in rights:
            raise ValueError('Theme entitlement missing: ' + key)
    for key, capability in data['capabilities'].items():
        if not capability.get('features') or set(capability['features']) - rights:
            raise ValueError('Capability entitlement missing: ' + key)
    for key, product in data['products'].items():
        if product['kind'] not in ('skin', 'machine', 'feature') or not 1 <= product['days'] <= 3650 or not 1 <= product['price_cents'] <= 1_000_000:
            raise ValueError('Invalid product: ' + key)
        if set(product.get('machines', [])) - data['machines'].keys():
            raise ValueError('Unknown product machine: ' + key)
        if product['kind'] in ('skin', 'machine'):
            section = 'themes' if product['kind'] == 'skin' else 'machines'
            target = data[section].get(product.get('target'))
            if not target or target.get('feature') != product['feature']:
                raise ValueError('Product target mismatch: ' + key)
            if section == 'themes' and set(product['machines']) != set(target['machines']):
                raise ValueError('Product compatibility mismatch: ' + key)
        elif not product.get('capabilities') or any(product['feature'] not in data['capabilities'].get(c, {}).get('features', []) for c in product['capabilities']):
            raise ValueError('Product capability mismatch: ' + key)
    return data


CONTENT = validate_catalog(json.loads(CATALOG_PATH.read_text(encoding='utf-8')))
PRODUCTS = CONTENT['products']


def appearance(machine, theme, sound=''):
    m, t = CONTENT['machines'].get(machine), CONTENT['themes'].get(theme)
    if not m or not t:
        raise ValueError('机台或主题尚未交付，请刷新后选择可用内容')
    if machine not in t['machines']:
        raise ValueError('当前主题不兼容所选机台')
    if sound and sound not in t['sounds']:
        raise ValueError('音效必须属于当前主题')
    return m, t


def state(section, key, connection=None):
    if section not in SECTIONS or key not in CONTENT[section]:
        raise ValueError('内容不存在')
    if connection is None:
        with db.conn() as c:
            return state(section, key, c)
    row = connection.execute('SELECT v FROM settings WHERE k=?', (f'v71_content:{section}:{key}',)).fetchone()
    return json.loads(row['v']) if row else {'enabled': True, 'version': 1}


def update_state(section, key, enabled, version, reason, actor):
    from v6_engine import DomainError
    try:
        with db.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            before = state(section, key, c)
            if version != before['version']:
                raise DomainError('内容状态已更新，请刷新后重试', 409)
            after = {'enabled': enabled, 'version': version + 1}
            c.execute('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
                      (f'v71_content:{section}:{key}', json.dumps(after)))
            c.execute('INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)',
                      (actor, 'content_availability', f'{section}:{key}', json.dumps({'before': before, 'after': after, 'reason': reason}, ensure_ascii=False), datetime.now().isoformat(timespec='seconds')))
        return after
    except ValueError as exc:
        raise DomainError(str(exc), 404) from exc


def public_catalog():
    with db.conn() as c:
        return {'version': CONTENT['version'], **{section: {key: {**value, **state(section, key, c)} for key, value in CONTENT[section].items()} for section in SECTIONS}}


def has_capability(owned, key):
    definition = CONTENT['capabilities'].get(key)
    return bool(definition and set(definition['features']).intersection(owned) and state('capabilities', key)['enabled'])


def require_available(machine, theme):
    from v6_engine import DomainError
    for section, key in (('machines', machine), ('themes', theme)):
        if not state(section, key)['enabled']:
            raise DomainError(CONTENT[section][key]['name'] + '暂时维护中，请选择其他内容；已有权益与记录保留', 403)


def product_available(product):
    kind = product['kind']
    if kind in ('skin', 'machine'):
        return state('themes' if kind == 'skin' else 'machines', product['target'])['enabled']
    return any(state('capabilities', key)['enabled'] for key in product.get('capabilities', []))
