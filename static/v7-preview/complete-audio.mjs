import {phaseAt,validMachine,validChoice,prepareReviewChoice} from './complete-audio-state.mjs';
const candidates=document.querySelector('#candidates'),machines=document.querySelector('#machines');
const now=document.querySelector('#nowPlaying'),clock=document.querySelector('#clock'),progress=document.querySelector('#progress');
const phaseStrip=document.querySelector('#phases'),choiceStatus=document.querySelector('#choiceStatus');
const defaultChoice=document.querySelector('#defaultChoice'),cosmicChoice=document.querySelector('#cosmicChoice'),save=document.querySelector('#saveChoices');
let manifest,machine=validMachine(location.hash.slice(1)),active=null;
const players=new Map();
const format=seconds=>`00:${String(Math.floor(seconds)).padStart(2,'0')}`;
function paintProgress(){
 const time=active?.currentTime||0,phase=phaseAt(time,manifest?.phases||[]);
 progress.style.width=`${Math.min(100,time/16*100)}%`;clock.textContent=`${format(time)} / 00:16`;
 for(const item of phaseStrip.children)item.classList.toggle('active',item.dataset.phase===phase?.id);
}
function stopAll(reset=false){
 for(const {audio,card,status} of players.values()){
  if(!audio.paused){audio.pause();status.textContent='已暂停';}
  if(reset)audio.currentTime=0;
  card.classList.remove('playing');
 }
 active=null;now.textContent=reset?'已停止，选择一套重新试听。':'播放已暂停。';paintProgress();
}
function selectMachine(value){
 stopAll(true);machine=validMachine(value);
 for(const button of machines.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.machine===machine));
 for(const [key,player] of players){
  const clip=manifest.candidates[key].clips[machine];
  player.audio.src=clip.url;player.audio.load();player.download.href=clip.url;player.download.download=key+'-'+machine+'.mp3';
  player.card.querySelector('.machine-label').textContent=manifest.machines[machine]+' · 完整 16 秒';
  player.status.textContent='点击播放完整过程';
 }
 now.textContent=`${manifest.machines[machine]} · 选择音效试听。`;history.replaceState(null,'','#'+machine);
}
async function start(key,revealOnly=false){
 const player=players.get(key);if(!player)return;
 for(const [otherKey,other] of players)if(otherKey!==key){other.audio.pause();other.card.classList.remove('playing');}
 player.audio.currentTime=revealOnly?11.8:0;
 try{await player.audio.play();}catch{player.status.textContent='未能播放，点击重试';}
}
function cardFor(key,entry){
 const card=document.createElement('article');card.className='candidate';card.style.setProperty('--tone',entry.color);
 const node=(tag,cls,text)=>{const element=document.createElement(tag);if(cls)element.className=cls;if(text)element.textContent=text;return element;};
 const head=node('div','card-head');head.append(node('span','tag',entry.tag),node('span','machine-label'));
 const title=node('h2','',entry.name),description=node('p','description',entry.description);
 const actions=node('div','actions'),play=node('button','primary','▶ 播放完整'),reward=node('button','secondary','只听揭晓');
 play.type=reward.type='button';play.setAttribute('aria-label',`播放${entry.name}完整音效`);reward.setAttribute('aria-label',`只听${entry.name}揭晓`);
 play.addEventListener('click',()=>start(key));reward.addEventListener('click',()=>start(key,true));actions.append(play,reward);
 const audio=node('audio');audio.controls=true;audio.preload='metadata';audio.volume=.8;audio.setAttribute('aria-label',entry.name+'完整音效播放器');
 const status=node('p','status','点击播放完整过程');status.setAttribute('role','status');
 const notes=node('div','notes');for(const [label,value] of [['过程',entry.process],['揭晓',entry.reward]]){const paragraph=node('p');paragraph.append(node('span','',label),document.createTextNode(value));notes.append(paragraph);}
 const download=node('a','download','下载这段完整音效 ↓');download.download=key+'-'+machine+'.mp3';
 audio.addEventListener('play',()=>{
  for(const other of players.values())if(other.audio!==audio){other.audio.pause();other.card.classList.remove('playing');}
  active=audio;card.classList.add('playing');now.textContent=`${entry.name} · ${manifest.machines[machine]}`;status.textContent='正在试听';paintProgress();
 });
 audio.addEventListener('timeupdate',()=>{if(active===audio){paintProgress();status.textContent=`正在试听 · ${phaseAt(audio.currentTime,manifest.phases)?.name||'收尾'}`;}});
 audio.addEventListener('pause',()=>{card.classList.remove('playing');if(audio.ended)return;status.textContent='已暂停';if(active===audio){active=null;now.textContent='已暂停，点击播放器可继续。';}});
 audio.addEventListener('ended',()=>{card.classList.remove('playing');status.textContent='试听完成，可再次播放';if(active===audio){now.textContent=`${entry.name} · 试听完成`;paintProgress();active=null;}});
 audio.addEventListener('error',()=>{card.classList.remove('playing');status.textContent='音效未加载，点击播放重试';if(active===audio){active=null;now.textContent='音效未加载';}});
 card.append(head,title,description,actions,audio,status,notes,download);players.set(key,{audio,card,status,download});return card;
}
document.querySelector('#stopAll').addEventListener('click',()=>stopAll(true));
machines.addEventListener('click',event=>{const button=event.target.closest('[data-machine]');if(button&&manifest)selectMachine(button.dataset.machine);});
document.querySelector('#volume').addEventListener('input',event=>{const value=Number(event.target.value)/100;for(const {audio} of players.values())audio.volume=value;document.querySelector('#volumeValue').textContent=Math.round(value*100)+'%';});
save.addEventListener('click',()=>{
 const value=prepareReviewChoice(defaultChoice.value,cosmicChoice.value);
 try{localStorage.setItem('v7-soft-audio-review',JSON.stringify(value));choiceStatus.textContent='已记录本机选择，等你确认。';}
 catch{choiceStatus.textContent='浏览器未能保存，当前选择仍可查看。';}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAll();});
window.addEventListener('pagehide',()=>stopAll());
try{
 const response=await fetch('./soft-audio/manifest.json?v=1');if(!response.ok)throw new Error('manifest');manifest=await response.json();
 candidates.replaceChildren();
 for(const phase of manifest.phases){const label=document.createElement('span');label.dataset.phase=phase.id;label.textContent=phase.name;phaseStrip.append(label);}
 for(const [key,entry] of Object.entries(manifest.candidates)){
  candidates.append(cardFor(key,entry));for(const select of [defaultChoice,cosmicChoice]){const option=document.createElement('option');option.value=key;option.textContent=entry.name;select.append(option);}
 }
 try{const stored=JSON.parse(localStorage.getItem('v7-soft-audio-review')||'{}');defaultChoice.value=validChoice(stored.default);cosmicChoice.value=validChoice(stored.cosmic);}catch{}
 save.disabled=false;selectMachine(machine);
}catch{candidates.textContent='试听暂时未准备好，请刷新页面。';now.textContent='试听加载失败';}
