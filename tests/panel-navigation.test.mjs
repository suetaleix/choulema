import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createPanelHistory} from '../static/v7/panel-navigation.mjs';

function browser(address,asyncBack=false) {
  let location = new URL(address), index = 1;
  let nav;const traversals=[];
  const stack = [{url: 'https://other.example/', state: null}, {url: address, state: null}];
  const history = {
    get state() { return stack[index].state; },
    pushState(state, unused, url) { stack.splice(++index); location.href = new URL(url, location).href; stack.push({url: location.href, state}); },
    replaceState(state, unused, url) { location.href = new URL(url, location).href; stack[index] = {url: location.href, state}; },
    back() { const move=()=>{if(index>0)location.href=stack[--index].url;nav?.settle?.();};if(asyncBack)traversals.push(move);else move(); },
  };
  nav=createPanelHistory(history, location, ['settings', 'shop', 'invite', 'panel']);
  return {location,history,stack,nav,flush(){while(traversals.length)traversals.shift()();}};
}
test('closing a direct shop link stays on play and keeps order/query parameters', () => {
  const b = browser('https://local.test/play.html?scene=person&order=abc#shop');
  b.nav.initialize(); b.nav.close('shop');
  assert.equal(b.location.href, 'https://local.test/play.html?scene=person&order=abc');
});
test('repeated opens do not add history entries and one back dismisses the panel', () => {
  const b = browser('https://local.test/play.html');
  b.nav.initialize(); b.nav.open('invite'); b.nav.open('invite');
  assert.equal(b.stack.length, 3);
  b.history.back(); assert.equal(b.nav.current(), '');
});
test('a nested dialog returns to its settings panel before leaving the game', () => {
  const b = browser('https://local.test/play.html');
  b.nav.open('settings'); b.nav.open('panel'); b.nav.close('panel');
  assert.equal(b.nav.current(), 'settings');
  b.nav.close('settings'); assert.equal(b.location.pathname, '/play.html'); assert.equal(b.nav.current(), '');
});
test('late close events from a different panel cannot navigate the new panel', () => {
  const b = browser('https://local.test/play.html');
  b.nav.open('shop'); b.nav.open('invite'); b.nav.close('shop');
  assert.equal(b.nav.current(), 'invite');
});
test('unknown hashes such as display tokens are not consumed or rewritten', () => {
  const b = browser('https://local.test/play.html?display=run#opaque-token');
  assert.equal(b.nav.initialize(), '');
  b.nav.close('shop');
  assert.equal(b.location.hash, '#opaque-token');
  assert.throws(() => b.nav.open('opaque-token'));
});

test('opening a new panel during asynchronous close traversal keeps the new panel after popstate',()=>{
 const b=browser('https://local.test/play.html?scene=food',true);
 b.nav.open('panel');b.nav.close('panel');b.nav.open('shop');b.flush();
 assert.equal(b.nav.current(),'shop');assert.equal(b.location.search,'?scene=food');
 b.nav.close('shop');b.flush();assert.equal(b.nav.current(),'');
});

test('a panel opened then closed during a pending back does not reappear or leave the game',()=>{
 const b=browser('https://local.test/play.html',true);
 b.nav.open('panel');b.nav.close('panel');b.nav.open('shop');b.nav.close('shop');b.flush();
 assert.equal(b.location.pathname,'/play.html');assert.equal(b.nav.current(),'');
});

test('a queued close event cannot clear the state or work of a newly reopened dialog',()=>{
 const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
 const start=source.indexOf("$('#modal').addEventListener('close',()=>{");
 const listener=source.slice(start,source.indexOf('let settingsReturnTarget=',start));
 let closed,stopped=0;const navigated=[];
 const modal={open:true,addEventListener:(name,callback)=>{closed=callback;}};
 const context=vm.createContext({$:()=>modal,stopOrderWatch:()=>stopped++,suppressedModalCloses:0,modalPanel:'shop',displayId:null,panelHistory:{close:key=>navigated.push(key)}});
 vm.runInContext(listener,context);closed();
 assert.equal(stopped,0);assert.equal(context.modalPanel,'shop');assert.deepEqual(navigated,[]);
});
