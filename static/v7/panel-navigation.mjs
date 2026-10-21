// Keep a direct panel link and its close/back action on the same game page.
export function createPanelHistory(history, location, keys) {
  const known = new Set(keys);
  let pendingClose = null;
  const locationKey = () => known.has(location.hash.slice(1)) ? location.hash.slice(1) : '';
  const current = () => pendingClose ? pendingClose.next || '' : locationKey();
  const url = key => location.pathname + location.search + (key ? '#' + key : '');
  const state = key => ({...history.state, v7Panel: key || null});
  return {
    current,
    settle() {
      if (!pendingClose) return;
      const next = pendingClose.next;
      pendingClose = null;
      if (next && locationKey() !== next) history.pushState(state(next), '', url(next));
    },
    initialize() {
      const key = current();
      if (key && history.state?.v7Panel !== key) {
        history.replaceState(state(''), '', url(''));
        history.pushState(state(key), '', url(key));
      }
      return key;
    },
    open(key) {
      if (!known.has(key)) throw new Error('Unknown panel');
      // Browser history.back() is asynchronous. Preserve the user's next panel
      // until that traversal has landed, rather than pushing onto the old entry.
      if (pendingClose) { pendingClose.next = key; return; }
      if (current() === key && history.state?.v7Panel === key) return;
      history.pushState(state(key), '', url(key));
    },
    close(key) {
      if (!key || current() !== key) return;
      if (pendingClose) { pendingClose.next = null; return; }
      if (history.state?.v7Panel === key) {
        pendingClose = {next:null};
        history.back();
      }
      else history.replaceState(state(''), '', url(''));
    },
  };
}
