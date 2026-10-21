import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v7/admin.js',import.meta.url),'utf8').replace(/^import .*?;\r?\n/gm,'');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function harness(customApi){
  const events={},windowEvents={},opened=[],nodes=new Map();
  const node=()=>({innerHTML:'',textContent:'',isConnected:true,dataset:{},addEventListener(){},querySelectorAll(){return [];},classList:{toggle(){}}});
  const dialog={...node(),open:false,addEventListener(type,handler){events[type]=handler;},close(){if(!this.open)return;this.open=false;events.close?.();}};
  nodes.set('#dialog',dialog);
  const $=selector=>{
    if(selector==='#manualGrantPanel')return null;
    if(!nodes.has(selector))nodes.set(selector,node());
    return nodes.get(selector);
  };
  const show=(title,html)=>{dialog.open=true;opened.push({title,html});$('#dialogBody').innerHTML=html;};
  const api=async(path,...args)=>{
    if(path==='/api/me')return {user:{id:1,role:'superadmin',custom_id:'qa'}};
    if(path==='/api/v7/admin/overview')return {};
    if(path==='/api/v6/admin/products')return {products:[]};
    return customApi(path,...args);
  };
  const context=vm.createContext({CONTENT:JSON.parse(fs.readFileSync(new URL('../static/v7/content-catalog.json',import.meta.url),'utf8')),$, $$:()=>[], icon:()=>'',brand:()=>'',addOverlayShell(){},
    renderDialog:show,openDialog:show,closeDialog:()=>dialog.close(),toast(){},
    guard:work=>Promise.resolve().then(work),escapeHTML:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),
    money:value=>String(value),dateTime:value=>String(value??''),api,
    document:{addEventListener(){}},window:{addEventListener(type,handler){windowEvents[type]=handler;}},
    location:{replace(){}},URLSearchParams,console,crypto:{randomUUID:()=> 'test-request-0000001'},
  });
  vm.runInContext(source,context);
  await new Promise(setImmediate);
  return {context,opened,dialog,events,windowEvents,call:(code)=>vm.runInContext(code,context)};
}
const detail=id=>({user:{id,custom_id:'ordinary',role:'user',status:'disabled'},entitlements:{sources:[]},orders:[]});

test('an uncertain operations task retains its exact request and blocks a changed retry',async()=>{
  const sent=[];let fail=true;
  const h=await harness(async(path,body)=>{sent.push(JSON.parse(JSON.stringify(body)));if(fail)throw new Error('lost response');return {job:{state:'succeeded'}};});
  const body="{kind:'backup',reason:'验收备份',request_id:'stable-backup-0001'}";
  await assert.rejects(h.call(`submitOperation(${body},-1,null)`),/lost response/);
  assert.equal(h.call('pendingOperations.size'),1);
  await assert.rejects(h.call("submitOperation({kind:'backup',reason:'不同原因',request_id:'new-backup-00001'},-1,null)"),/上一次任务/);
  assert.equal(sent.length,1);
  fail=false;await h.call(`submitOperation(${body},-1,null)`);
  assert.deepEqual(sent[0],sent[1]);assert.equal(h.call('pendingOperations.size'),0);
});

test('double-clicking a task is single flight and a running task remains queryable',async()=>{
  const request=deferred();let calls=0;
  const h=await harness(()=>{calls++;return request.promise;});
  const body="{kind:'referral_retry',reason:'恢复邀请奖励',request_id:'stable-recovery-0001'}";
  const first=h.call(`submitOperation(${body},-1,null)`);
  await h.call(`submitOperation(${body},-1,null)`);assert.equal(calls,1);
  request.resolve({job:{state:'running'}});await first;
  assert.equal(h.call('pendingOperations.size'),1);assert.equal(h.call('operationBusy'),false);
});

test('a definitive task validation rejection permits correcting and submitting a new request',async()=>{
  const h=await harness(()=>{const error=new Error('invalid reason');error.status=422;throw error;});
  await assert.rejects(h.call("submitOperation({kind:'backup',reason:'  ',request_id:'rejected-backup-0001'},-1,null)"),/invalid reason/);
  assert.equal(h.call('pendingOperations.size'),0);
});

test('closing a detail while its refresh is pending cannot reopen it',async()=>{
  const request=deferred();const h=await harness(()=>request.promise);
  h.dialog.open=true;
  const pending=h.call('showUser(17)');
  h.dialog.close();
  request.resolve(detail(17));await pending;
  assert.equal(h.opened.length,0);
  assert.equal(h.dialog.open,false);
});

test('opening a different dialog invalidates a pending account detail',async()=>{
  const request=deferred();const h=await harness(()=>request.promise);
  const pending=h.call('showUser(17)');
  h.call("openDialog('商品展示设置','当前编辑',true)");
  request.resolve(detail(17));await pending;
  assert.deepEqual(h.opened.map(x=>x.title),['商品展示设置']);
});

test('unknown compensation responses retain the exact retry payload and warn before leaving',async()=>{
  const sent=[];let fail=true;
  const h=await harness(async(path,payload)=>{sent.push(JSON.parse(JSON.stringify(payload)));if(fail)throw new Error('network lost');return {grant:{already_created:true}};});
  const payload="{feature:'pro',days:30,reason:'服务补偿',request_id:'same-request-000001'}";
  await h.call(`submitManualGrant('17',-1,${payload},null)`);
  assert.equal(h.call('manualGrantRequests.size'),1);
  let prevented=false;const event={preventDefault(){prevented=true;}};h.windowEvents.beforeunload(event);
  assert.equal(prevented,true);
  await h.call("submitManualGrant('17',-1,{feature:'pro',days:90,reason:'服务补偿',request_id:'different-request'},null)");
  assert.equal(sent.length,1);
  fail=false;
  await h.call(`submitManualGrant('17',-1,${payload},null)`);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(h.call('manualGrantRequests.size'),0);
});

