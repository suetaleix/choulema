// Local drafts belong to the authenticated subject, never to the shared device.
export function scopedStorage(raw, scope) {
  if (!/^(user|guest):\d+$/.test(scope)) throw new Error('无法确认草稿归属，请刷新重试');
  const key = name => `clm-scope:${scope}:${name}`;
  return {
    get(name, fallback) { try { return JSON.parse(raw.getItem(key(name))) ?? fallback; } catch { return fallback; } },
    set(name, value) { raw.setItem(key(name), JSON.stringify(value)); },
    remove(name) { raw.removeItem(key(name)); }
  };
}

export function importGuestDrafts(raw, from, to) {
  if (!from?.startsWith('guest:') || !to?.startsWith('user:')) return;
  const source = scopedStorage(raw, from), target = scopedStorage(raw, to);
  const consumed = `clm-imported:${from}`;
  const clearSource = () => { for (const name of ['clm-drafts', 'clm-prize-modes', 'clm-app']) source.remove(name); };
  if (target.get(consumed, false)) { clearSource(); return; }
  const incoming = source.get('clm-drafts', {}), existing = target.get('clm-drafts', {});
  const recovery = target.get('clm-draft-recovery', []);
  const remember = (old, next) => {
    if (old?.config && JSON.stringify(old)!==JSON.stringify(next) && !recovery.some(r=>JSON.stringify(r)===JSON.stringify(old))) recovery.push(old);
  };
  for (const [app, draft] of Object.entries(incoming)) {
    if (!draft?.config || !(draft.touched || draft.run || draft.saved)) continue;
    remember(existing[app], draft);
    existing[app] = draft;
  }
  // Save all destination data before removing the source; storage errors retain it.
  target.set('clm-draft-recovery', recovery);
  target.set('clm-drafts', existing);
  const modes = source.get('clm-prize-modes', {}), previous = target.get('clm-prize-modes', {});
  for (const mode of Object.keys(modes)) remember(previous[mode], modes[mode]);
  target.set('clm-draft-recovery', recovery);
  target.set('clm-prize-modes', {...previous, ...modes});
  const app = source.get('clm-app', null);
  if (app && incoming[app] && (incoming[app].touched || incoming[app].run || incoming[app].saved)) target.set('clm-app', app);
  target.set(consumed, true);
  clearSource();
}
