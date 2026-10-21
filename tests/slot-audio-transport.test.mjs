import test from 'node:test';
import assert from 'node:assert/strict';
import {createThemeExperienceAudio} from '../static/v7-preview/theme-experience-audio.mjs';

function rig(fetcher){
 const starts=[],stops=[],phases=[],motions=[],pulses=[],nodes=[],decoded=[];
 const param=()=>({value:0,targets:[],cancelScheduledValues(){},setTargetAtTime(v){this.value=v;this.targets.push(v);},setValueAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;}});
 const context={currentTime:0,state:'running',destination:{},async resume(){},close(){},
  async decodeAudioData(bytes){const buffer={name:new TextDecoder().decode(bytes),duration:1.6};decoded.push(buffer);return buffer;},
  createGain(){return {gain:param(),connect(){},disconnect(){}};},
  createBiquadFilter(){return {frequency:param(),Q:param(),connect(){},disconnect(){}};},
  createStereoPanner(){return {pan:param(),connect(){},disconnect(){}};},
  createBufferSource(){const s={playbackRate:param(),connect(){},disconnect(){},start(){starts.push({name:s.buffer.name,source:s});},stop(at){stops.push({name:s.buffer.name,at});}};nodes.push(s);return s;}
 };
 const audio=createThemeExperienceAudio({contextFactory:()=>context,fetcher:fetcher||(async url=>({ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer})),onPhase:p=>phases.push(p),onMotion:m=>motions.push(m),onRhythm:r=>pulses.push(r)});
 const slotClips=Object.fromEntries(['start','roll','pulse','stop','reveal'].map(name=>[name,{url:name}]));
 return {audio,context,starts,stops,phases,motions,pulses,nodes,options:{slotClips,machine:'wheel',theme:'default'}};
}

test('reel rate and level follow physical speed, and landing permanently stops the reel',async()=>{
 const r=rig();await r.audio.prepare('unused',r.options);r.audio.start();
 assert.deepEqual(r.starts.map(s=>s.name),['start','roll']);assert.equal(r.starts[1].source.loop,true);
 r.audio.event('motion-wheel',{speed:12,phase:'spin'});const fast=r.motions.at(-1);
 r.context.currentTime=1;r.audio.event('wheel',12);
 r.audio.coast(4);r.audio.event('motion-wheel',{speed:2,phase:'reveal'});const slow=r.motions.at(-1);
 assert.ok(fast.rate>slow.rate);assert.ok(fast.gain>slow.gain);
 r.context.currentTime=2;r.audio.event('wheel',2);assert.equal(r.starts.at(-1).name,'pulse');
 r.audio.event('wheel-land',1);assert.equal(r.starts.at(-1).name,'stop');assert.ok(r.stops.some(s=>s.name==='roll'));
 const count=r.starts.length,motionCount=r.motions.length;
 r.context.currentTime=3;r.audio.event('motion-wheel',{speed:12,phase:'spin'});r.audio.event('wheel',12);r.audio.event('wheel-land',1);
 assert.equal(r.starts.length,count);assert.equal(r.motions.length,motionCount);
 assert.equal(r.audio.reveal(),true);assert.equal(r.starts.at(-1).name,'reveal');assert.equal(r.audio.reveal(),false);
 r.starts.at(-1).source.onended();assert.equal(r.phases.at(-1),'ended');r.audio.stop();
});

test('capsule exit and sphere landing use the stop layer, never an early reward',async()=>{
 for(const [machine,event] of [['capsule','capsule-exit'],['sphere','sphere-land']]){
  const r=rig();await r.audio.prepare('unused',{...r.options,machine});r.audio.start();r.audio.event(event,1);
  assert.equal(r.starts.at(-1).name,'stop');assert.ok(!r.starts.some(s=>s.name==='reveal'));
  r.audio.reveal();assert.equal(r.starts.at(-1).name,'reveal');r.audio.stop();
 }
});

test('cancelling loading and stopping playback cannot revive any slot layer',async()=>{
 const pending=[];const r=rig(url=>new Promise(resolve=>pending.push(()=>resolve({ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer}))));
 const preparing=r.audio.prepare('unused',r.options);await Promise.resolve();r.audio.stop();pending.forEach(done=>done());
 assert.equal(await preparing,false);assert.equal(r.audio.start(),false);assert.equal(r.starts.length,0);
 const s=rig();await s.audio.prepare('unused',s.options);s.audio.start();s.audio.stop();
 assert.deepEqual(s.stops.map(x=>x.name).sort(),['roll','start']);
 const count=s.starts.length;s.audio.event('wheel-land',1);assert.equal(s.audio.reveal(),false);assert.equal(s.starts.length,count);
 // Late onended must not replace stopped with ended.
 s.nodes.forEach(n=>n.onended());assert.equal(s.phases.at(-1),'stopped');
});

test('missing slot assets fail explicitly and failed downloads can be retried',async()=>{
 const r=rig();await assert.rejects(r.audio.prepare('unused',{slotClips:{}}),/资源不完整/);
 let fail=true;const s=rig(async url=>({ok:!(fail&&url==='stop'),arrayBuffer:async()=>new TextEncoder().encode(url).buffer}));
 await assert.rejects(s.audio.prepare('unused',s.options),/加载失败/);fail=false;
 assert.equal(await s.audio.prepare('unused',s.options),true);s.audio.stop();
});

for(const theme of ['default','cosmic'])test(theme+': clean mode never fetches or starts a background layer; physical rhythm remains',async()=>{
 const fetched=[];
 const r=rig(async url=>{fetched.push(url);if(url==='roll')throw new Error('removed texture must never load');return {ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer};});
 await r.audio.prepare('unused',{...r.options,theme,playback:{rollEnabled:false}});
 assert.deepEqual(fetched.sort(),['pulse','reveal','start','stop']);r.audio.start();
 for(let i=0;i<120;i++){
  r.context.currentTime=i/60;r.audio.event('motion-wheel',{phase:'spin',speed:12});
 }
 assert.deepEqual(r.starts.map(v=>v.name),['start']);assert.ok(r.motions.every(m=>m.gain===0));
 for(const [at,speed,phase] of [[2,12,'spin'],[2.15,12,'spin'],[3,2,'reveal']]){
  r.context.currentTime=at;r.audio.event('motion-wheel',{phase,speed});r.audio.event('wheel',speed);
 }
 assert.equal(r.pulses.length,3);assert.ok(r.pulses[2].interval>r.pulses[1].interval*4);
 r.audio.event('wheel-land',1);assert.equal(r.starts.at(-1).name,'stop');
 r.audio.reveal();assert.equal(r.starts.at(-1).name,'reveal');r.audio.stop();
 assert.ok(r.starts.every(v=>!v.source.loop));
});
