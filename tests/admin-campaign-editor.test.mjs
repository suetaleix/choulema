import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v7/admin.js',import.meta.url),'utf8');
const drafts=source.slice(source.indexOf('let pageEdit=null;'),source.indexOf('function openDialog('));
const editor=source.slice(source.indexOf('function readCampaignDraft('),source.indexOf('async function invites('));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const draft=()=>({name:'好友同行',enabled:true,pro_days:30,skin_feature:'cosmic',skin_days:30,monthly_cap:3,reward_newcomer:false,require_experience:false,attribution_days:30,starts_at:null,ends_at:null,reason:'验收规则发布'});
function harness(apiImpl=async()=>({campaign:{version:2}})){
 const values={...draft()},events={},nodes=new Map(),requests=[],opened=[],renders=[];
 const node=()=>({isConnected:true,hidden:false,disabled:false,textContent:'',innerHTML:''});
 const get=key=>{if(!nodes.has(key))nodes.set(key,node());return nodes.get(key);};
 const submit=node(),form={...node(),querySelector:()=>submit,addEventListener:(event,handler)=>{events[event]=handler;}};
 nodes.set('#campaignForm',form);get('#dialog').open=false;
 const ctx=vm.createContext({viewRevision:1,V7:'/api/v7',$:get,html:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  featureLabel:value=>({cosmic:'星空胶囊皮肤'}[value]||value),dateTime:value=>String(value),parseLocal:value=>value==null||value===''?null:Number(value),
  FormData:class{get(key){return values[key];}has(key){return Boolean(values[key]);}*[Symbol.iterator](){for(const [key,value] of Object.entries(values)){if(value!==false)yield [key,String(value??'')];}}},
  openDialog(title,body){opened.push({title,body});get('#dialog').open=true;},closeDialog(){get('#dialog').open=false;},toast(){},
  api:async(path,body,method)=>{requests.push({path,body,method});return apiImpl(path,body);},render:async key=>{renders.push(key);},
 });
 vm.runInContext(drafts+editor,ctx);
 vm.runInContext("bindCampaignEditor($('#campaignForm'),{version:1},[{feature:'cosmic',name:'星空胶囊'}],true,1)",ctx);
 return {values,events,nodes,requests,opened,renders,form,submit,get,ctx,
  review:()=>form.onsubmit({preventDefault(){},currentTarget:form}),publish:()=>get('#campaignPublish').onclick()};
}

test('draft preview follows edits to recipients, rewards, conditions and dates without publishing',()=>{
 const h=harness();assert.match(h.get('#campaignPreview').innerHTML,/专业功能会员 30 天/);
 Object.assign(h.values,{pro_days:7,skin_days:14,reward_newcomer:true,require_experience:true,monthly_cap:2,starts_at:100,ends_at:200});
 h.events.input();
 const html=h.get('#campaignPreview').innerHTML;
 assert.match(html,/专业功能会员 7 天/);assert.match(html,/星空胶囊 14 天/);
 assert.match(html,/新用户也获得相同奖励/);assert.match(html,/一次正式抽取/);
 assert.match(html,/最多 2 次/);assert.match(html,/100 至 200/);assert.equal(h.requests.length,0);
 h.values.enabled=false;h.values.skin_feature='';h.events.change();
 assert.match(h.get('#campaignPreview').innerHTML,/停止新邀请/);
 assert.match(h.get('#campaignPreview').innerHTML,/不赠送皮肤/);
 assert.match(h.get('#campaignPreview').innerHTML,/原有归因和已发奖励保持不变/);
});

test('preview escapes administrator-entered text and publication uses the reviewed snapshot',async()=>{
 const h=harness();h.values.name='<img src=x onerror=alert(1)>';h.values.reason='<script>bad</script>';
 h.events.input();assert.doesNotMatch(h.get('#campaignPreview').innerHTML,/<img/);
 h.review();assert.equal(h.requests.length,0);assert.match(h.opened[0].body,/&lt;script&gt;/);
 h.values.pro_days=90;
 await h.publish();
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].body.pro_days,30);
 assert.equal(h.requests[0].body.expected_version,1);assert.deepEqual(h.renders,[]);
 assert.equal(h.values.pro_days,90);assert.equal(vm.runInContext('hasUnsavedPageEdits()',h.ctx),true);
});

test('invalid date range, noninteger rewards and unavailable gift skin cannot reach publication',()=>{
 for(const changed of [{starts_at:200,ends_at:100},{pro_days:1.5},{skin_feature:'unreleased-skin'}]){
  const h=harness();Object.assign(h.values,changed);h.review();
  assert.equal(h.opened.length,0);assert.equal(h.requests.length,0);assert.notEqual(h.get('#campaignError').textContent,'');
 }
});

test('cancelling the review keeps draft fields and creates no campaign version',()=>{
 const h=harness();h.values.pro_days=14;h.review();h.get('#campaignBack').onclick();
 assert.equal(h.requests.length,0);assert.equal(h.values.pro_days,14);assert.equal(h.get('#dialog').open,false);
});

test('repeated publication clicks send only one request while saving',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.review();
 const first=h.publish();await h.publish();
 assert.equal(h.requests.length,1);assert.equal(h.submit.disabled,true);
 pending.resolve({campaign:{version:2}});await first;assert.deepEqual(h.renders,['invites']);
});

test('a stale publication response cannot close or replace a newer dialog',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.review();const task=h.publish();
 h.get('#campaignPublication').isConnected=false;h.nodes.set('#campaignPublication',{isConnected:true});
 pending.resolve({campaign:{version:2}});await task;
 assert.equal(h.get('#dialog').open,true);assert.deepEqual(h.renders,[]);
 assert.match(h.get('#campaignError').textContent,/已发布/);assert.equal(h.get('#campaignRefresh').hidden,false);
});

test('conflict and unknown outcome block another publication until rules are reloaded',async()=>{
 for(const error of [Object.assign(new Error('邀请活动已更新'),{status:409}),new TypeError('connection lost')]){
  const h=harness(async()=>{throw error;});h.review();await h.publish();await h.publish();
  assert.equal(h.requests.length,1);assert.equal(h.get('#campaignPublish').disabled,true);
  assert.equal(h.get('#campaignReload').hidden,false);assert.equal(h.get('#campaignRefresh').hidden,false);
  assert.match(h.get('#campaignPublishError').textContent,/已更新|尚未确认/);
  h.get('#campaignBack').onclick();h.review();assert.equal(h.opened.length,1);
  h.get('#campaignRefresh').onclick();assert.deepEqual(h.renders,['invites']);
 }
});

test('definitive validation failure preserves editable data without claiming publication',async()=>{
 const h=harness(async()=>{throw Object.assign(new Error('请调整奖励期限'),{status:400});});
 h.review();await h.publish();assert.equal(h.get('#campaignPublish').disabled,false);
 assert.equal(h.get('#dialog').open,true);assert.equal(h.values.reason,'验收规则发布');
 assert.match(h.get('#campaignPublishError').textContent,/请调整奖励期限/);assert.deepEqual(h.renders,[]);
});
