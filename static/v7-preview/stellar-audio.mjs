import {SOUND_STYLES,MACHINE_SOUND_PROFILES,DEFAULT_SOUND_STYLE,validSoundStyle} from './stellar-audio-profiles.mjs?v=sound-styles-4';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Tonal studies only: no white noise, motor drones or hard collision transients.
export function createStellarAudio({contextFactory=()=>new(globalThis.AudioContext||globalThis.webkitAudioContext)()}={}){
 let ctx,master,filter,compressor,enabled=true,volume=.8,machine='wheel',theme='cosmic',style=DEFAULT_SOUND_STYLE;
 let loops=[],active=false,wantMotion=false,allowEvents=false,attempt=0,resuming=Promise.resolve(false),failed=false,step=0,lastMotion=-99;
 const voices=new Set(),retiring=new Set(),last=new Map(),palette=()=>SOUND_STYLES[style],machineProfile=()=>MACHINE_SOUND_PROFILES[machine]||MACHINE_SOUND_PROFILES.wheel;
 function arm(){
  const id=++attempt;
  try{
   if(!ctx||ctx.state==='closed'){
    ctx=contextFactory();master=ctx.createGain();master.gain.value=enabled?volume:0;
    filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=2600;filter.Q.value=.5;
    compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-12;compressor.knee.value=18;compressor.ratio.value=3;compressor.attack.value=.012;compressor.release.value=.22;
    master.connect(filter);filter.connect(compressor);compressor.connect(ctx.destination);
   }
   failed=false;
   resuming=Promise.resolve(ctx.state==='running'?undefined:ctx.resume()).then(()=>{if(id!==attempt)return false;failed=ctx.state!=='running';return !failed;},()=>{if(id===attempt)failed=true;return false;});return true;
  }catch{failed=true;resuming=Promise.resolve(false);return false;}
 }
 const ready=()=>ctx?.state==='running'&&enabled&&!failed&&volume>0;
 function remove(v){if(!voices.delete(v))return;try{v.node.stop();}catch{}v.node.disconnect();v.gain.disconnect();}
 function tone(frequency,duration,level,delay=0,color=palette()){
  if(!ready())return;while(voices.size>=12)remove(voices.values().next().value);
  const node=ctx.createOscillator(),gain=ctx.createGain(),now=ctx.currentTime+delay;
  node.type='sine';node.frequency.setValueAtTime(frequency*(color.glide||1),now);
  if(color.glide&&color.glide!==1)node.frequency.exponentialRampToValueAtTime(frequency,now+Math.min(.10,duration*.75));
  gain.gain.setValueAtTime(.0001,now);gain.gain.linearRampToValueAtTime(level,now+Math.min(color.attack,duration*.25));gain.gain.exponentialRampToValueAtTime(.0001,now+duration);
  node.connect(gain);gain.connect(master);const voice={node,gain};voices.add(voice);node.onended=()=>remove(voice);node.start(now);node.stop(now+duration+.02);
 }
 function note(frequency,duration=palette().duration,level=palette().level,delay=0){
  tone(frequency,duration,level,delay);
  if(theme==='cosmic'&&palette().partial)tone(frequency*2,duration*.75,level*palette().partial,delay);
 }
 function start(){
  endLoops();if(!ready())return;active=true;lastMotion=-99;const p=palette(),m=machineProfile();
  for(const [i,frequency] of [m.pad,p.pad[0]].entries()){
   const node=ctx.createOscillator(),gain=ctx.createGain();node.type='sine';node.frequency.value=frequency;
   gain.gain.value=.0001;node.connect(gain);gain.connect(master);node.start();
   const base=i?p.padGain*.45:m.padGain;gain.gain.setTargetAtTime(base*.55,ctx.currentTime,.30);loops.push({node,gain,base});
  }
 }
 function motion({phase,speed}){
  if(!allowEvents)return;
  if(wantMotion&&!active&&phase==='spin'&&ready())start();
  if(!active||!ready()||ctx.currentTime-lastMotion<.04)return;lastMotion=ctx.currentTime;
  const energy=clamp(speed/(machine==='sphere'?6.4:machine==='wheel'?12:1.4),0,1);
  const breath=.90+.10*Math.sin(ctx.currentTime*1.2),factor=(phase==='spin'?.42+.48*energy:.18+.32*energy)*breath;
  for(const l of loops)l.gain.gain.setTargetAtTime(l.base*factor,ctx.currentTime,.22);
 }
 function release(v){
  voices.delete(v);retiring.add(v);
  const done=()=>{retiring.delete(v);v.node.disconnect();v.gain.disconnect();};v.node.onended=done;
  // Short release avoids a click when changing palettes or ending a sustained pad.
  v.gain.gain.cancelAndHoldAtTime(ctx.currentTime);v.gain.gain.setTargetAtTime(.0001,ctx.currentTime,.012);
  try{v.node.stop(ctx.currentTime+.08);}catch{done();}
  while(retiring.size>16){const old=retiring.values().next().value;retiring.delete(old);try{old.node.stop();}catch{}old.node.disconnect();old.gain.disconnect();}
 }
 function endLoops(){active=false;for(const l of loops)release(l);loops=[];}
 function stop(){wantMotion=false;allowEvents=false;endLoops();for(const v of [...voices])release(v);last.clear();step=0;}
 function reveal(){
  wantMotion=false;endLoops();if(!ready())return;
  const p=palette();p.reveal.forEach((f,i)=>note(f,p.tail,p.level*.74,i*.10));
 }
 function event(kind,value=1){
  if(kind.startsWith('motion-')){motion(value);return;}
  if(kind.endsWith('-start')){wantMotion=true;allowEvents=true;step=0;last.clear();}
  if(!allowEvents||!ready())return;
  const p=palette(),m=machineProfile(),now=ctx.currentTime;
  if(kind.endsWith('-start')){
   start();tone(m.pad*1.5,machine==='sphere'?.8:.3,m.level*.70,0,{attack:.05,glide:machine==='sphere'?1:.9});last.set('step',now);last.set('accent',now);
  }
  else if(wantMotion&&['capsule','wheel','sphere'].includes(kind)){
   // Real movement still triggers sound, but dense impacts never become a wall of clicks.
   const interval=m.interval;
   if(now-(last.get('step')??-99)<interval)return;last.set('step',now);
   const strength=clamp(Number(value)||.5,0,1);step++;
   tone(m.notes[step%m.notes.length],m.duration,m.level*(.5+.5*strength),0,m);
   // Space accents are sparse and quieter than the machine action layer.
   if(theme==='cosmic'&&now-(last.get('accent')??-99)>Math.max(1.1,p.interval*2)){
    last.set('accent',now);note(p.notes[step%p.notes.length],p.duration,p.level*(machine==='sphere'?.45:.30));
   }
  }
  else if(kind==='capsule-exit'){tone(185,.24,.052,0,m);tone(146,.28,.036,.13,m);}
  else if(kind.endsWith('-land')){
   if(machine==='wheel'){tone(320,.16,.058,0,m);tone(160,.22,.028,.035,m);}
   else tone(523.25,.70,.045,0,m);
  }
  else if(kind.endsWith('-open')||kind.endsWith('-reveal')){
   if(now-(last.get('reveal')??-99)<.5)return;last.set('reveal',now);
   if(machine==='capsule'){tone(540,.10,.043,0,m);tone(760,.12,.024,.055,m);}reveal();
  }
  else if(kind.endsWith('-return'))stop();
 }
 return {arm,whenReady:()=>resuming,status:()=>failed?'failed':!enabled?'muted':ctx?.state==='running'?'ready':'idle',style:()=>style,
  select(m,t,s=style){stop();machine=m;theme=t;style=validSoundStyle(s);},event,stop,
  setVolume(value){volume=clamp(Number(value)||0,0,1);if(master)master.gain.setTargetAtTime(enabled?volume:0,ctx.currentTime,.035);if(volume===0)stop();},
  setEnabled(value){enabled=!!value;if(!enabled)stop();if(master)master.gain.setTargetAtTime(enabled?volume:0,ctx.currentTime,.03);},
  dispose(){attempt++;stop();ctx?.close().catch(()=>{});}
 };
}
