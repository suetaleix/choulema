const LIMIT = 16;
const SAFE_FIELDS = ['sameSnapshot', 'skip', 'reduced', 'hidden'];

let enabled = false;
let startedAt = 0;
let panel = null;
let entries = [];
let observer = null;

function formatDetails(details) {
  if (!details || typeof details !== 'object') return '';
  return SAFE_FIELDS
    .filter(key => typeof details[key] === 'boolean')
    .map(key => `${key}=${details[key]}`)
    .join(' ');
}

function render() {
  if (!panel) return;
  panel.textContent = entries.join('\n');
}

export function recordInteractionDiagnostic(event, details) {
  if (!enabled || typeof event !== 'string') return;
  const elapsed = Math.max(0, (performance.now() - startedAt) / 1000);
  const fields = formatDetails(details);
  entries.push(`+${elapsed.toFixed(3)}s ${event}${fields ? ` ${fields}` : ''}`);
  if (entries.length > LIMIT) entries = entries.slice(-LIMIT);
  render();
}

export function initInteractionDiagnostics() {
  if (enabled || new URLSearchParams(location.search).get('diagnostics') !== '1') return enabled;
  const result = document.querySelector('#result');
  if (!result) return false;

  enabled = true;
  startedAt = performance.now();
  panel = document.createElement('pre');
  panel.setAttribute('aria-label', '只读交互诊断');
  panel.style.cssText = [
    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:10000',
    'width:max-content', 'max-width:min(300px,45vw)', 'max-height:45vh',
    'overflow:hidden', 'margin:0', 'padding:8px', 'box-sizing:border-box',
    'border:1px solid #52646c', 'border-radius:6px', 'background:rgba(8,17,22,.94)',
    'color:#dbe9e8', 'font:10px/1.4 ui-monospace,monospace', 'white-space:pre-wrap',
    'overflow-wrap:anywhere', 'pointer-events:none',
  ].join(';');
  document.body.append(panel);

  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    const id = button.id || '-';
    const machine = button.getAttribute('data-machine') || '-';
    const app = button.getAttribute('data-app') || '-';
    recordInteractionDiagnostic(`click id=${id} data-machine=${machine} data-app=${app}`);
  }, true);

  observer = new MutationObserver(() => {
    recordInteractionDiagnostic('result-hidden', { hidden: result.hidden });
  });
  observer.observe(result, { attributes: true, attributeFilter: ['hidden'] });
  recordInteractionDiagnostic('diagnostics-ready', { hidden: result.hidden });
  return true;
}
