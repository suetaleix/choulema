import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const change=source.slice(source.indexOf('async function changeDrawMode('),source.indexOf("$('#drawMode').onchange="));
function rig(extra={}){
 const fields={'#drawMode':{value:'no_repeat'},'#candidates':{value:'米饭\n面条\n饺子'},'#configTitle':{value:'我的午饭'},'#groupField':{},'#candidateHelp':{}};
 const cache=new Map(),calls=[];
 const context=vm.createContext({config:{mode:'normal',title:'原配置',items:[{name:'原候选'}]},run:{id:'old'},saved:null,pendingRequest:null,selectedAward:'',preview:null,formMode:'normal',dirty:true,appKey:'food',
  $:key=>fields[key],toast:message=>calls.push(message),paint:()=>calls.push('paint'),persist:()=>calls.push('persist'),releaseRun:async()=>{calls.push('archive');context.run=null;},
  confirmAction:async()=>true,readConfig:()=>({mode:'normal',title:'我的午饭',items:[{name:'米饭'},{name:'面条'},{name:'饺子'}]}),defaults:()=>({mode:'inventory',items:[]}),APPS:{person:{items:['甲','乙']}},uid:()=>Math.random().toString(),storage:{get:(key,fallback)=>cache.get(key)||fallback,set:(key,value)=>cache.set(key,value)},...extra});
 vm.runInContext(change,context);return {context,fields,cache,calls};
}
test('changing ordinary rules preserves edited names/title and defers ending the run until Apply',async()=>{
 const r=rig();await r.context.changeDrawMode('no_repeat');
 assert.equal(r.fields['#candidates'].value,'米饭\n面条\n饺子');assert.equal(r.fields['#configTitle'].value,'我的午饭');
 assert.equal(r.context.config.mode,'normal');assert.equal(r.context.run.id,'old');assert.equal(r.context.formMode,'no_repeat');assert.equal(r.context.dirty,true);
 assert.ok(!r.calls.includes('paint')&&!r.calls.includes('archive'));
});
test('group mode reveals its count input without repainting the names',async()=>{
 const r=rig({appKey:'person',formMode:'no_repeat'});await r.context.changeDrawMode('groups');
 assert.equal(r.fields['#groupField'].hidden,false);assert.equal(r.fields['#candidates'].value,'米饭\n面条\n饺子');
});
test('preview rejects rule edits and restores the visible selection',async()=>{
 const r=rig({preview:{},formMode:'normal'});await r.context.changeDrawMode('no_repeat');
 assert.equal(r.fields['#drawMode'].value,'normal');assert.ok(!r.calls.includes('archive'));
});
test('cancelling a prize-pool to roster switch keeps the edited form and current run',async()=>{
 const r=rig({appKey:'prize',confirmAction:async()=>false});await r.context.changeDrawMode('winners');
 assert.equal(r.fields['#drawMode'].value,'normal');assert.equal(r.context.run.id,'old');assert.equal(r.cache.size,0);assert.equal(r.context.dirty,true);
});
test('confirmed prize switch stores edited pool before loading the separate roster',async()=>{
 const r=rig({appKey:'prize'});await r.context.changeDrawMode('winners');
 const pool=r.cache.get('clm-prize-modes').pool;assert.equal(pool.config.title,'我的午饭');assert.equal(pool.config.items.length,3);assert.equal(pool.run,null);
 assert.equal(r.context.config.mode,'winners');assert.equal(r.context.config.items.length,2);assert.equal(r.calls.filter(x=>x==='archive').length,1);
});
test('invalid draft cannot archive the current round during a prize switch',async()=>{
 const r=rig({appKey:'prize',readConfig:()=>{throw new Error('格式错误');}});await assert.rejects(r.context.changeDrawMode('winners'),/格式错误/);
 assert.equal(r.context.run.id,'old');assert.equal(r.cache.size,0);assert.equal(r.context.dirty,true);
});