test('double submit dispatches only one compensation request',async()=>{
  const request=deferred();let count=0;
  const h=await harness(()=>{count++;return request.promise;});
  const code="submitManualGrant('17',-1,{feature:'cosmic',days:30,reason:'皮肤补偿',request_id:'single-request-0001'},null)";
  const first=h.call(code),second=h.call(code);
  assert.equal(count,1);
  request.resolve({grant:{already_created:false}});await Promise.all([first,second]);
  assert.equal(h.call('manualGrantRequests.size'),0);
});

test('late account invite page cannot replace records for a newer account',async()=>{
  const oldPage=deferred(),newPage=deferred();
  const h=await harness(path=>path.includes('/users/17/referrals')?oldPage.promise:newPage.promise);
  h.dialog.open=true;
  h.call("viewRevision=6;userDetailRevision=41;$('#userReferralBlock').dataset.userId='17';");
  const oldRequest=h.call("loadUserReferrals('17',41,6,1)");
  h.call("userDetailRevision=42;$('#userReferralBlock').dataset.userId='18';");
  const newRequest=h.call("loadUserReferrals('18',42,6,1)");
  newPage.resolve({records:[{id:18,relationship:'invitee',inviter_name:'发起账号',inviter_id:4,status:'pending',pro_days:30,created_at:1}],total:1,page:1,pages:1});
  await newRequest;
  oldPage.resolve({records:[{id:17,relationship:'inviter',invitee_name:'旧账号',invitee_id:17,status:'pending',pro_days:30,created_at:1}],total:1,page:1,pages:1});
  await oldRequest;
  assert.match(h.call("$('#userReferralBlock').innerHTML"),/#18/);
  assert.doesNotMatch(h.call("$('#userReferralBlock').innerHTML"),/#17/);
});

test('closing account details discards a late invite page response',async()=>{
  const request=deferred();const h=await harness(()=>request.promise);
  h.dialog.open=true;
  h.call("viewRevision=8;userDetailRevision=51;$('#userReferralBlock').dataset.userId='27';");
  const pending=h.call("loadUserReferrals('27',51,8,1)");
  h.dialog.close();
  request.resolve({records:[{id:27,relationship:'inviter',invitee_name:'新账号',invitee_id:12,status:'rewarded',pro_days:30,created_at:1}],total:1,page:1,pages:1});
  await pending;
  assert.doesNotMatch(h.call("$('#userReferralBlock').innerHTML"),/#27/);
});

test('a completed reason form cannot close a replacement dialog',async()=>{
  const request=deferred();const h=await harness(()=>({}));
  h.context.reviewResponse=request.promise;
  h.call("globalThis.FormData=class {get(){return '验收操作原因';}};");
  await h.call("reasonDialog('核验邀请','说明','确认',()=>reviewResponse)");
  h.call("globalThis.originalReasonForm=$('#reasonForm');originalReasonForm.querySelector=()=>({disabled:false,isConnected:true});");
  const submitting=h.call('originalReasonForm.onsubmit({preventDefault(){},currentTarget:originalReasonForm})');
  h.call("originalReasonForm.isConnected=false;openDialog('新打开的窗口','保留当前编辑');");
  request.resolve();await submitting;
  assert.equal(h.dialog.open,true);
  assert.equal(h.opened.at(-1).title,'新打开的窗口');
});

test('refund detail cannot reopen a closed or replaced dialog',async()=>{
  const request=deferred();const h=await harness(()=>request.promise);
  const pending=h.call("showRefund('order-a')");
  h.call("openDialog('另一个订单','保留此内容',true)");
  request.resolve({order:{order_no:'order-a',name:'旧订单'},request:null});
  await pending;
  assert.equal(h.opened.at(-1).title,'另一个订单');
  assert.equal(h.opened.length,2);
});

test('refund submit is single flight and cannot overwrite a replacement dialog',async()=>{
  const request=deferred(),sent=[];
  const h=await harness((path,payload)=>{sent.push({path,payload});return request.promise;});
  h.call("openDialog('退款确认','待操作',true);viewRevision=9;globalThis.refundToken=userDetailRevision;");
  const task=h.call("operateRefund('order-a',{action:'submit',reason:'申请退款',expected_amount:990},refundToken,9)");
  await h.call("operateRefund('order-a',{action:'submit',reason:'申请退款',expected_amount:990},refundToken,9)");
  h.call("openDialog('新页面','当前编辑',true)");
  request.resolve({order:{order_no:'order-a',state:'refunded'},request:{state:'succeeded'}});
  await task;
  assert.equal(sent.length,1);
  assert.equal(h.opened.at(-1).title,'新页面');
  assert.equal(h.call("refundBusy.has('order-a')"),false);
});

test('closing refund detail discards late data instead of reopening it',async()=>{
  const request=deferred();const h=await harness(()=>request.promise);
  const pending=h.call("showRefund('order-close')");
  h.dialog.close();
  request.resolve({order:{order_no:'order-close',name:'退款订单'},request:null});
  await pending;
  assert.equal(h.dialog.open,false);
  assert.equal(h.opened.length,1);
});
