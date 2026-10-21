import {createMachineRhythm} from './machine-rhythm.mjs?v=machine-motion-2';
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const number=(v,fallback,min,max)=>Number.isFinite(Number(v))?clamp(Number(v),min,max):fallback;

// Review-only event layers. Continuous texture is optional; clean auditions
// schedule only musical events on physical crossings, landing and reveal.
export function createSlotAudioTransport({context,master,clips,machine,theme,playback={},onPhase=()=>{},onRhythm=()=>{},onMotion=()=>{}}){
 const voices=new Set(),rhythm=createMachineRhythm(machine,theme);
 let active=false,landed=false,revealed=false,loop=null,sequence=0;
 const maxSpeed=machine==='wheel'?12:machine==='sphere'?6.4:1;
 const rollLevel=number(playback.rollLevel,.8,0,1),pulseLevel=number(playback.rhythmLevel,.85,0,1);
 const rollEnabled=playback.rollEnabled!==false&&Boolean(clips.roll);
 const lowRate=number(playback.rateMin,.55,.25,1),highRate=number(playback.rateMax,1.5,1,2);
 const lowCutoff=number(playback.cutoffMin,650,200,2000),highCutoff=number(playback.cutoffMax,3500,2000,6000);
 const rates=Array.isArray(playback.pulseRates)&&playback.pulseRates.length?playback.pulseRates.map(v=>number(v,1,.5,2)):[1];
 function retire(voice,seconds=.12){
  if(!voice||voice.retired)return;voice.retired=true;
  const now=context.currentTime,param=voice.gain.gain;
  if(param.cancelAndHoldAtTime)param.cancelAndHoldAtTime(now);else param.cancelScheduledValues(now);
  param.setTargetAtTime(0,now,seconds/6);voice.source.stop(now+seconds);
 }
 function voice(name,{level=1,rate=1,pan=0,repeat=false,ended}={}){
  const source=context.createBufferSource(),gain=context.createGain();
  const panner=context.createStereoPanner?.(),filter=repeat?context.createBiquadFilter?.():null;
  source.buffer=clips[name];source.playbackRate.value=rate;gain.gain.value=level;
  source.connect(gain);
  let output=gain;
  if(filter){filter.type='lowpass';filter.frequency.value=lowCutoff;filter.Q.value=.3;output.connect(filter);output=filter;}
  if(panner){panner.pan.value=pan;output.connect(panner);output=panner;}
  output.connect(master);
  const v={source,gain,filter,panner,retired:false};voices.add(v);
  source.onended=()=>{source.disconnect();gain.disconnect();filter?.disconnect();panner?.disconnect();voices.delete(v);if(!v.retired&&active)ended?.();};
  if(repeat){source.loop=true;source.loopStart=0;source.loopEnd=clips[name].duration;}
  source.start(context.currentTime);
  return v;
 }
 function updateMotion(value){
  if(landed||!['spin','reveal'].includes(value?.phase))return;
  const speed=clamp(Number(value?.speed)||0,0,maxSpeed),fraction=speed/maxSpeed;
  if(!loop){onMotion({speed,rate:0,gain:0,phase:value.phase});return;}
  const rate=lowRate+(highRate-lowRate)*fraction;
  const gain=rollLevel*fraction**.65;
  const now=context.currentTime;
  loop.source.playbackRate.setTargetAtTime(rate,now,.075);
  loop.gain.gain.setTargetAtTime(gain,now,.055);
  loop.filter?.frequency.setTargetAtTime(lowCutoff+(highCutoff-lowCutoff)*fraction,now,.09);
  onMotion({speed,rate,gain,phase:value.phase});
 }
 return {
  start(){
   if(active)return false;active=true;landed=false;revealed=false;sequence=0;rhythm.start();
   voice('start');if(rollEnabled)loop=voice('roll',{level:0,rate:lowRate,repeat:true});onPhase('motion');return true;
  },
  event(kind,value){
   if(!active||revealed)return;
   if(kind===`motion-${machine}`)updateMotion(value);
   const cue=rhythm.event(kind,value,context.currentTime);if(!cue)return;
   if(cue.kind==='land'||cue.kind==='exit'){
    landed=true;retire(loop,.16);loop=null;
    for(const v of voices)if(v.pulse)retire(v,.06);
    voice('stop');onMotion({speed:0,rate:0,gain:0,phase:'landed'});
   }else{
    // Bound overlaps during dense collisions and avoid accumulated old pulses.
    const pulses=[...voices].filter(v=>v.pulse&&!v.retired);
    if(pulses.length>=5)retire(pulses[0],.025);
    const v=voice('pulse',{level:cue.gain*pulseLevel,rate:rates[sequence++%rates.length],pan:cue.pan});v.pulse=true;
   }
   onRhythm(cue);
  },
  coast(){if(active&&!revealed)onPhase('coast');},
  reveal(){
   if(!active||revealed)return false;revealed=true;rhythm.stop();
   for(const v of voices)retire(v,.09);loop=null;
   onMotion({speed:0,rate:0,gain:0,phase:'reveal'});
   voice('reveal',{ended:()=>onPhase('ended')});onPhase('reveal');return true;
  },
  stop(){active=false;landed=true;revealed=true;rhythm.stop();for(const v of voices)retire(v,.10);loop=null;onMotion({speed:0,rate:0,gain:0,phase:'stopped'});}
 };
}
