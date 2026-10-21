import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createGameAudio} from '../static/v7-preview/game-audio-runtime.mjs';
import {CANDIDATES,actionCue,validCandidate,validMachine} from '../static/v7-preview/game-audio-score.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../static/v7-preview/game-audio/manifest.json',import.meta.url),'utf8'));
class Param {value=0;setTargetAtTime(v){this.value=v;}cancelAndHoldAtTime(){}}
class Node {gain=new Param();playbackRate=new Param();threshold=new Param();knee=new Param();ratio=new Param();attack=new Param();release=new Param();connect(n){this.target=n;}disconnect(){this.disconnected=true;}start(t){this.startTime=t;}stop(t=0){this.stopTime=t;}}
class Context {currentTime=1;state='suspended';destination={};sources=[];createGain(){return new Node();}createDynamicsCompressor(){return new Node();}createBufferSource(){const n=new Node();this.sources.push(n);return n;}resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}decodeAudioData(data){return Promise.resolve(data);}advance(t){this.currentTime+=t;for(const n of this.sources)if(n.stopTime<=this.currentTime&&!n.disconnected)n.onended?.();}}
function setup(){const ctx=new Context(),requests=[];let fail=false;const audio=createGameAudio({contextFactory:()=>ctx,fetcher:async url=>{requests.push(url);if(fail)throw Error('offline');return {ok:true,json:async()=>manifest,arrayBuffer:async()=>url};}});return {ctx,audio,requests,setFail:v=>fail=v};}
test('all four packs contain valid, distinct assets and comparable mastered reels',()=>{
 const expected=['press','start','capsule-hit-0','capsule-hit-1','capsule-hit-2','capsule-roll','wheel-tick','sphere-pass','rise','exit','land','open','reveal','return'];
 const levels=[];
 for(const key of Object.keys(CANDIDATES)){
  const pack=manifest.candidates[key];assert.ok(pack.runtimeGain<=3.5&&pack.runtimeGain>0);assert.deepEqual(Object.keys(pack.cues),expected);
  for(const clip of [...Object.values(pack.cues),pack.reel]){const file=new URL('../static/v7-preview/'+clip.url.slice(2),import.meta.url);assert.ok(fs.existsSync(file));assert.equal(fs.readFileSync(file).subarray(0,4).toString(),'OggS');}
  assert.ok(Math.abs(pack.reel.measuredLUFS+18)<.15);assert.ok(pack.reel.truePeakDbTP<=-1.5);levels.push(pack.reel.measuredLUFS);
 }
 assert.ok(Math.max(...levels)-Math.min(...levels)<.15);assert.deepEqual(manifest.themeAssignments,{default:null,cosmic:null});
});
test('candidate and machine URL inputs use safe defaults',()=>{for(const value of ['__proto__','constructor',null,'invalid']){assert.equal(validCandidate(value),'a');assert.equal(validMachine(value),'capsule');}});
test('gesture setup, asset cache and machine event variants work without autoplay',async()=>{
 const {ctx,audio,requests}=setup();assert.equal(ctx.sources.length,0);await audio.arm();await audio.prepare('a');const fetched=requests.length;await audio.prepare('a');assert.equal(requests.length,fetched);
 for(const machine of ['capsule','wheel','sphere']){audio.select('a',machine);audio.event(machine+'-start');ctx.advance(.2);audio.event(machine,1);assert.ok(ctx.sources.some(n=>n.buffer.endsWith('a-'+actionCue(machine,0)+'.ogg')));}audio.dispose();
});
test('rapid action events are bounded and reveal is only played once',async()=>{
 const {ctx,audio}=setup();await audio.arm();await audio.prepare('a');audio.select('a','wheel');audio.event('wheel-start');
 for(let i=0;i<1000;i++){ctx.advance(.001);audio.event('wheel',9);assert.ok(audio.status().nodes<=14);}
 assert.ok(ctx.sources.length<=13);audio.event('wheel-reveal');audio.event('wheel-reveal');assert.equal(ctx.sources.filter(n=>n.buffer.endsWith('reveal.ogg')).length,1);audio.dispose();
});
test('stop rejects late events and safely releases scheduled audio',async()=>{
 const {ctx,audio}=setup();await audio.arm();await audio.prepare('d');audio.select('d','capsule');audio.event('capsule-start');audio.stop();const count=ctx.sources.length;ctx.advance(.1);audio.event('capsule-open');audio.event('capsule-start');assert.equal(ctx.sources.length,count);assert.equal(audio.status().nodes,0);audio.dispose();
});
test('zero volume and failed assets do not pretend to play; failed load can retry',async()=>{
 const {ctx,audio,setFail}=setup();await audio.arm();setFail(true);await assert.rejects(audio.prepare('b'));setFail(false);await audio.prepare('b');audio.select('b','sphere');audio.setVolume(0);audio.event('sphere-start');assert.equal(ctx.sources.length,0);audio.setVolume(.8);audio.event('sphere-start');assert.equal(ctx.sources.length,2);audio.dispose();
});
test('theme candidate change cannot retain the prior sample bank in new playback',async()=>{
 const {ctx,audio}=setup();await audio.arm();await audio.prepare('a');await audio.prepare('c');audio.select('a','wheel');audio.event('wheel-start');audio.select('c','wheel');ctx.advance(.1);const before=ctx.sources.length;audio.reward();assert.ok(ctx.sources.slice(before).every(n=>n.buffer.includes('/c-')));audio.dispose();
});
