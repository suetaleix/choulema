import { createStage } from '/v6/stage.js';
import { makeVisualCandidates } from './visual-candidates.mjs';
const $ = id => document.getElementById(id);
const candidates = makeVisualCandidates(100);
const stage = createStage($('stage'), () => {}, () => {}, false);
let snapshot = [], generation = 0;
function renderInfo() {
  const info = stage.resultPageInfo();
  $('readout').textContent = info ? `${info.kind} · 第 ${info.page + 1}/${info.pageCount} 页 · 共 ${info.total} 项 · 每页 ${info.pageSize} · 范围 ${info.start + 1}–${info.end}` : '尚未展示';
  $('previous').disabled = !info || info.page === 0;
  $('next').disabled = $('last').disabled = !info || info.page + 1 >= info.pageCount;
  $('expected').textContent = !info ? '' : snapshot.slice(info.start, info.end).map((item, index) => Array.isArray(item)
    ? `第 ${info.start + index + 1} 组：${item.length} 人；${item.map(x => x.id).join('、')}`
    : `${item.id} · ${item.name}`).join(' / ');
}
$('stage').addEventListener('resultpagechange', renderInfo);
function configure() {
  generation++;
  snapshot = [];
  stage.configure({ machine: $('machine').value, theme: 'classic', items: candidates });
  stage.reset();
  renderInfo();
}
$('configure').onclick = configure;
$('reveal').onclick = async () => {
  const current = ++generation;
  const count = Number($('count').value), mode = $('mode').value;
  const data = mode === 'groups' ? Array.from({length: count}, () => []) : candidates.slice(0, count).map(x => ({...x}));
  if (mode === 'groups') candidates.forEach((item, index) => data[index % count].push({...item}));
  if (!await stage.start() || current !== generation) return;
  snapshot = data;
  if (mode === 'groups') stage.revealGroups(data); else stage.reveal(data);
  renderInfo();
};
$('finish').onclick = () => { stage.finishReveal(); renderInfo(); };
$('start').onclick = async () => {
  const current = ++generation;
  const started = await stage.start();
  if (current !== generation) return;
  snapshot = [];
  renderInfo();
  $('readout').textContent = started ? '再次启动成功 · 旧结果已清理' : '启动已取消';
};
$('reset').onclick = () => { generation++; snapshot = []; stage.reset(); renderInfo(); };
for (const [id, delta] of [['previous', -1], ['next', 1], ['last', Infinity]]) {
  $(id).onclick = () => {
    const info = stage.resultPageInfo();
    if (info) stage.showResultPage(delta === Infinity ? info.pageCount - 1 : info.page + delta);
    renderInfo();
  };
}
window.addEventListener('pagehide', () => { generation++; stage.dispose(); }, {once:true});
configure();
stage.quality('high');
