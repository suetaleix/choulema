import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual page event handler, including its dispatch and focus rules.
const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf("document.addEventListener('keydown',e=>{"),source.indexOf('let controlsTimer=null;'));
test('the stage cannot accept native input before asynchronous startup binds its handlers',()=>{
 const html=fs.readFileSync(new URL('../static/play.html',import.meta.url),'utf8');
 assert.match(html,/<section[^>]+class="stage-panel game-stage"[^>]+ inert>/);
 assert.ok(source.lastIndexOf("$('.stage-panel').inert=false;")>source.indexOf("document.addEventListener('keydown'"));
});
function harness(options={}){
 const state={draws:0,closed:0,exited:0,...options};
 const controls=[0,1].map(index=>({getClientRects:()=>[{}],focus(){document.activeElement=this;},index}));
 const panel={classList:{contains:()=>!!state.settings},contains:node=>controls.includes(node)};
 const document={activeElement:controls[0],fullscreenElement:options.nativeFullscreen?{}:null,
  body:{classList:{contains:()=>!!state.immersive}},querySelector:()=>state.modal?{}:null,
  addEventListener:(_,listener)=>state.listener=listener};
 const context=vm.createContext({document,$:()=>panel,$$:()=>controls,busy:!!options.busy,waitingForStop:!!options.manual,displayId:options.displayId||null,
  draw:()=>state.draws++,guard:action=>action(),closeSettings:()=>state.closed++,leaveGameFullscreen:()=>state.exited++});
 vm.runInContext(handler,context);
 const send=(values={})=>{
  const event={code:'Space',target:{closest:()=>null},preventDefault(){this.defaultPrevented=true;},...values};
  state.listener(event);return event;
 };
 return {state,document,controls,send};
}

test('idle stage Space dispatches once while running and repeat events never enqueue draws',()=>{
 const idle=harness();assert.equal(idle.send().defaultPrevented,true);assert.equal(idle.state.draws,1);
 for(const options of [{busy:true},{manual:true,busy:true}]){const h=harness(options);h.send();assert.equal(h.state.draws,0);}
 const h=harness();h.send({repeat:true});assert.equal(h.state.draws,0);
});

test('system and input-method shortcuts do not start a draw or suppress their own behavior',()=>{
 for(const modifier of ['ctrlKey','altKey','metaKey']){
  const h=harness();const event=h.send({[modifier]:true});
  assert.equal(h.state.draws,0,modifier);assert.equal(event.defaultPrevented,undefined,modifier);
 }
});

test('IME composition and already-handled events cannot close settings or draw',()=>{
 for(const flag of ['isComposing','defaultPrevented']){
  const h=harness({settings:true});h.send({code:'Escape',[flag]:true});assert.equal(h.state.closed,0,flag);
  const idle=harness();idle.send({[flag]:true});assert.equal(idle.state.draws,0,flag);
 }
});

test('settings, modal, text inputs and result/exit controls retain their own Space behavior',()=>{
 for(const options of [{settings:true},{modal:true}]){const h=harness(options);h.send();assert.equal(h.state.draws,0);}
 for(const target of [{closest:()=>({})},{closest:()=>null,isContentEditable:true}]){
  const h=harness();const event=h.send({target});assert.equal(h.state.draws,0);assert.equal(event.defaultPrevented,undefined);
 }
});

test('stage toggles and toolbar buttons cannot consume Space as native activation',()=>{
 for(const control of ['reduceMotion','muteButton','fullscreenButton','mobileSettings','machineButton']){
  for(const options of [{},{busy:true},{displayId:'viewer'}]){
   const h=harness(options),event=h.send({target:{id:control,closest:()=>null}});
   assert.equal(event.defaultPrevented,true,control);
   assert.equal(h.state.draws,options.busy||options.displayId?0:1,control);
  }
 }
});

test('held Space is suppressed even on a focused stage control without queuing draws',()=>{
 const h=harness();
 const target={id:'reduceMotion',closest:()=>null};
 h.send({target});
 for(let i=0;i<6;i++)assert.equal(h.send({target,repeat:true}).defaultPrevented,true);
 assert.equal(h.state.draws,1);
});

test('embedded browsers that only report the Space key still dispatch and suppress native toggles',()=>{
 for(const key of [' ','Spacebar']){
  const h=harness();assert.equal(h.send({code:'',key}).defaultPrevented,true);assert.equal(h.state.draws,1);
 }
});

test('Escape closes settings before leaving page immersion and native full screen remains browser-owned',()=>{
 const settings=harness({settings:true,immersive:true});settings.send({code:'Escape'});
 assert.equal(settings.state.closed,1);assert.equal(settings.state.exited,0);
 const page=harness({immersive:true});page.send({code:'Escape'});assert.equal(page.state.exited,1);
 const native=harness({immersive:true,nativeFullscreen:true});native.send({code:'Escape'});assert.equal(native.state.exited,0);
});

test('Tab and Shift+Tab wrap inside settings, including when focus started outside',()=>{
 const h=harness({settings:true});h.document.activeElement=h.controls[1];
 assert.equal(h.send({code:'Tab'}).defaultPrevented,true);assert.equal(h.document.activeElement,h.controls[0]);
 h.send({code:'Tab',shiftKey:true});assert.equal(h.document.activeElement,h.controls[1]);
 h.document.activeElement={};h.send({code:'Tab'});assert.equal(h.document.activeElement,h.controls[0]);
 h.document.activeElement={};h.send({code:'Tab',shiftKey:true});assert.equal(h.document.activeElement,h.controls[1]);
});

test('open dialogs keep native Escape and Tab handling instead of reaching the underlying settings',()=>{
 const h=harness({modal:true,settings:true,immersive:true});
 for(const code of ['Escape','Tab','Space'])h.send({code});
 assert.equal(h.state.closed,0);assert.equal(h.state.exited,0);assert.equal(h.state.draws,0);
});

test('Space cannot accidentally stop a manual prize presentation through a held focused button',()=>{
 const h=harness({manual:true,busy:true});
 const event=h.send({target:{closest:selector=>selector==='#drawButton'?{}:null}});
 assert.equal(event.defaultPrevented,true);assert.equal(h.state.draws,0);
});
