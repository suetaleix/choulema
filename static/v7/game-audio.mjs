import {SOUND_PRESETS,soundFor} from './sound-catalog.mjs?v=theme-release-1';
import {createSlotAudioTransport} from './slot-audio-transport.mjs?v=theme-release-1';

// Gesture-owned loading; stale requests can never start sound after a change.
export function createSoundRuntime(contextFactory=()=>new AudioContext(),onState=()=>{},fetcher=fetch,onPhase=()=>{}){
 let context,master,transport,version=0,ready=Promise.resolve(false),muted=false,hidden=false,state='idle',volume=.8;
 let selection={theme:'classic',machine:'capsule',sound:'slot-default1'},active=false;
 const cache=new Map();
 const status=()=>muted?'muted':hidden?'hidden':state;
 const publish=()=>onState(status());
 function stop(){version++;transport?.stop();transport=null;active=false;state='idle';onPhase('stopped');publish();}
 function decode(url){
  if(!cache.has(url))cache.set(url,fetcher(url,{signal:AbortSignal.timeout(8000)})
   .then(r=>{if(!r.ok)throw new Error('音效加载失败');return r.arrayBuffer();})
   .then(bytes=>context.decodeAudioData(bytes)).catch(e=>{cache.delete(url);throw e;}));
  return cache.get(url);
 }
 function arm(){
  stop();if(muted||hidden)return false;
  const id=version,preset=SOUND_PRESETS[selection.sound],chosen={...selection};
  state='pending';publish();
  try{
   if(!context){context=contextFactory();master=context.createGain();master.gain.value=volume;master.connect(context.destination);}
   // Do not defer resume behind a network response: this runs in the gesture.
   const resumed=context.resume();
   ready=Promise.all([resumed,Promise.all(['start','pulse','stop','reveal'].map(async key=>[key,await decode(preset.slotClips[key].url)]))])
    .then(([,entries])=>{
     if(id!==version||muted||hidden)return false;
     if(context.state!=='running')throw new Error('音频待启动');
     transport=createSlotAudioTransport({context,master,clips:Object.fromEntries(entries),machine:chosen.machine,theme:preset.theme,playback:preset.playback,onPhase});
     state='ready';publish();return true;
    }).catch(()=>{if(id===version){state='unavailable';publish();}return false;});
  }catch{state='unavailable';ready=Promise.resolve(false);publish();return false;}
  return true;
 }
 return {
  configure(config){const next={theme:config.theme||'classic',machine:config.machine||'capsule',sound:SOUND_PRESETS[config.sound]?config.sound:soundFor(config.theme,config.sound)};if(JSON.stringify(next)!==JSON.stringify(selection)){stop();selection=next;}},
  arm,whenReady:()=>ready,status,stop,
  play(kind,value){
   if(muted||hidden||state!=='ready'||!transport)return false;
   if(kind===`${selection.machine}-start`){active=true;return transport.start();}
   if(!active)return false;
   if(kind===`${selection.machine}-reveal`||(selection.machine==='capsule'&&kind==='capsule-open'))return transport.reveal();
   transport.event(kind,value);return true;
  },
  finish(){if(active&&!muted&&!hidden)return transport?.reveal();return false;},
  async audition(){arm();const id=version;if(await ready&&id===version){transport.preview();return true;}return false;},
  volume(value){volume=Math.max(0,Math.min(1,Number(value)||0));if(master)master.gain.setTargetAtTime(muted||hidden?0:volume,context.currentTime,.02);},
  setMuted(value){muted=!!value;if(muted)stop();if(master)master.gain.setTargetAtTime(muted||hidden?0:volume,context.currentTime,.02);publish();},
  setHidden(value){hidden=!!value;if(hidden)stop();if(master)master.gain.setTargetAtTime(muted||hidden?0:volume,context.currentTime,.02);publish();},
  dispose(){stop();cache.clear();context?.close();}
 };
}
