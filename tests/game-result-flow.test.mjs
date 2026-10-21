import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const restore=source.slice(source.indexOf('async function restoreState('),source.indexOf('async function recoverRun('));
function restoreHarness(overrides={}){
 const calls={progress:0,persist:0,results:[],messages:[]},button={textContent:'抽一道'};
 const context=vm.createContext({run:{id:'current',control_token:'control'},pendingRequest:null,busy:false,controllerId:'host',
  refreshProgress:()=>calls.progress++,persist:()=>calls.persist++,toast:t=>calls.messages.push(t),
  markedResult:(state,data)=>data,showResult:data=>calls.results.push(data),$:()=>button,...overrides});
 vm.runInContext(restore,context);
 return {context,calls,button,restore:(state,options)=>context.restoreState(state,options)};
}
const snapshot=(changes={})=>({id:'current',archived:false,draws:[{id:11,results:[{id:'a',name:'火锅'}]}],events:[],presentation:{phase:'revealed'},...changes});

test('returning to play keeps saved single, multiple and grouped results in history without opening a result',async()=>{
 for(const draw of [snapshot().draws[0],{id:12,results:[{id:'a'},{id:'b'}]},{id:13,results:[],groups:[[{id:'a'}],[{id:'b'}]]}]){
  const h=restoreHarness(),state=snapshot({draws:[draw]}),before=JSON.stringify(state);
  await h.restore(state);
  assert.equal(h.calls.results.length,0);assert.equal(h.calls.progress,1);
  assert.equal(h.context.run.id,'current');assert.equal(JSON.stringify(state),before);
 }
});

test('explicitly taking over a saved round may reveal its last result',async()=>{
 const h=restoreHarness(),state=snapshot();await h.restore(state,{revealSaved:true});
 assert.equal(h.calls.results.length,1);assert.equal(h.calls.results[0].id,11);
});

test('unfinished drawing restores the same request instead of generating or revealing another result',async()=>{
 const h=restoreHarness();await h.restore(snapshot({presentation:{phase:'spinning',controller_id:'host',request_id:'same-request',award_id:'award'}}));
 assert.equal(h.context.pendingRequest.request_id,'same-request');assert.equal(h.context.pendingRequest.award_id,'award');
 assert.equal(h.calls.persist,1);assert.equal(h.calls.results.length,0);assert.equal(h.button.textContent,'恢复本次抽取');
});

test('another host keeps its pending drawing and is not silently taken over',async()=>{
 const h=restoreHarness();await h.restore(snapshot({presentation:{phase:'spinning',controller_id:'other',request_id:'foreign'}}));
 assert.equal(h.context.pendingRequest,null);assert.equal(h.calls.persist,0);assert.equal(h.calls.results.length,0);
 assert.match(h.calls.messages[0],/另一主持页面/);
});

test('late reads from a different round cannot reveal, discard or replace the current round',async()=>{
 for(const stale of [snapshot({id:'old'}),snapshot({id:'old',archived:true}),snapshot({id:'old',presentation:{phase:'spinning',controller_id:'host',request_id:'old'}})]){
  const h=restoreHarness({pendingRequest:{request_id:'current-request'}});await h.restore(stale,{revealSaved:true});
  assert.equal(h.context.run.id,'current');assert.equal(h.context.pendingRequest.request_id,'current-request');
  assert.equal(h.calls.progress,0);assert.equal(h.calls.results.length,0);assert.equal(h.calls.persist,0);
 }
});

test('a late startup response cannot interrupt a running animation or a detached round',async()=>{
 for(const overrides of [{busy:true},{run:null}]){
  const h=restoreHarness(overrides);await h.restore(snapshot(),{revealSaved:true});
  assert.equal(h.calls.results.length,0);assert.equal(h.calls.progress,0);
 }
});

test('an archived round is detached while its historical snapshot remains untouched',async()=>{
 const h=restoreHarness({pendingRequest:{request_id:'old'}}),state=snapshot({archived:true}),before=JSON.stringify(state);
 await h.restore(state);assert.equal(h.context.run,null);assert.equal(h.context.pendingRequest,null);
 assert.equal(h.calls.persist,1);assert.equal(JSON.stringify(state),before);
});

