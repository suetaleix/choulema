const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
// A motion observation creates no clock. Only physical crossings/impacts emit notes.
export function createMachineRhythm(machine,theme){
 const cosmic=theme==='cosmic';
 let active=false,landed=false,last=-Infinity,step=0,previousAngle=null,travel=0,speed=0,phase='idle';
 const minimum=machine==='wheel'?(cosmic?.12:.09):machine==='capsule'?(cosmic?.16:.125):.16;
 const maxSpeed=machine==='wheel'?12:machine==='sphere'?6.4:1;
 function note(now,strength,pan=0,kind='pulse'){
  if(!active||landed||now-last<minimum||strength<=0)return null;
  const interval=Number.isFinite(last)?now-last:null;last=now;step++;
  // A small repeating two-tone motif makes rotation legible without playing a tune.
  const rate=kind==='exit'?.84:kind==='land'?.75:(step%4===0?1.12246:1);
  return {kind,rate,gain:(cosmic?.68:.78)*(.62+.38*clamp(strength,0,1)),pan:clamp(pan,-.32,.32),speed,phase,interval};
 }
 return {
  start(){active=true;landed=false;last=-Infinity;step=0;previousAngle=null;travel=0;speed=0;phase='spin';},
  stop(){active=false;landed=true;previousAngle=null;travel=0;},
  event(kind,value,now){
   if(!active||landed)return null;
   if(kind===`motion-${machine}`){
    phase=value?.phase;speed=Math.max(0,Number(value?.speed)||0);
    if(!['spin','reveal'].includes(phase)){previousAngle=null;return null;}
    if(machine!=='sphere')return null;
    const angle=Number(value.angle);if(!Number.isFinite(angle))return null;
    const delta=previousAngle===null?0:Math.abs(angle-previousAngle);previousAngle=angle;
    // An unexpected teleport/reset must not spray a backlog of notes.
    if(delta>Math.PI||speed<.08){travel=0;return null;}
    travel+=delta;
    const arc=Math.PI/2;
    if(travel<arc)return null;travel%=arc;
    return note(now,speed/maxSpeed,Math.sin(angle)*.24);
   }
   if(kind==='wheel'&&machine==='wheel'){
    speed=Math.max(0,Number(value)||0);if(speed<.08)return null;
    return note(now,speed/maxSpeed,(step%2?1:-1)*.09);
   }
   if(kind==='capsule-impact'&&machine==='capsule'){
    if(speed<.04||!['spin','reveal'].includes(phase))return null;
    const impact=Number(value?.strength)||0;if(impact<.20)return null;
    return note(now,clamp(impact/2.0,.15,1),Number(value?.pan)||0);
   }
   if(kind===`${machine}-land`||(machine==='capsule'&&kind==='capsule-exit')){
    last=-Infinity;const cue=note(now,.62,0,machine==='capsule'?'exit':'land');landed=true;return cue;
   }
   return null;
  }
 };
}
