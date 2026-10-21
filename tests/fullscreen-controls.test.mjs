import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const controls=source.slice(source.indexOf('function syncGameFullscreen(){'),source.indexOf("let selectedAward="));
const classes=()=>{const values=new Set();return {add(...names){names.forEach(n=>values.add(n));},remove(...names){names.forEach(n=>values.delete(n));},contains:n=>values.has(n)};};
function harness(request){
 const events={},panel={classList:classes(),dataset:{}},button={attributes:{},setAttribute(k,v){this.attributes[k]=v;}},body={classList:classes()};
 const document={body,fullscreenElement:null,addEventListener(type,fn){events[type]=fn;},exitFullscreen(){this.fullscreenElement=null;events.fullscreenchange?.();return Promise.resolve();}};
 if(request)panel.requestFullscreen=()=>request({panel,document,events});
 const context=vm.createContext({document,$:s=>s==='.stage-panel'?panel:button,setTimeout:()=>1,clearTimeout(){},controlsTimer:null});
 vm.runInContext(controls,context);
 return {panel,button,document,events,call:code=>vm.runInContext(code,context)};
}

test('unsupported fullscreen falls back to page immersion and a second toggle exits',()=>{
 const h=harness();h.call('toggleGameFullscreen()');
 assert.equal(h.panel.dataset.fullscreenMode,'page');assert.equal(h.button.attributes['aria-pressed'],'true');
 h.call('toggleGameFullscreen()');
 assert.equal(h.panel.dataset.fullscreenMode,'none');assert.equal(h.button.attributes['aria-pressed'],'false');
 assert.equal(h.document.body.classList.contains('in-performance'),false);
});

test('a rejected native request preserves a usable and escapable page mode',async()=>{
 const h=harness(()=>Promise.reject(new Error('Denied')));h.call('requestGameFullscreen()');await new Promise(setImmediate);
 assert.equal(h.panel.dataset.fullscreenMode,'page');
 h.call('leaveGameFullscreen()');assert.equal(h.panel.dataset.fullscreenMode,'none');
});

test('native fullscreen and a browser escape synchronize the displayed toggle state',async()=>{
 const h=harness(({panel,document,events})=>{document.fullscreenElement=panel;events.fullscreenchange();return Promise.resolve();});
 h.call('requestGameFullscreen()');await new Promise(setImmediate);
 assert.equal(h.panel.dataset.fullscreenMode,'native');assert.equal(h.button.title,'退出全屏');
 await h.document.exitFullscreen();
 assert.equal(h.panel.dataset.fullscreenMode,'none');assert.equal(h.button.attributes['aria-pressed'],'false');
 assert.equal(h.panel.classList.contains('controls-visible'),false);
});

test('a late fullscreen rejection cannot reenter immersion after the user exits',async()=>{
 let reject;const pending=new Promise((_,no)=>{reject=no;});const h=harness(()=>pending);
 h.call('requestGameFullscreen()');h.call('leaveGameFullscreen()');reject(new Error('Denied'));await new Promise(setImmediate);
 assert.equal(h.panel.dataset.fullscreenMode,'none');assert.equal(h.button.attributes['aria-pressed'],'false');
});

test('the exit affordance stays visible while its keyboard controls have focus, then hides after focus leaves',()=>{
 const h=harness();h.call('requestGameFullscreen()');
 h.document.activeElement={closest:()=>({})};h.call('hideGameControls()');
 assert.equal(h.panel.classList.contains('controls-visible'),true);
 h.document.activeElement={closest:()=>null};h.call('hideGameControls()');
 assert.equal(h.panel.classList.contains('controls-visible'),false);
});
