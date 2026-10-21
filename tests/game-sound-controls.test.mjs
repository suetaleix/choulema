import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function syncSoundButton('),source.indexOf('const soundRuntime=createSoundRuntime'));
const handler=source.slice(source.indexOf('let soundToggleVersion=0;'),source.indexOf("$('#quality').onchange="));
function harness({muted=true,state='muted',ready=true}={}){
 const attrs={},button={setAttribute:(k,v)=>attrs[k]=v},calls={messages:[],played:0,armed:0};
 const context=vm.createContext({muted,$:()=>button,document:{hidden:false},config:{machine:'capsule',theme:'classic'},
  recordInteractionDiagnostic(){},storage:{set:(k,v)=>calls.saved=v},toast:t=>calls.messages.push(t),
  soundRuntime:{status:()=>state,setMuted:v=>{state=v?'muted':'idle';context.syncSoundButton(state);},setHidden(){},
   arm:()=>{calls.armed++;state=ready?'ready':'unavailable';return true;},whenReady:async()=>ready,
   play:()=>{calls.played++;return true;}}});
 vm.runInContext(render+'\n'+handler,context);
 return {context,attrs,button,calls};
}

test('saved mute is visible immediately and exposes the actual accessible state',()=>{
 const h=harness();h.context.syncSoundButton('muted');
 assert.match(h.attrs['aria-label'],/已关闭/);assert.equal(h.attrs['aria-pressed'],'false');assert.equal(h.button.textContent,'♩');
});
test('enabling sound waits for readiness and plays an immediate machine preview',async()=>{
 const h=harness();await h.button.onclick();
 assert.equal(h.calls.saved,false);assert.equal(h.calls.armed,1);assert.equal(h.calls.played,1);assert.match(h.calls.messages.at(-1),/正在试听/);
});
test('failed startup reports a retry instead of claiming the sound is on',async()=>{
 const h=harness({ready:false});await h.button.onclick();
 assert.equal(h.calls.played,0);assert.match(h.calls.messages.at(-1),/未能启动/);
 h.context.syncSoundButton('unavailable');assert.match(h.attrs['aria-label'],/点击重试/);
});
test('retrying a blocked context keeps sound enabled rather than toggling it off',async()=>{
 const h=harness({muted:false,state:'unavailable'});await h.button.onclick();
 assert.equal(h.calls.saved,false);assert.equal(h.calls.armed,1);assert.equal(h.calls.played,1);
});
test('muting stops output without creating or resuming audio',async()=>{
 const h=harness({muted:false,state:'ready'});await h.button.onclick();
 assert.equal(h.calls.saved,true);assert.equal(h.calls.armed,0);assert.equal(h.calls.played,0);
});
test('draw unlocks audio within the gesture before entering fullscreen',async()=>{
 const entry=source.slice(source.indexOf('async function draw(){'),source.indexOf('let succeeded=false;'));
 const calls=[];
 const context=vm.createContext({displayId:null,waitingForStop:false,busy:false,appearanceBusy:false,configureSound(){},result:null,config:{mode:'normal'},dirty:false,stage:{},muted:false,document:{hidden:false},
  soundRuntime:{setHidden(){},arm:()=>calls.push('audio')},requestGameFullscreen:()=>calls.push('fullscreen')});
 vm.runInContext(entry+'}',context);await context.draw();assert.deepEqual(calls,['audio','fullscreen']);
});
test('returning from browser page cache clears the pagehide flag',()=>{
 const listeners={},calls=[];
 const lifecycle=source.slice(source.indexOf("document.addEventListener('visibilitychange'"),source.indexOf('// Each visit starts with the full experience'));
 vm.runInNewContext(lifecycle,{document:{hidden:false,addEventListener:(type,fn)=>listeners[type]=fn},window:{addEventListener:(type,fn)=>listeners[type]=fn},soundRuntime:{setHidden:v=>calls.push(v)}});
 listeners.pagehide();listeners.pageshow();assert.deepEqual(calls,[true,false]);
});
