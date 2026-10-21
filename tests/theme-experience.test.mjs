import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoundGate,resolveExperience,parseNames,isRevealEvent,expectedRevealSeconds} from '../static/v7-preview/theme-experience-state.mjs';
import {createThemeExperienceAudio} from '../static/v7-preview/theme-experience-audio.mjs';

test('cancelled preparation and landing cannot publish a stale result or overlap a new round',()=>{
 const gate=createRoundGate(),first=gate.begin();assert.equal(gate.begin(),null);
 gate.cancel();const second=gate.begin();assert.equal(gate.active(first),false);assert.equal(gate.set(first,'result'),false);assert.equal(gate.phase,'loading');
 assert.equal(gate.set(second,'running'),true);assert.equal(gate.begin(),null);gate.set(second,'result');assert.notEqual(gate.begin(),null);
});
test('deep links honor theme boundaries and saved choices',()=>{
 assert.deepEqual(resolveExperience(new URLSearchParams('theme=default&machine=sphere&sound=slot-default3')),{theme:'default',machine:'sphere',candidate:'slot-default3'});
 assert.equal(resolveExperience(new URLSearchParams('theme=default&sound=cosmic2'),{default:'slot-default2'}).candidate,'slot-default2');
 assert.deepEqual(resolveExperience(new URLSearchParams('theme=invalid&machine=constructor&sound=a')),{theme:'cosmic',machine:'capsule',candidate:'slot-cosmic1'});
 assert.equal(resolveExperience(new URLSearchParams('theme=cosmic&sound=cosmic1'),{cosmic:'cosmic1'}).candidate,'slot-cosmic1');
});
test('reveal only matches the selected machine physical event',()=>{
 assert.equal(isRevealEvent('capsule','capsule-open'),true);assert.equal(isRevealEvent('capsule','capsule-exit'),false);
 assert.equal(isRevealEvent('wheel','wheel-land'),false);assert.equal(isRevealEvent('wheel','wheel-reveal'),true);
 assert.equal(isRevealEvent('sphere','sphere-reveal'),true);assert.equal(isRevealEvent('sphere','wheel-reveal'),false);
 assert.equal(expectedRevealSeconds('capsule',4200),3.3);assert.equal(expectedRevealSeconds('wheel',4500),4.5);assert.ok(Math.abs(expectedRevealSeconds('sphere',4100)-3.7)<.00001);
});
test('custom choices reject empty, excessive and overlong lists',()=>{
 assert.deepEqual(parseNames(' 火锅\n\n寿司\r\n火锅 '),['火锅','寿司']);
 for(const text of ['', '单个',Array(49).fill('选项').join('\n'),'字'.repeat(19)+'\n另一个'])assert.throws(()=>parseNames(text));
});
function rig(fetcher){
 const starts=[],stops=[],phases=[],nodes=[];
 const parameter=()=>({value:0,cancelScheduledValues(){},setTargetAtTime(){},setValueAtTime(){},linearRampToValueAtTime(){}});
 const context={currentTime:0,state:'running',destination:{},async resume(){},async decodeAudioData(){return {duration:16};},close(){},createGain(){return {gain:parameter(),connect(){},disconnect(){}};},createBufferSource(){const source={playbackRate:{value:1},connect(){},disconnect(){},start(...args){starts.push({args,loop:source.loop,loopStart:source.loopStart,loopEnd:source.loopEnd});},stop(t){stops.push(t);}};nodes.push(source);return source;}};
 const audio=createThemeExperienceAudio({contextFactory:()=>context,fetcher:fetcher|| (async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(2)})),onPhase:p=>phases.push(p)});
 return {audio,starts,stops,phases,nodes,context};
}
test('adaptive score sustains motion and reveals once, including tail, only on cue',async()=>{
 const {audio,starts,stops}=rig();await audio.prepare('default1.mp3');assert.equal(audio.start(),true);
 assert.deepEqual(starts[0],{args:[0,0],loop:true,loopStart:2.4,loopEnd:8.8});
 audio.coast(4);assert.equal(audio.reveal(),true);assert.equal(audio.reveal(),false);
 assert.equal(starts.length,2);assert.equal(starts[1].args[1],11.8);assert.ok(Math.abs(starts[1].args[2]-4.2)<.001);
 audio.stop();assert.ok(stops.length>=2);assert.equal(audio.reveal(),false);
});
test('stop while decoding cannot revive sound; a failed download can be retried',async()=>{
 let complete;const delayed=rig(()=>new Promise(resolve=>{complete=resolve;}));
 const pending=delayed.audio.prepare('one');await Promise.resolve();delayed.audio.stop();complete({ok:true,arrayBuffer:async()=>new ArrayBuffer(2)});
 assert.equal(await pending,false);assert.equal(delayed.audio.start(),false);assert.equal(delayed.starts.length,0);
 let attempt=0;const retry=rig(async()=>({ok:++attempt>1,arrayBuffer:async()=>new ArrayBuffer(2)}));
 await assert.rejects(retry.audio.prepare('two'));assert.equal(await retry.audio.prepare('two'),true);
});
test('coast schedule is cancelled on stop and never reappears in a new round',async()=>{
 const {audio,starts}=rig();await audio.prepare('one');audio.start();audio.coast(3);audio.stop();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(starts.length,1);
 await audio.prepare('two');audio.start();audio.coast(3);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(starts.at(-1).args[1],8.8);audio.stop();
});

test('separated stems begin at zero and never cut a sustain into a pitch-discontinuous loop',async()=>{
 const {audio,starts,context}=rig();
 const adaptiveClips=Object.fromEntries(['motion','coast','reveal'].map(name=>[name,{url:name+'.mp3'}]));
 await audio.prepare('full.mp3',{adaptiveClips,rhythmClip:{url:'pulse.mp3'},machine:'wheel',theme:'cosmic',playback:{crossfadeSeconds:.48,bedLevel:.42}});
 audio.start();assert.equal(starts[0].loop,undefined);assert.equal(starts[0].args[1],0);
 context.currentTime=1;audio.event('motion-wheel',{phase:'spin',speed:12});audio.event('wheel',12);assert.equal(starts.length,2);
 audio.reveal();assert.equal(starts.at(-1).args[1],0);
 const after=starts.length;context.currentTime=2;audio.event('wheel',12);assert.equal(starts.length,after);
 audio.stop();context.currentTime=3;audio.event('wheel',12);assert.equal(starts.length,after);
});