const dismiss=source.slice(source.indexOf("$('#closeResult').onclick=()=>{"),source.indexOf("$('#copyButton').onclick="));
const clear=source.slice(source.indexOf('function clearResultPagination(){'),source.indexOf('function resultPageChanged('));
function dismissHarness(busy=false){
 const classes=new Set(['result-visible']),calls={reset:0,stop:0,focus:0,exit:0};
 const nodes=new Map();const $=selector=>{
  if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false,textContent:'old',items:['old'],replaceChildren(){this.items=[];},
   focus(){calls.focus++;},classList:{remove:name=>classes.delete(name)}});
  return nodes.get(selector);
 };
 const context=vm.createContext({$,busy,run:{id:'saved-round'},pendingRequest:null,result:{id:11},resultPageMeta:{page:1},paginationReady:true,
  recordInteractionDiagnostic(){},setPerformanceMode(active){calls.performance=active;},soundRuntime:{stop:()=>calls.stop++},
  stage:{reset:()=>calls.reset++},leaveGameFullscreen:()=>calls.exit++,openSettings:()=>assert.fail('Result dismissal must not open settings')});
 vm.runInContext(clear+'\n'+dismiss,context);
 return {context,calls,classes,$,click:()=>$('#closeResult').onclick()};
}

test('closing a result returns to a usable idle machine without opening settings or losing the saved round',()=>{
 const h=dismissHarness();h.click();
 assert.equal(h.$('#result').hidden,true);assert.equal(h.classes.has('result-visible'),false);
 assert.equal(h.context.result,null);assert.equal(h.context.paginationReady,false);assert.equal(h.$('#resultPagination').hidden,true);
 assert.equal(h.calls.performance,false);assert.equal(h.calls.reset,1);assert.equal(h.calls.stop,1);assert.equal(h.calls.focus,1);
 assert.equal(h.context.run.id,'saved-round');assert.deepEqual(h.$('#groupResult').items,[]);
});

test('a premature close cannot reset a machine while it is revealing',()=>{
 const h=dismissHarness(true);h.click();assert.equal(h.$('#result').hidden,false);
 assert.equal(h.context.result.id,11);assert.equal(h.calls.reset,0);assert.equal(h.calls.focus,0);
});

const repeat=source.slice(source.indexOf('async function repeatResult(){'),source.indexOf("$('#acceptButton').onclick="));
function repeatHarness(confirm=true,releaseError=false){
 const calls={confirm:0,release:0,draw:0,persist:0},rehearsal={checked:false};
 const context=vm.createContext({busy:false,config:{mode:'groups'},completedGroupRunId:null,result:{id:13,groups:[[{id:'a'}]]},run:{id:'old-group',rehearsal:true},
  confirmAction:async()=>{calls.confirm++;return confirm;},
  releaseRun:async()=>{calls.release++;if(releaseError)throw new Error('offline');context.run=null;},
  paint:()=>{context.result=null;},$:()=>rehearsal,persist:()=>calls.persist++,
  draw:async()=>{assert.equal(context.busy,false);calls.draw++;},setPerformanceMode(){},toast:t=>calls.message=t});
 vm.runInContext(repeat,context);return {calls,context,rehearsal};
}

test('a new group round requires confirmation and preserves rehearsal mode',async()=>{
 const h=repeatHarness();await h.context.repeatResult();
 assert.equal(h.calls.confirm,1);assert.equal(h.calls.release,1);assert.equal(h.calls.draw,1);
 assert.equal(h.calls.persist,1);assert.equal(h.rehearsal.checked,true);assert.equal(h.context.busy,false);
});

test('cancelling a new group round keeps the visible result and original round',async()=>{
 const h=repeatHarness(false);await h.context.repeatResult();
 assert.equal(h.context.result.id,13);assert.equal(h.context.run.id,'old-group');
 assert.equal(h.calls.release,0);assert.equal(h.calls.draw,0);assert.equal(h.context.busy,false);
});

test('failure to finish the old group round does not clear its result or start another draw',async()=>{
 const h=repeatHarness(true,true);await h.context.repeatResult();
 assert.equal(h.context.result.id,13);assert.equal(h.context.run.id,'old-group');
 assert.equal(h.calls.draw,0);assert.equal(h.calls.message,'offline');assert.equal(h.context.busy,false);
});

test('ordinary result repeats keep the same round without opening a confirmation',async()=>{
 const h=repeatHarness();h.context.result={id:11,results:[{id:'a'}]};await h.context.repeatResult();
 assert.equal(h.calls.confirm,0);assert.equal(h.calls.release,0);assert.equal(h.calls.draw,1);
});

test('a completed group round still requires confirmation after its result has been closed',async()=>{
 const h=repeatHarness(false);h.context.result=null;h.context.completedGroupRunId='old-group';
 await h.context.repeatResult();assert.equal(h.calls.confirm,1);assert.equal(h.calls.draw,0);assert.equal(h.context.run.id,'old-group');
});
