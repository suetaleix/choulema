import { createStage } from '/v6/stage.js';
import { makeVisualCandidates } from './visual-candidates.mjs';

const $ = (id) => document.getElementById(id);
let activationCount = 0;
let tickCount = 0, lastTickAt = null, shortestTickGap = Infinity;
const stage = createStage($('stage'), () => {
  $('activations').textContent = String(++activationCount);
}, (kind) => {
  if (kind !== 'wheel') return;
  const now = performance.now();
  if (lastTickAt !== null) shortestTickGap = Math.min(shortestTickGap, now - lastTickAt);
  lastTickAt = now;
  $('ticks').textContent = String(++tickCount);
  $('tickGap').textContent = Number.isFinite(shortestTickGap) ? `${shortestTickGap.toFixed(1)} ms` : '—';
}, false);
// This fixture-only control uses WEBGL_lose_context when the browser exposes it.
// It does not call application APIs or recreate the stage automatically.
const loseContextButton = $('loseContext');
const restoreContextButton = $('restoreContext');
const contextStatus = $('contextStatus');
const stageCanvas = $('stage').querySelector('canvas');
const gl = stageCanvas?.getContext('webgl2')
  || stageCanvas?.getContext('webgl')
  || stageCanvas?.getContext('experimental-webgl');
const loseContextExtension = gl?.getExtension('WEBGL_lose_context');
let contextLossEvents = 0;
let contextRestoreEvents = 0;
let contextAction = null;
let contextActionTimer = null;

function updateContextControls(message = '') {
  const lost = Boolean(gl?.isContextLost());
  const pending = contextAction !== null;
  loseContextButton.disabled = !loseContextExtension || lost || pending;
  restoreContextButton.disabled = !loseContextExtension || !lost || pending;
  const state = lost ? '上下文已丢失' : '上下文可用';
  const counts = `丢失事件 ${contextLossEvents} · 恢复事件 ${contextRestoreEvents}`;
  contextStatus.textContent = [state, counts, message].filter(Boolean).join('；');
}

function finishContextAction(action, message) {
  if (contextAction !== action) return;
  clearTimeout(contextActionTimer);
  contextActionTimer = null;
  contextAction = null;
  updateContextControls(message);
}

if (stageCanvas && gl && loseContextExtension) {
  stageCanvas.addEventListener('webglcontextlost', (event) => {
    contextLossEvents += 1;
    finishContextAction('lose', `webglcontextlost 已触发；preventDefault=${event.defaultPrevented}`);
    updateContextControls(`webglcontextlost 已触发；preventDefault=${event.defaultPrevented}`);
  });
  stageCanvas.addEventListener('webglcontextrestored', () => {
    contextRestoreEvents += 1;
    finishContextAction('restore', 'webglcontextrestored 已触发');
    updateContextControls('webglcontextrestored 已触发');
  });
  loseContextButton.disabled = false;
  updateContextControls('浏览器支持 WEBGL_lose_context');
} else {
  loseContextButton.disabled = true;
  restoreContextButton.disabled = true;
  contextStatus.textContent = '当前浏览器或机台不支持 WEBGL_lose_context；生命周期模拟不可用';
}

loseContextButton.addEventListener('click', () => {
  if (!loseContextExtension || contextAction) return;
  contextAction = 'lose';
  updateContextControls('正在请求丢失上下文…');
  contextActionTimer = setTimeout(() => {
    finishContextAction('lose', gl.isContextLost()
      ? '上下文已丢失，但未观察到丢失事件'
      : '未观察到上下文丢失；可重试');
  }, 3000);
  try {
    loseContextExtension.loseContext();
  } catch (error) {
    finishContextAction('lose', `丢失请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

restoreContextButton.addEventListener('click', () => {
  if (!loseContextExtension || !gl?.isContextLost() || contextAction) return;
  contextAction = 'restore';
  updateContextControls('正在请求恢复上下文…');
  contextActionTimer = setTimeout(() => {
    finishContextAction('restore', gl.isContextLost()
      ? '上下文仍处于丢失状态；可重试'
      : '上下文已恢复，但未观察到恢复事件');
  }, 3000);
  try {
    loseContextExtension.restoreContext();
  } catch (error) {
    finishContextAction('restore', `恢复请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
});
const countControl = $('count');
const machineControl = $('machine');
const themeControl = $('theme');
const targetControl = $('target');
const fullButton = $('full');
const directButton = $('direct');
const applyButton = $('apply');
const resetButton = $('reset');
const reducedControl = $('reduced');
const qualityControl = $('quality');
let candidates = [];
let generation = 0;
let activeRun = null;

const targetModes = [
  ['first', '首项'], ['middle', '中项'], ['last', '末项'],
  ['duplicate-a', '重名A (0)'], ['duplicate-b', '重名B (1)'], ['long-name', '长名 (2)'],
];

function setPhase(value) { $('phase').textContent = value; }

function indexFor(mode, items) {
  if (mode === 'first' || mode === 'duplicate-a') return 0;
  if (mode === 'middle') return Math.floor((items.length - 1) / 2);
  if (mode === 'last') return items.length - 1;
  if (mode === 'duplicate-b') return 1;
  if (mode === 'long-name') return 2;
  return 0;
}

function selectedItem(items = candidates) {
  const index = indexFor(targetControl.value, items);
  return { item: items[index], index };
}

function renderSelection() {
  if (!candidates.length) return;
  const { item, index } = selectedItem();
  $('selection').textContent = `${index} · ${item.id} · ${item.name}`;
}

function updateTargets() {
  const count = candidates.length;
  targetControl.replaceChildren(...targetModes.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.disabled = (value === 'duplicate-b' && count < 2) || (value === 'long-name' && count < 3);
    return option;
  }));
  if (targetControl.selectedOptions[0]?.disabled) targetControl.value = 'first';
}

