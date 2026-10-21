import test from 'node:test';
import assert from 'node:assert/strict';
import {createStellarAudio} from '../static/v7-preview/stellar-audio.mjs';
import {SOUND_STYLES,validSoundStyle} from '../static/v7-preview/stellar-audio-profiles.mjs';
class Param {
 calls=[];value=0;
 setValueAtTime(v,t){this.value=v;this.calls.push(['set',v,t]);}
 linearRampToValueAtTime(v,t){this.calls.push(['ramp',v,t]);}
 exponentialRampToValueAtTime(v,t){this.calls.push(['decay',v,t]);}
 setTargetAtTime(v,t,c){this.calls.push(['target',v,t,c]);}
 cancelAndHoldAtTime(t){this.calls.push(['hold',t]);}
}
class Node {
 gain=new Param();frequency=new Param();Q=new Param();threshold=new Param();knee=new Param();ratio=new Param();attack=new Param();release=new Param();
 connect(target){this.target=target;}disconnect(){this.disconnected=true;}
 start(t){this.startTime=t;}stop(t=0){this.stopTime=t;}
}
class Context {
 currentTime=1;state='running';destination={};oscillators=[];
 createGain(){return new Node();}createBiquadFilter(){return new Node();}createDynamicsCompressor(){return new Node();}
 createOscillator(){const n=new Node();this.oscillators.push(n);return n;}
 createBufferSource(){throw new Error('Noise sources must not exist in the tonal preview');}
 resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
 advance(seconds){this.currentTime+=seconds;for(const n of this.oscillators)if(n.stopTime<=this.currentTime&&!n.disconnected)n.onended?.();}
 live(){return this.oscillators.filter(n=>!n.disconnected);}
}
const setup=()=>{const ctx=new Context();return {ctx,audio:createStellarAudio({contextFactory:()=>ctx})};};
test('preview remains silent until a gesture, with safe style fallback',async()=>{
 let made=0;const audio=createStellarAudio({contextFactory:()=>{made++;return new Context();}});
 audio.event('capsule-start');assert.equal(made,0);assert.equal(audio.style(),'aurora');
 for(const value of [null,'toString','__proto__','missing'])assert.equal(validSoundStyle(value),'aurora');
 audio.arm();assert.equal(await audio.whenReady(),true);assert.equal(made,1);audio.dispose();
});
test('all four palettes stay sparse under a dense collision stream and contain only tonal voices',()=>{
 for(const style of Object.keys(SOUND_STYLES)){
  const {ctx,audio}=setup();audio.select('capsule','cosmic',style);audio.arm();audio.event('capsule-start');
  for(let i=0;i<600;i++){ctx.advance(.01);audio.event('motion-capsule',{phase:'spin',speed:1});audio.event('capsule',1);assert.ok(ctx.live().length<=14);}
  assert.ok(ctx.oscillators.length<48,'dense contact events must not create a wall of ticks');
  assert.ok(ctx.oscillators.every(n=>n.type==='sine'));audio.stop();ctx.advance(.09);assert.equal(ctx.live().length,0);
 }
});
test('style switching releases old audio before subsequent motion can resume it',()=>{
 const {ctx,audio}=setup();audio.arm();audio.select('sphere','cosmic','crystal');audio.event('sphere-start');const old=[...ctx.oscillators];
 audio.select('wheel','cosmic','orbit');ctx.advance(.09);assert.ok(old.every(n=>n.disconnected));
 audio.event('motion-wheel',{phase:'spin',speed:8});audio.event('wheel');assert.equal(ctx.live().length,0);
 audio.event('wheel-start');assert.equal(ctx.oscillators.at(-2).frequency.value,SOUND_STYLES.orbit.pad[0]);audio.dispose();
});
test('delayed resume accepts current motion, but never resurrects a stopped audition',async()=>{
 for(const stop of [false,true]){
  const {ctx,audio}=setup();ctx.state='suspended';let resolve;ctx.resume=()=>new Promise(r=>resolve=r);
  audio.arm();audio.event('wheel-start');audio.event('wheel');if(stop)audio.stop();
  ctx.state='running';resolve();await audio.whenReady();assert.equal(ctx.oscillators.length,0);
  audio.event('motion-wheel',{phase:'spin',speed:8});assert.equal(ctx.live().length,stop?0:2);audio.dispose();
 }
});
test('mute, zero volume and background stop suppress even late reveal events',()=>{
 for(const shutdown of ['mute','zero','stop']){
  const {ctx,audio}=setup();audio.arm();audio.event('capsule-start');
  if(shutdown==='mute')audio.setEnabled(false);else if(shutdown==='zero')audio.setVolume(0);else audio.stop();
  ctx.advance(.1);const created=ctx.oscillators.length;audio.event('capsule-open');audio.event('capsule');audio.event('motion-capsule',{phase:'spin',speed:1});
  assert.equal(ctx.live().length,0);assert.equal(ctx.oscillators.length,created);audio.dispose();
 }
});
test('reveals end motion without replaying collisions and settle into silence',()=>{
 const {ctx,audio}=setup();audio.arm();audio.event('wheel-start');audio.event('wheel-reveal');const created=ctx.oscillators.length;
 audio.event('wheel-reveal');audio.event('wheel',1);assert.equal(ctx.oscillators.length,created);
 ctx.advance(2);assert.equal(ctx.live().length,0);audio.dispose();
});
test('failed audio activation can retry without manufacturing a ready status',async()=>{
 const {ctx,audio}=setup();ctx.state='suspended';ctx.resume=()=>Promise.reject(new Error('blocked'));audio.arm();assert.equal(await audio.whenReady(),false);assert.equal(audio.status(),'failed');
 ctx.resume=()=>{ctx.state='running';return Promise.resolve();};audio.arm();assert.equal(await audio.whenReady(),true);audio.event('sphere-start');assert.ok(ctx.live().length>0);audio.dispose();
});
test('machine action voices remain distinct and lead every selected space palette',()=>{
 const signatures=[];
 for(const machine of ['capsule','wheel','sphere']){
  let baseline;
  for(const style of Object.keys(SOUND_STYLES)){
   const {ctx,audio}=setup();audio.select(machine,'cosmic',style);audio.arm();audio.event(machine+'-start');ctx.advance(1.7);
   const before=ctx.oscillators.length;audio.event(machine,1);const action=ctx.oscillators[before];
   const level=action.target.gain.calls.find(c=>c[0]==='ramp')[1];
   const fingerprint=[action.frequency.value,action.stopTime-action.startTime,level];
   if(!baseline)baseline=fingerprint;else assert.deepEqual(fingerprint,baseline,'changing ambience must preserve the machine action');
   for(const accent of ctx.oscillators.slice(before+1))assert.ok(accent.target.gain.calls.find(c=>c[0]==='ramp')[1]<level,'ambience must not cover the action voice');
   audio.dispose();
  }
  signatures.push(JSON.stringify(baseline));
 }
 assert.equal(new Set(signatures).size,3,'capsule, wheel and sphere must have distinct action timbres');
});
