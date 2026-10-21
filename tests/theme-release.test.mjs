import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createSoundRuntime} from '../static/v7/game-audio.mjs';
import {SOUND_PRESETS,themeSounds,soundFor} from '../static/v7/sound-catalog.mjs';

function rig(fetcher){
 const starts=[],stops=[],gains=[],fetched=[];
 const param=()=>({value:0,setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}});
 const ctx={state:'running',currentTime:0,destination:{},resume:async()=>{},close(){},decodeAudioData:async bytes=>({name:new TextDecoder().decode(bytes),duration:4.2}),
  createGain(){const n={gain:param(),connect(){},disconnect(){}};gains.push(n);return n;},
  createBufferSource(){const n={playbackRate:param(),connect(){},disconnect(){},start(){starts.push(n.buffer.name);},stop(){stops.push(n.buffer.name);}};return n;}};
 const runtime=createSoundRuntime(()=>ctx,()=>{},fetcher|| (async url=>{fetched.push(url);return {ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer};}));
 return {runtime,ctx,starts,stops,gains,fetched};
}

test('six production presets are byte-identical to approved v3 and have only four runtime layers',()=>{
 const approved=JSON.parse(fs.readFileSync(new URL('../static/v7-preview/theme-audio/manifest.json',import.meta.url)));
 assert.equal(Object.keys(SOUND_PRESETS).length,6);
 for(const [id,p]of Object.entries(SOUND_PRESETS)){
  assert.equal(p.playback.rollEnabled,false);assert.deepEqual(Object.keys(p.slotClips).sort(),['pulse','reveal','start','stop']);
  for(const [key,clip]of Object.entries(p.slotClips)){
   const bytes=fs.readFileSync(new URL('../static'+clip.url,import.meta.url));
   assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),approved.candidates[id].slotClips[key].sha256);
  }
 }
 assert.equal(themeSounds('classic').length,3);assert.equal(themeSounds('cosmic').length,3);
 assert.equal(soundFor('classic','slot-cosmic2'),'slot-default1');assert.equal(soundFor('cosmic',''),'slot-cosmic1');
});

for(const [theme,sound]of [['classic','slot-default2'],['cosmic','slot-cosmic3']])test(`${theme}: complete draw follows motion, lands and reveals once; never loads hum`,async()=>{
 const r=rig();r.runtime.configure({theme,machine:'wheel',sound});r.runtime.arm();assert.equal(await r.runtime.whenReady(),true);
 assert.equal(r.fetched.length,4);assert.ok(r.fetched.every(url=>url.includes(sound)&&!url.includes('roll')));
 assert.equal(r.runtime.play('wheel-reveal'),false);assert.equal(r.starts.length,0);
 r.runtime.play('wheel-start',1);r.runtime.play('wheel',12);r.ctx.currentTime=8;r.runtime.play('wheel',2);r.runtime.play('wheel-land',1);
 r.runtime.play('wheel-reveal',1);r.runtime.finish();
 assert.equal(r.starts.filter(url=>url.endsWith('-reveal.mp3')).length,1);
 assert.equal(r.starts.filter(url=>url.endsWith('-stop.mp3')).length,1);
 assert.equal(r.starts.filter(url=>url.endsWith('-pulse.mp3')).length,2);
 r.runtime.stop();const count=r.starts.length;r.runtime.play('wheel-start');assert.equal(r.starts.length,count);
 r.runtime.arm();assert.equal(await r.runtime.whenReady(),true);r.runtime.play('wheel-start');assert.equal(r.fetched.length,4);assert.equal(r.starts.length,count+1);
});

test('hiding or muting cancels an in-flight preparation and prevents late playback',async()=>{
 for(const cancel of ['setHidden','setMuted']){
  const pending=[];const r=rig(url=>new Promise(resolve=>pending.push(()=>resolve({ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer}))));
  r.runtime.arm();r.runtime[cancel](true);pending.forEach(done=>done());assert.equal(await r.runtime.whenReady(),false);
  assert.equal(r.runtime.play('capsule-start'),false);assert.equal(r.starts.length,0);
 }
});

test('short audition does not activate physical motion; hidden audio stays stopped on return',async()=>{
 const r=rig();r.runtime.volume(.47);assert.equal(await r.runtime.audition(),true);
 assert.equal(r.starts.length,1);assert.match(r.starts[0],/-reveal.mp3$/);
 r.runtime.play('capsule-impact',{strength:2});assert.equal(r.starts.length,1);
 r.runtime.setHidden(true);r.runtime.setHidden(false);assert.equal(r.runtime.play('capsule-start'),false);assert.equal(r.gains[0].gain.value,.47);
});

test('failed audio reports unavailable and can retry; preset change invalidates old preparation',async()=>{
 let fail=true;const r=rig(async url=>({ok:!fail,arrayBuffer:async()=>new TextEncoder().encode(url).buffer}));
 r.runtime.arm();assert.equal(await r.runtime.whenReady(),false);assert.equal(r.runtime.status(),'unavailable');
 fail=false;r.runtime.arm();assert.equal(await r.runtime.whenReady(),true);
 r.runtime.configure({theme:'cosmic',machine:'sphere',sound:'slot-cosmic2'});assert.equal(r.runtime.play('capsule-start'),false);
 r.runtime.arm();await r.runtime.whenReady();r.runtime.play('sphere-start');assert.match(r.starts.at(-1),/slot-cosmic2-v3-start/);
});