function configure(items) {
  candidates = items;
  stage.configure({ machine: machineControl.value, theme: machineControl.value === 'capsule' ? themeControl.value : 'classic', items });
  $('total').textContent = String(items.length);
  updateTargets();
  renderSelection();
  $('snapshot').textContent = '—';
  setPhase('待机');
}

function clearRun(run) {
  if (run.timer !== null) clearTimeout(run.timer);
  run.timer = null;
  run.wake?.();
  run.wake = null;
}

function invalidate(phase = '待机') {
  generation += 1;
  if (activeRun) clearRun(activeRun);
  activeRun = null;
  fullButton.disabled = false;
  stage.reset();
  $('snapshot').textContent = '—';
  setPhase(phase);
}

function waitFor(run, milliseconds) {
  if (!isCurrent(run)) return Promise.resolve();
  return new Promise((resolve) => {
    run.wake = resolve;
    run.timer = setTimeout(() => {
      run.timer = null;
      run.wake = null;
      resolve();
    }, milliseconds);
  });
}

function isCurrent(run) { return activeRun === run && generation === run.generation; }

async function runReveal(mode) {
  if (activeRun) return;
  const { item, index } = selectedItem();
  const run = {
    generation: ++generation,
    snapshot: { id: item.id, name: item.name },
    index,
    timer: null,
    wake: null,
    mode,
    expedite: mode === 'direct',
  };
  activeRun = run;
  tickCount = 0; lastTickAt = null; shortestTickGap = Infinity;
  $('ticks').textContent = '0'; $('tickGap').textContent = '—'; $('revealWait').textContent = '—';
  fullButton.disabled = true;
  $('snapshot').textContent = `${run.index} · ${run.snapshot.id} · ${run.snapshot.name}`;
  setPhase('启动中');

  try {
    const started = await stage.start();
    if (!isCurrent(run) || !started) return;
    if (!run.expedite) {
      const runMilliseconds = Number($('runDuration').value);
      setPhase(`运行中（${runMilliseconds / 1000} 秒）`);
      await waitFor(run, runMilliseconds);
      if (!isCurrent(run)) return;
    }
    stage.reveal([run.snapshot]);
    setPhase('揭晓中');
    const delay = stage.revealDelay();
    $('revealWait').textContent = `${delay.toFixed(0)} ms`;
    if (!run.expedite && delay > 0) {
      await waitFor(run, mode === 'late-skip' ? Math.max(0, delay - 225) : delay);
      if (mode === 'late-skip' && isCurrent(run)) run.expedite = true;
    }
    if (!isCurrent(run)) return;
    if (run.expedite) stage.finishReveal();
    setPhase('夹具计时完成');
  } catch (error) {
    if (isCurrent(run)) {
      setPhase(`错误：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (isCurrent(run)) {
      clearRun(run);
      activeRun = null;
      fullButton.disabled = false;
    }
  }
}

function configuredCandidates() {
  const count = Number(countControl.value);
  if (count === 13) return makeVisualCandidates(48).slice(0, count);
  return count === 2 || count === 8 ? makeVisualCandidates(12).slice(0, count) : makeVisualCandidates(count);
}

machineControl.addEventListener('change', () => {
  // Only the name sphere accepts more than 48 stage candidates.
  const capped = machineControl.value !== 'sphere';
  for (const option of countControl.options) option.disabled = capped && Number(option.value) > 48;
  if (capped && Number(countControl.value) > 48) countControl.value = '48';
  themeControl.querySelector('[value="cosmic"]').disabled = machineControl.value !== 'capsule';
  if (machineControl.value !== 'capsule') themeControl.value = 'classic';
});
targetControl.addEventListener('change', renderSelection);
applyButton.addEventListener('click', () => {
  invalidate('名单更新中');
  configure(configuredCandidates());
});
fullButton.addEventListener('click', () => { void runReveal('full'); });
$('lateSkip').addEventListener('click', () => { void runReveal('late-skip'); });
directButton.addEventListener('click', () => {
  if (activeRun) {
    activeRun.expedite = true;
    if (activeRun.timer !== null) {
      clearTimeout(activeRun.timer);
      activeRun.timer = null;
      activeRun.wake?.();
      activeRun.wake = null;
    }
    return;
  }
  void runReveal('direct');
});
resetButton.addEventListener('click', () => invalidate('待机'));
reducedControl.addEventListener('change', () => stage.reduced(reducedControl.checked));
$('diagnosticVisible').addEventListener('change', () => {
  const diagnostic = document.getElementById('stageDiagnostics');
  if (diagnostic) diagnostic.hidden = !$('diagnosticVisible').checked;
});
qualityControl.addEventListener('change', () => stage.quality(qualityControl.value));
window.addEventListener('pagehide', () => {
  if (contextActionTimer !== null) clearTimeout(contextActionTimer);
  if (activeRun) clearRun(activeRun);
  activeRun = null;
  generation += 1;
  stage.dispose();
}, { once: true });

configure(configuredCandidates());
stage.quality(qualityControl.value);
stage.reduced(false);
