import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {accessProblem} from '../static/v7/content-policy.mjs';
const CONTENT=JSON.parse(fs.readFileSync(new URL('../static/v7/content-catalog.json',import.meta.url),'utf8'));
import {soundFor} from '../static/v7/sound-catalog.mjs';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const change=source.slice(source.indexOf('async function applyAppearance('),source.indexOf('async function switchMachine('));
function rig(overrides={}){
 const saved=new Map([['clm-theme-sounds',{classic:'slot-default2',cosmic:'slot-cosmic3'}]]),requests=[],calls=[];
 const config={machine:'sphere',theme:'classic',sound:'slot-default2',items:[{id:'a',name:'甲'}],count:1};
 const context=vm.createContext({busy:false,appearanceBusy:false,pendingRequest:null,dirty:false,preview:null,
  CONTENT,accessProblem,config,run:{id:'same-run',control_token:'same-control'},account:{features:['cosmic']},soundFor,machineProblem:()=>'',
  storage:{get:(key,fallback)=>saved.get(key)||fallback,set:(key,value)=>saved.set(key,value)},
  api:async(path,body)=>{requests.push({path,body});return body;},soundRuntime:{stop:()=>calls.push('stop')},
  paint:()=>calls.push('paint'),persist:()=>calls.push('persist'),...overrides});
 vm.runInContext(change,context);return {context,saved,requests,calls,apply:value=>context.applyAppearance(value)};
}
test('selecting the current machine or sound does not save, stop audio or block the next draw',async()=>{
 const r=rig();await r.apply({machine:'sphere'});await r.apply({sound:'slot-default2'});await r.apply({theme:'classic'});
 assert.deepEqual(r.requests,[]);assert.deepEqual(r.calls,[]);assert.equal(r.context.appearanceBusy,false);
 assert.equal(r.context.run.id,'same-run');
});
test('each theme restores its own sound, while machine changes retain sound and run',async()=>{
 const r=rig();await r.apply({theme:'cosmic'});assert.equal(r.context.config.sound,'slot-cosmic3');
 await r.apply({sound:'slot-cosmic2'});await r.apply({machine:'capsule'});
 assert.equal(r.context.config.sound,'slot-cosmic2');assert.equal(r.context.run.id,'same-run');
 assert.equal(r.context.config.items[0].id,'a');
 assert.deepEqual(Object.keys(r.requests[0].body).sort(),['control_token','machine','sound','theme']);
 await r.apply({theme:'classic'});assert.equal(r.context.config.sound,'slot-default2');
 await r.apply({theme:'cosmic'});assert.equal(r.context.config.sound,'slot-cosmic2');
});
test('a rejected server change cannot modify local appearance, stored choices or run',async()=>{
 const r=rig({api:async()=>{throw new Error('not owned');}});
 await assert.rejects(r.apply({theme:'cosmic'}),/not owned/);
 assert.equal(r.context.config.theme,'classic');assert.equal(r.context.config.sound,'slot-default2');
 assert.equal(r.saved.get('clm-theme-sounds').cosmic,'slot-cosmic3');assert.equal(r.context.appearanceBusy,false);assert.deepEqual(r.calls,[]);
});
test('busy draw and overlapping appearance writes are blocked; only rehearsal bypasses local ownership',async()=>{
 for(const overrides of [{busy:true},{appearanceBusy:true},{pendingRequest:{request_id:'pending'}},{account:{features:[]}}]){
  const r=rig(overrides);await assert.rejects(r.apply({theme:'cosmic'}));assert.equal(r.requests.length,0);
 }
 const r=rig({preview:{config:{}},account:{features:[]}});await r.apply({theme:'cosmic'});assert.equal(r.requests.length,1);
});

test('switching between theme renderers disposes the old stage and retains quality/reduced settings',()=>{
 const source=fs.readFileSync(new URL('../static/v7/theme-stage.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export function','function');
 const calls=[];const factory=name=>(mount,activate,sound,reduced,motion)=>({configure:c=>calls.push([name,'config',c.machine]),dispose:()=>calls.push([name,'dispose']),quality:v=>calls.push([name,'quality',v]),reduced:v=>calls.push([name,'reduced',v]),reset(){},start:()=>true});
 const context=vm.createContext({CONTENT,classicStage:factory('classic'),cosmicStage:factory('cosmic')});vm.runInContext(source,context);
 const mount={dataset:{}},stage=context.createStage(mount,()=>{},()=>{});stage.quality('balanced');stage.reduced(true);
 stage.configure({theme:'classic',machine:'capsule'});stage.configure({theme:'cosmic',machine:'wheel'});stage.configure({theme:'cosmic',machine:'sphere'});
 assert.equal(calls.filter(c=>c[1]==='dispose').length,1);assert.ok(calls.some(c=>c[0]==='cosmic'&&c[1]==='quality'&&c[2]==='balanced'));
 assert.equal(mount.dataset.theme,'cosmic');assert.equal(mount.dataset.stageMachine,'sphere');assert.equal(mount.dataset.machine,undefined);assert.equal(stage.start(),true);stage.dispose();assert.equal(calls.filter(c=>c[1]==='dispose').length,2);
});
