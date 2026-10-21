import {createStellarAudio} from './stellar-audio.mjs?v=sound-styles-4';
const reference=createStellarAudio();
const play=document.querySelector('#referencePlay'),stop=document.querySelector('#referenceStop'),status=document.querySelector('#referenceStatus');
const samples=[...document.querySelectorAll('audio')];
let run=0,timers=[];
function endReference(message='已停止'){
 run++;timers.forEach(clearTimeout);timers=[];reference.stop();play.disabled=false;stop.disabled=true;status.textContent=message;
}
function pauseSamples(except){for(const sample of samples)if(sample!==except)sample.pause();}
for(const sample of samples){
 const label=document.querySelector(`[data-status-for="${sample.id}"]`);
 sample.volume=.8;
 sample.addEventListener('loadedmetadata',()=>{label.textContent=`原声 · ${sample.duration.toFixed(1)} 秒 · 点击播放器试听`;});
 sample.addEventListener('playing',()=>{pauseSamples(sample);endReference('对照已停止');label.textContent='正在播放原声';});
 sample.addEventListener('pause',()=>{if(!sample.ended&&sample.currentTime>0)label.textContent='已暂停';});
 sample.addEventListener('ended',()=>{label.textContent='播放结束，可再次试听';});
 sample.addEventListener('error',()=>{label.textContent='原声暂时未加载，请点下方来源试听';});
}
play.addEventListener('click',async()=>{
 endReference();pauseSamples();reference.select('sphere','cosmic','aurora');reference.setVolume(.8);reference.arm();
 const id=run;play.disabled=true;stop.disabled=false;status.textContent='准备星海空灵…';
 if(!await reference.whenReady()){
  if(id===run)endReference('声音未能启用，请重新点击播放');return;
 }
 if(id!==run)return;
 status.textContent='正在试听星海空灵 · 旋转';reference.event('sphere-start');
 const schedule=(delay,callback)=>timers.push(setTimeout(()=>{if(id===run)callback();},delay));
 for(let t=300;t<8500;t+=200)schedule(t,()=>{reference.event('motion-sphere',{phase:t<6700?'spin':'coast',speed:t<6700?5:Math.max(.4,5-(t-6700)/400)});reference.event('sphere',.65);});
 schedule(6800,()=>{status.textContent='正在试听星海空灵 · 减速';});
 schedule(8800,()=>{status.textContent='正在试听星海空灵 · 揭晓';reference.event('sphere-land');reference.event('sphere-reveal');});
 schedule(11200,()=>endReference('试听结束，可再次播放'));
});
stop.addEventListener('click',()=>endReference());
document.addEventListener('visibilitychange',()=>{if(document.hidden){endReference();pauseSamples();}});
window.addEventListener('pagehide',()=>{endReference();pauseSamples();reference.dispose();});
