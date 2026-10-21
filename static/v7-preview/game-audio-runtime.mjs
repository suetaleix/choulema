import {actionCue,motionInterval} from './game-audio-score.mjs';
// Review-only sample player. Real stage events trigger cues; reels are comparison exports.
export function createGameAudio({contextFactory=()=>new AudioContext(),fetcher=fetch}={}){
 let ctx,bus,limiter,manifest,pack='a',machine='capsule',volume=.8,active=false,step=0,raised=false,revealed=false,generation=0;
 const banks=new Map(),pending=new Map(),nodes=new Set(),last=new Map();
 function arm(){
  if(!ctx||ctx.state==='closed'){
   banks.clear();pending.clear();ctx=contextFactory();bus=ctx.createGain();bus.gain.value=volume;
   limiter=ctx.createDynamicsCompressor();limiter.threshold.value=-7;limiter.knee.value=5;limiter.ratio.value=5;limiter.attack.value=.003;limiter.release.value=.10;
   bus.connect(limiter);limiter.connect(ctx.destination);
  }
  return Promise.resolve(ctx.resume()).then(()=>ctx.state==='running');
 }
 async function prepare(key){
  manifest??=await fetcher('./game-audio/manifest.json').then(r=>{if(!r.ok)throw Error('声音清单未能加载');return r.json();});
  if(!Object.hasOwn(manifest.candidates,key))throw Error('未知样音');
  if(!banks.has(key)){
   if(!pending.has(key))pending.set(key,Promise.all(Object.entries(manifest.candidates[key].cues).map(async([name,cue])=>{
    const response=await fetcher(cue.url);if(!response.ok)throw Error('部分声音未能加载');
    return [name,await ctx.decodeAudioData(await response.arrayBuffer())];
   })).then(entries=>banks.set(key,Object.fromEntries(entries))).finally(()=>pending.delete(key)));
   await pending.get(key);
  }
 }
 function release(item,immediate=false){
  if(!nodes.has(item))return;
  if(immediate){nodes.delete(item);try{item.node.stop();}catch{}item.node.disconnect();item.gain.disconnect();return;}
  if(item.retiring)return;item.retiring=true;item.gain.gain.cancelAndHoldAtTime(ctx.currentTime);item.gain.gain.setTargetAtTime(.0001,ctx.currentTime,.012);try{item.node.stop(ctx.currentTime+.07);}catch{}
 }
 function cue(name,level=1,rate=1,delay=0){
  if(!active||ctx?.state!=='running'||volume===0)return;
  const buffer=banks.get(pack)?.[name];if(!buffer)return;
  while(nodes.size>=14)release(nodes.values().next().value,true);
  const node=ctx.createBufferSource(),gain=ctx.createGain();node.buffer=buffer;node.playbackRate.value=Math.max(.7,Math.min(1.3,rate));
  gain.gain.value=level*(manifest.candidates[pack].runtimeGain||1);node.connect(gain);gain.connect(bus);
  const item={node,gain};nodes.add(item);node.onended=()=>{nodes.delete(item);node.disconnect();gain.disconnect();};node.start(ctx.currentTime+delay);
 }
 function stop(){generation++;active=false;for(const item of [...nodes])release(item);last.clear();}
 function select(key,m){stop();pack=key;machine=m;step=0;raised=false;revealed=false;active=true;}
 function event(kind,value=1){
  if(!active)return;const now=ctx.currentTime;
  if(kind.startsWith('motion-')){
   if(value.phase==='reveal'&&!raised&&!revealed){raised=true;cue('rise',.55);}return;
  }
  if(kind.endsWith('-start')){cue('press');cue('start',1,1,.10);}
  else if(kind===machine&&!revealed){
   if(now-(last.get('motion')??-99)<motionInterval(machine))return;last.set('motion',now);
   const strength=Math.max(.2,Math.min(1,Number(value)/(machine==='wheel'?10:machine==='sphere'?6:1.4)||.5));
   cue(actionCue(machine,step++),.5+.35*strength,machine==='capsule'?.95+(step%3)*.045:1);
   if(machine==='capsule'&&now-(last.get('roll')??-99)>.9){last.set('roll',now);cue('capsule-roll',.42,1);}
  }
  else if(kind.endsWith('-exit'))cue('exit');
  else if(kind.endsWith('-land'))cue('land',.9);
  else if(kind.endsWith('-open')||kind.endsWith('-reveal')){
   if(revealed)return;revealed=true;
   if(kind.endsWith('-open'))cue('open',.85);
   // The reveal is a short game reward phrase, never an ambient loop.
   cue('reveal',1,1,kind.endsWith('-open')?.07:0);
  }
 }
 return {arm,prepare,select,event,stop,
  reward(){revealed=true;cue('open',.55);cue('reveal',1,1,.09);},
  setVolume(v){volume=Math.max(0,Math.min(1,Number(v)||0));if(bus)bus.gain.setTargetAtTime(volume,ctx.currentTime,.025);},
  dispose(){stop();for(const item of [...nodes])release(item,true);ctx?.close().catch(()=>{});},
  status:()=>({state:ctx?.state||'idle',active,nodes:nodes.size,generation})
 };
}
