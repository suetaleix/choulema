import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v7/admin.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('function editProduct(p){'),source.indexOf('async function showPriceHistory('));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function harness(apiImpl){
 const button={disabled:false,isConnected:true},errorNode={textContent:''};
 const form={isConnected:true,querySelector:selector=>selector==='[type=submit]'?button:errorNode};
 const nodes={'#priceForm':form,'#dialog':{open:true}},calls=[],renders=[],messages=[],jobs=[];
 let closes=0;
 const context=vm.createContext({viewRevision:1,V6:'/api/v6',html:String,
  $:selector=>nodes[selector],openDialog(){},closeDialog(){closes++;},toast:text=>messages.push(text),
  FormData:class {get(key){return {price:'10.90',reason:'local price validation'}[key];}has(){return true;}},
  api:async(path,body)=>{calls.push({path,body});return apiImpl(path,body);},render:async key=>renders.push(key),
  guard:fn=>{const job=fn().catch(error=>messages.push(error.message));jobs.push(job);return job;}});
 vm.runInContext(handler,context);vm.runInContext("editProduct({slug:'cosmic',name:'星空胶囊',price_cents:990,sale_visible:true})",context);
 return {form,button,errorNode,nodes,calls,renders,messages,jobs,get closes(){return closes;},
  submit(){const job=form.onsubmit({preventDefault(){},currentTarget:form});if(job?.then)jobs.push(job);return job;}};
}

test('price save ignores repeat submit while the original response is pending',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);
 h.submit();h.submit();
 assert.equal(h.calls.length,1);assert.equal(h.button.disabled,true);
 assert.equal(h.calls[0].body.price_cents,1090);
 pending.resolve({price_version:2});await Promise.all(h.jobs);
 assert.equal(h.closes,1);assert.deepEqual(h.renders,['products']);
});

test('late price response cannot close a replacement dialog in the same module',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.submit();
 h.form.isConnected=false;h.nodes['#priceForm']={isConnected:true};
 pending.resolve({price_version:2});await Promise.all(h.jobs);
 assert.equal(h.closes,0);assert.deepEqual(h.renders,[]);
});

test('a rejected price save keeps the form available and shows the failure',async()=>{
 const h=harness(async()=>{throw Object.assign(new Error('修改原因太短'),{status:400});});
 h.submit();await Promise.all(h.jobs);
 assert.equal(h.closes,0);assert.equal(h.button.disabled,false);
 assert.match(h.errorNode.textContent,/修改原因太短/);
});

test('unknown save outcome asks for price history verification instead of claiming failure',async()=>{
 const h=harness(async()=>{throw new TypeError('network interrupted');});
 h.submit();await Promise.all(h.jobs);
 assert.match(h.errorNode.textContent,/结果尚未确认/);assert.match(h.errorNode.textContent,/价格历史/);
 assert.equal(h.closes,0);assert.equal(h.button.disabled,false);
});
