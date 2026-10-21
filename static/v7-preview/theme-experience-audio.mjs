// Review-only adaptive score. One source at a time with short crossfades.
// Motion can sustain; only a real machine reveal event starts the reveal/tail.
import {createMachineRhythm} from './machine-rhythm.mjs?v=machine-motion-2';
import {createSlotAudioTransport} from './slot-audio-transport.mjs?v=slot-review-3';
export function createThemeExperienceAudio({contextFactory=()=>new AudioContext(),fetcher=fetch,onPhase=()=>{},onRhythm=()=>{},onMotion=()=>{}}={}){
 let context,master,buffer,buffers,current,version=0,revealed=false,volume=.8,coastTimer=null;
 let crossfade=.14,fadeIn=.07;
 let rhythm=null,rhythmBuffer=null,bedLevel=1,rhythmLevel=1;
 let slot=null;
 const actionVoices=new Set();
 const cache=new Map(),voices=new Set();
 const clearCoast=()=>{clearTimeout(coastTimer);coastTimer=null;};
 function retire(voice,seconds=.14){
  if(!voice||(voice.retired&&seconds>=voice.retireSeconds))return;voice.retired=true;voice.retireSeconds=seconds;
  const now=context.currentTime;
  if(voice.gain.gain.cancelAndHoldAtTime)voice.gain.gain.cancelAndHoldAtTime(now);else voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0,now,seconds/6);
  voice.source.stop(now+seconds);
 }
 function segment(offset,end,loop=false,stem=''){
  if(!buffer)return;
  retire(current,crossfade);
  const source=context.createBufferSource(),gain=context.createGain(),now=context.currentTime;
  const separated=Boolean(buffers?.[stem]);
  const level=stem==='reveal'?1:bedLevel;
  source.buffer=separated?buffers[stem]:buffer;source.connect(gain);gain.connect(master);gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(stem==='motion'&&rhythmBuffer?Math.max(.85,level):level,now+fadeIn);
  if(stem==='motion'&&rhythmBuffer){gain.gain.setValueAtTime(Math.max(.85,level),now+.55);gain.gain.linearRampToValueAtTime(level,now+1.05);}
  const voice={source,gain,retired:false};voices.add(voice);current=voice;
  source.onended=()=>{source.disconnect();gain.disconnect();voices.delete(voice);if(current===voice){current=null;onPhase('ended');}};
  if(loop&&!separated){source.loop=true;source.loopStart=2.4;source.loopEnd=8.8;source.start(now,offset);}
  else{const duration=separated?source.buffer.duration:end-offset;gain.gain.setValueAtTime(level,now+Math.max(fadeIn,duration-.12));gain.gain.linearRampToValueAtTime(0,now+duration);source.start(now,separated?0:offset,duration);}
 }
 function stop(){version++;clearCoast();slot?.stop();slot=null;rhythm?.stop();revealed=false;buffer=null;buffers=null;rhythmBuffer=null;current=null;for(const voice of voices)retire(voice);onPhase('stopped');}
 function playAction(cue){
  if(!rhythmBuffer||!context||!cue)return;
  while(actionVoices.size>=6){const old=actionVoices.values().next().value;actionVoices.delete(old);retire(old,.04);}
  const source=context.createBufferSource(),gain=context.createGain(),pan=context.createStereoPanner?.(),now=context.currentTime;
  source.buffer=rhythmBuffer;source.playbackRate.value=cue.rate;
  source.connect(gain);if(pan){pan.pan.value=cue.pan;gain.connect(pan);pan.connect(master);}else gain.connect(master);
  gain.gain.value=cue.gain*rhythmLevel;
  const voice={source,gain,retired:false};voices.add(voice);actionVoices.add(voice);
  source.onended=()=>{source.disconnect();gain.disconnect();pan?.disconnect();voices.delete(voice);actionVoices.delete(voice);};
  source.start(now);onRhythm(cue);
 }
 function decode(url){
  if(!cache.has(url))cache.set(url,fetcher(url).then(response=>{if(!response.ok)throw new Error('音效加载失败，请重试。');return response.arrayBuffer();}).then(bytes=>context.decodeAudioData(bytes)).catch(error=>{cache.delete(url);throw error;}));
  return cache.get(url);
 }
 return {
  async prepare(url,{slotClips,adaptiveClips,playback,rhythmClip,machine='capsule',theme='default'}={}){
   stop();const id=version;
   if(!context){context=contextFactory();master=context.createGain();master.gain.value=volume;master.connect(context.destination);}
   // Resume in the click/keyboard activation, before waiting for network I/O.
   await context.resume();if(context.state!=='running')throw new Error('音频未启动，请再点一次开始。');
   if(slotClips){
    const layers=playback?.rollEnabled===false?['start','pulse','stop','reveal']:['start','roll','pulse','stop','reveal'];
    const entries=await Promise.all(layers.map(async name=>{
     if(!slotClips[name]?.url)throw new Error('音效资源不完整，请刷新重试。');
     return [name,await decode(slotClips[name].url)];
    }));
    if(id!==version)return false;
    slot=createSlotAudioTransport({context,master,clips:Object.fromEntries(entries),machine,theme,playback,onPhase,onRhythm,onMotion});return true;
   }
   let decoded,stems=null;
   if(adaptiveClips){
    const entries=await Promise.all(['motion','coast','reveal'].map(async name=>{
     if(!adaptiveClips[name]?.url)throw new Error('音效资源不完整，请刷新重试。');
     return [name,await decode(adaptiveClips[name].url)];
    }));
    stems=Object.fromEntries(entries);decoded=stems.motion;
   }else decoded=await decode(url);
   const action=rhythmClip?.url?await decode(rhythmClip.url):null;
   if(id!==version)return false;
   buffer=decoded;buffers=stems;rhythmBuffer=action;rhythm=createMachineRhythm(machine,theme);
   bedLevel=action?Math.max(.1,Math.min(1,Number(playback?.bedLevel)||.42)):1;rhythmLevel=Number(playback?.rhythmLevel)||1;
   crossfade=stems?Math.max(.14,Math.min(.8,Number(playback?.crossfadeSeconds)||.48)):.14;fadeIn=stems?Math.max(.04,Math.min(.3,Number(playback?.fadeInSeconds)||.12)):.07;return true;
  },
  start(){if(slot)return slot.start();if(!buffer)return false;revealed=false;rhythm?.start();segment(0,8.8,true,'motion');onPhase('motion');return true;},
  event(kind,value){if(slot){slot.event(kind,value);return;}if(!buffer||revealed||!rhythmBuffer)return;playAction(rhythm.event(kind,value,context.currentTime));},
  coast(expectedSeconds){
   if(slot){slot.coast();return;}
   const id=version;clearCoast();
   coastTimer=setTimeout(()=>{if(id!==version||revealed||!buffer)return;segment(8.8,11.8,false,'coast');onPhase('coast');},Math.max(0,expectedSeconds-3)*1000);
  },
  reveal(){if(slot)return slot.reveal();if(!buffer||revealed)return false;revealed=true;clearCoast();rhythm?.stop();for(const voice of actionVoices)retire(voice,.09);segment(11.8,16,false,'reveal');onPhase('reveal');return true;},
  volume(value){volume=Math.max(0,Math.min(1,Number(value)||0));if(master)master.gain.setTargetAtTime(volume,context.currentTime,.02);},
  stop,
  dispose(){stop();cache.clear();context?.close();}
 };
}
