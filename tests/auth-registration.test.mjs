import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {emailKey} from '../static/v7/email-verification.mjs';

const source=fs.readFileSync(new URL('../static/v7/auth.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('async function submitAuth(event){'),source.indexOf('function renderPassword(host){'));
function harness(apiImpl,{mode='register',referralPromise=Promise.resolve()}={}){
 const messages=[],calls=[],destinations=[],state={captchaLoads:0,rendered:0};
 const fields={identifier:'new@example.test',password:'temporary-test-password',email_code:'123456'};
 const phoneNode={value:''},nodes={'#authSubmit':{disabled:false,isConnected:true},'#authForm [name="identifier"]':phoneNode};
 const context=vm.createContext({mode,authTouched:false,emailKey,emailState:{valid:()=>true,challenge:{id:'test-challenge'}},publicData:{registration_open:true},referralPromise,
  $:selector=>nodes[selector],FormData:class {get(key){return fields[key];}},
  api:async(path,body)=>{calls.push({path,body});return apiImpl(path,body);},
  message:text=>messages.push(text),loadCaptcha:()=>state.captchaLoads++,renderAuth:()=>{
   state.rendered++;nodes['#authSubmit'].isConnected=false;nodes['#authSubmit']={disabled:false,isConnected:true};fields.password='';
  },location:{assign:path=>destinations.push(path)},safeNext:'/play.html',passwordPath:()=>'/login.html?mode=password'});
 vm.runInContext(handler,context);
 return {messages,calls,destinations,state,fields,phoneNode,context,submit:()=>vm.runInContext('submitAuth({preventDefault(){},currentTarget:{querySelector:()=>({checkValidity:()=>true})}})',context)};
}

test('a confirmed registration followed by login failure switches to login without submitting registration again',async()=>{
 let logins=0;
 const h=harness(async path=>{
  if(path==='/api/register')return {success:true};
  if(++logins===1)throw Object.assign(new Error('服务暂不可用'),{status:503});
  return {draft_scope:'user:test'};
 });
 await h.submit();
 assert.equal(h.context.mode,'login');assert.equal(h.phoneNode.value,'new@example.test');
 assert.equal(h.fields.password,'');assert.equal(h.state.captchaLoads,0);
 assert.match(h.messages.at(-1),/注册已完成/);
 h.fields.password='temporary-test-password';await h.submit();
 assert.equal(h.calls.filter(call=>call.path==='/api/register').length,1);
 assert.equal(h.calls.filter(call=>call.path==='/api/login').length,2);
 assert.deepEqual(h.destinations,['/play.html']);
});

test('an uncertain registration response does not claim failure or success and suggests checking sign-in first',async()=>{
 const h=harness(async()=>{throw new TypeError('Network unavailable');});await h.submit();
 assert.equal(h.context.mode,'register');assert.equal(h.calls.length,1);
 assert.match(h.messages.at(-1),/注册结果尚未确认/);assert.match(h.messages.at(-1),/登录/);
 assert.equal(h.state.captchaLoads,0);assert.deepEqual(h.destinations,[]);
});

test('definitive email code validation errors keep the form for another attempt',async()=>{
 const h=harness(async()=>{throw Object.assign(new Error('验证码错误或已过期'),{status:400});});await h.submit();
 assert.equal(h.context.mode,'register');assert.equal(h.state.rendered,0);assert.equal(h.state.captchaLoads,0);
 assert.equal(h.messages.at(-1),'验证码错误或已过期');assert.equal(h.calls.length,1);
});

test('registration waits for attribution and only then logs into the created account',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const h=harness(async()=>({success:true,draft_scope:'user:test'}),{referralPromise:pending});
 const submit=h.submit();await new Promise(setImmediate);assert.deepEqual(h.calls,[]);
 release();await submit;
 assert.deepEqual(h.calls.map(call=>call.path),['/api/register','/api/login']);
 assert.deepEqual(h.destinations,['/play.html']);
});

test('ordinary login failures neither advertise a new account nor request a captcha',async()=>{
 const h=harness(async()=>{throw Object.assign(new Error('邮箱、账号 ID 或密码错误'),{status:401});},{mode:'login'});await h.submit();
 assert.equal(h.context.mode,'login');assert.equal(h.state.captchaLoads,0);
 assert.equal(h.messages.at(-1),'邮箱、账号 ID 或密码错误');assert.deepEqual(h.destinations,[]);
});
