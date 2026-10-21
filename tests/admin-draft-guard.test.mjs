import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v7/admin.js',import.meta.url),'utf8');
const drafts=source.slice(source.indexOf('let pageEdit=null;'),source.indexOf('function openDialog('));
const content=source.slice(source.indexOf('function bindContentSave('),source.indexOf('async function content(revision)'));
const rendering=source.slice(source.indexOf('async function render(key)'),source.indexOf('async function overview('));
const unload=source.slice(source.indexOf("window.addEventListener('beforeunload'"),source.indexOf('\nboot();'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(apiImpl=async()=>({})){
 const values={hero_title:'免费抽，尽兴玩',hero_text:'原说明',reason:'修改玩法介绍',hero_machine:'capsule',faq:[{question:'如何玩？',answer:'选择后抽取'}]};
 const nodes={},requests=[],renders=[],prompts=[],messages=[],windowEvents={};let allowLeave=false;
 const form={isConnected:true},button={isConnected:true,disabled:false};
 nodes['#contentForm']=form;nodes['#saveContent']=button;nodes['#contentSaveStatus']={textContent:''};
 nodes['#crumb']={textContent:''};
 const faq={querySelectorAll:()=>values.faq.map(item=>({querySelector:selector=>({value:selector.includes('question')?item.question:item.answer})}))};
 const entries=()=>[...Object.entries(values).filter(([key])=>key!=='faq'),...values.faq.flatMap(item=>[['faq_question',item.question],['faq_answer',item.answer]])];
 const ctx=vm.createContext({viewRevision:1,V7:'/api/v7',contentSceneNames:{food:'抽吃什么'},$:selector=>nodes[selector],$$:()=>[],
  FormData:class {get(key){return entries().find(([name])=>name===key)?.[1]??null;}*[Symbol.iterator](){yield* entries();}},
  toast:text=>messages.push(text),confirm:text=>{prompts.push(text);return allowLeave;},api:async(path,body,method)=>{requests.push({path,body,method});return apiImpl(path,body);},
  render:async key=>renders.push(key),window:{addEventListener:(event,handler)=>{windowEvents[event]=handler;}},
  cardBatchBusy:false,unexportedCardCodes:null,manualGrantRequests:new Map(),manualGrantBusy:new Set(),operationBusy:false,pendingOperations:new Map(),
 });
 vm.runInContext(drafts+content,ctx);ctx.form=form;ctx.faq=faq;
 vm.runInContext('bindContentSave(form,faq,1)',ctx);vm.runInContext(unload,ctx);
 return {values,form,button,nodes,requests,renders,prompts,messages,ctx,
  submit:()=>form.onsubmit({preventDefault(){}}),dirty:()=>vm.runInContext('hasUnsavedPageEdits()',ctx),
  leave:()=>vm.runInContext('canLeavePageForm()',ctx),allow(value){allowLeave=value;},
  unload(){let blocked=false;windowEvents.beforeunload({preventDefault(){blocked=true;}});return blocked;},
  useRealRender(){Object.assign(ctx,{active:'content',modules:[['content','页面内容'],['overview','运营总览']],setBody(){},loading(){return '';},overview:async()=>renders.push('overview'),content:async()=>renders.push('content'),accounts(){},products(){},orders(){},entitlements(){},codes(){},invites(){},feedbackInbox(){},system(){},audit(){}});vm.runInContext(rendering,ctx);},
 };
}

test('unchanged and reverted fields navigate without a prompt; changed drafts can cancel navigation',async()=>{
 const h=harness();assert.equal(h.leave(),true);assert.equal(h.prompts.length,0);
 h.values.hero_title='新的标题';assert.equal(h.dirty(),true);assert.equal(h.leave(),false);
 assert.match(h.prompts[0],/页面内容.*未保存/);assert.equal(h.values.hero_title,'新的标题');
 h.values.hero_title='免费抽，尽兴玩';assert.equal(h.dirty(),false);assert.equal(h.leave(),true);
});

test('real module render leaves the form and revision untouched when discard is cancelled',async()=>{
 const h=harness();h.values.hero_text='尚未保存';h.useRealRender();
 await vm.runInContext("render('overview')",h.ctx);
 assert.equal(h.ctx.viewRevision,1);assert.equal(h.ctx.active,'content');assert.deepEqual(h.renders,[]);
 h.allow(true);await vm.runInContext("render('overview')",h.ctx);
 assert.equal(h.ctx.viewRevision,2);assert.equal(h.ctx.active,'overview');assert.deepEqual(h.renders,['overview']);
});

test('FAQ additions, removals and edits count as unsaved content and block unload',()=>{
 const h=harness();assert.equal(h.unload(),false);
 h.values.faq.push({question:'皮肤怎么用？',answer:'先预览'});assert.equal(h.dirty(),true);assert.equal(h.unload(),true);
 h.values.faq.pop();assert.equal(h.dirty(),false);
 h.values.faq[0].answer='每行一个候选';assert.equal(h.dirty(),true);
 h.values.faq=[];assert.equal(h.dirty(),true);
});

test('pending content saves block module changes and unload, with only one request',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.values.hero_title='提交版本';
 const first=h.submit();await h.submit();assert.equal(h.requests.length,1);
 assert.equal(h.leave(),false);assert.equal(h.prompts.length,0);assert.equal(h.unload(),true);assert.equal(h.button.disabled,true);
 pending.resolve({});await first;assert.equal(h.dirty(),false);assert.equal(h.unload(),false);assert.deepEqual(h.renders,['content']);
});

test('typing while save is pending retains newer input and does not rerender it away',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.values.hero_title='提交版本';const task=h.submit();
 h.values.hero_title='保存期间继续修改';pending.resolve({});await task;
 assert.equal(h.requests[0].body.content.hero_title,'提交版本');assert.equal(h.values.hero_title,'保存期间继续修改');
 assert.deepEqual(h.renders,[]);assert.equal(h.dirty(),true);assert.match(h.nodes['#contentSaveStatus'].textContent,/尚未保存/);
});

test('failed or uncertain saves preserve the edited draft and leave navigation protection active',async()=>{
 for(const error of [Object.assign(new Error('文案过长'),{status:400}),new TypeError('connection lost')]){
  const h=harness(async()=>{throw error;});h.values.hero_text='要保留的文案';await h.submit();
  assert.equal(h.dirty(),true);assert.equal(h.leave(),false);assert.equal(h.button.disabled,false);assert.deepEqual(h.renders,[]);
  assert.match(h.nodes['#contentSaveStatus'].textContent,/文案过长|结果尚未确认/);
 }
});

test('late successful response cannot mark a replacement editor saved or change its page',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.values.hero_text='旧请求';const task=h.submit();
 h.form.isConnected=false;h.ctx.replacement={isConnected:true};h.nodes['#contentForm']=h.ctx.replacement;
 vm.runInContext("watchPageForm(replacement,'新表单')",h.ctx);h.values.hero_text='新表单修改';
 pending.resolve({});await task;assert.equal(h.dirty(),true);assert.deepEqual(h.renders,[]);
});
