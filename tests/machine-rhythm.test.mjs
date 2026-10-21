import test from 'node:test';
import assert from 'node:assert/strict';
import {createMachineRhythm} from '../static/v7-preview/machine-rhythm.mjs';
import {stepCapsules} from '../static/v6/motion.mjs';

for(const theme of ['default','cosmic']){
 test(theme+': sphere cadence follows angular travel through acceleration and coast, not wall clock',()=>{
  const engine=createMachineRhythm('sphere',theme);engine.start();
  let angle=0;const fast=[],slow=[];
  for(let frame=0;frame<720;frame++){
   const t=frame/60,speed=t<6?6.4:.8;angle+=speed/60;
   const cue=engine.event('motion-sphere',{angle,speed,phase:t<6?'spin':'reveal'},t);
   if(cue)(t<6?fast:slow).push(cue);
  }
  assert.ok(fast.length>=22);assert.ok(slow.length>=2&&slow.length<=4);
  assert.ok(slow.at(-1).interval>fast.at(-1).interval*5);
  for(let i=0;i<100;i++)assert.equal(engine.event('motion-sphere',{angle,speed:0,phase:'reveal'},13+i),null);
 });
 test(theme+': wheel sounds only on physical crossings, slowing crossings spread the rhythm',()=>{
  const engine=createMachineRhythm('wheel',theme);engine.start();
  for(let i=0;i<60;i++)assert.equal(engine.event('motion-wheel',{speed:12,phase:'spin',angle:i/10},i/60),null);
  const beats=[];
  for(const [t,speed,phase] of [[1,12,'spin'],[1.14,12,'spin'],[1.28,12,'spin'],[1.56,6,'reveal'],[2.06,3,'reveal'],[2.96,1,'reveal']]){
   engine.event('motion-wheel',{speed,phase},t);const cue=engine.event('wheel',speed,t);if(cue)beats.push(cue);
  }
  assert.equal(beats.length,6);assert.ok(beats.at(-1).interval>beats[1].interval*5);
  engine.event('wheel-land',1,3.1);assert.equal(engine.event('wheel',12,4),null);
 });
 test(theme+': capsule uses impact strength, rejects idle contacts and stops at exit',()=>{
  const engine=createMachineRhythm('capsule',theme);engine.start();
  assert.equal(engine.event('capsule-impact',{strength:1,pan:.2},0),null);
  engine.event('motion-capsule',{phase:'spin',speed:.8},0);
  assert.equal(engine.event('capsule',.8,.1),null);
  assert.equal(engine.event('capsule-impact',{strength:.05,pan:0},.2),null);
  const soft=engine.event('capsule-impact',{strength:.4,pan:-.2},.3);
  assert.equal(engine.event('capsule-impact',{strength:1,pan:.2},.31),null);
  const hard=engine.event('capsule-impact',{strength:2,pan:.2},.7);assert.ok(hard.gain>soft.gain);
  assert.equal(engine.event('capsule-exit',1,1).kind,'exit');assert.equal(engine.event('capsule-impact',{strength:2},2),null);
 });
}
test('optional capsule collision feedback reports impacts without changing simulated motion',()=>{
 const initial=[{position:{x:-.2,y:.78,z:0},userData:{i:0,velocity:{x:1,y:0,z:0}}},{position:{x:.2,y:.78,z:0},userData:{i:1,velocity:{x:-1,y:0,z:0}}}];
 const withFeedback=structuredClone(initial),withoutFeedback=structuredClone(initial),impact={strength:0,pan:0};
 stepCapsules(withFeedback,1/120,.8,1,impact);stepCapsules(withoutFeedback,1/120,.8,1);
 assert.deepEqual(withFeedback,withoutFeedback);assert.ok(impact.strength>.2);assert.ok(Number.isFinite(impact.pan));
});
