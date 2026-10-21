const DEFAULT_THRESHOLD = 13;

function makeStyles(element, styles) {
  Object.assign(element.style, styles);
  return element;
}

/** Create a keyboard-operable mapping from dense wheel numbers to full names. */
export function createWheelCandidateKey(mount, candidates, threshold = DEFAULT_THRESHOLD) {
  if (!mount?.ownerDocument || !Array.isArray(candidates)) {
    throw new TypeError('A mount element and candidate array are required');
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError('threshold must be a positive integer');
  }
  if (candidates.length < threshold) return null;

  const document = mount.ownerDocument;
  const previousPosition = mount.style.position;
  const changedPosition = document.defaultView.getComputedStyle(mount).position === 'static';
  if (changedPosition) mount.style.position = 'relative';

  const details = makeStyles(document.createElement('details'), {
    position: 'absolute', top: '12px', left: '12px', zIndex: '5',
    width: 'max-content', maxWidth: 'min(300px, calc(100% - 24px))',
    maxHeight: '45%', color: '#f5f1e9', background: 'rgba(15, 27, 33, 0.96)',
    border: '1px solid rgba(220, 196, 154, .48)', borderRadius: '8px',
    boxSizing: 'border-box', font: '14px/1.45 system-ui, sans-serif',
    pointerEvents: 'auto', overflowY: 'auto', overscrollBehavior: 'contain',
  });
  details.setAttribute('aria-label', '盘面序号与候选名单');
  const summary = makeStyles(document.createElement('summary'), {
    cursor: 'pointer', padding: '7px 10px', minHeight: '32px',
    boxSizing: 'border-box', userSelect: 'none', position: 'sticky', top: '0',
    background: 'rgba(15, 27, 33, 0.98)', zIndex: '1',
  });
  summary.textContent = `盘面序号 · 完整清单（${candidates.length}项）`;

  const list = makeStyles(document.createElement('ol'), {
    margin: '0', padding: '0 10px 8px', listStyle: 'none',
  });
  candidates.forEach((candidate, index) => {
    const row = makeStyles(document.createElement('li'), {
      display: 'grid', gridTemplateColumns: '2.2em minmax(0, 1fr)', gap: '6px',
      alignItems: 'start', minHeight: '32px', padding: '5px 0',
      borderTop: '1px solid rgba(245, 241, 233, .12)', boxSizing: 'border-box',
    });
    const number = makeStyles(document.createElement('span'), { fontVariantNumeric: 'tabular-nums' });
    number.textContent = `${String(index + 1).padStart(2, '0')} ·`;
    const name = makeStyles(document.createElement('span'), {
      minWidth: '0', overflowWrap: 'anywhere', wordBreak: 'break-word',
    });
    name.textContent = String(candidate?.name ?? '');
    row.append(number, name);
    list.append(row);
  });
  details.append(summary, list);
  mount.append(details);

  let destroyed = false;
  return {
    element: details,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      details.remove();
      if (changedPosition) mount.style.position = previousPosition;
    },
  };
}
