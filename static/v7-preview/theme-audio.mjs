import {phaseAt} from './complete-audio-state.mjs';
import {validThemeChoice,sanitizeThemeChoices} from './theme-audio-state.mjs?v=slot-review-3';
const now=document.querySelector('#nowPlaying'),clock=document.querySelector('#clock'),progress=document.querySelector('#progress'),phaseStrip=document.querySelector('#phases');
let manifest,active=null,choices={default:'',cosmic:''};const players=new Map();
const format=seconds=>`00:${String(Math.floor(seconds)).padStart(2,'0')}`;
function paintProgress(){
 const time=active?.currentTime||0,phase=phaseAt(time,manifest?.phases||[]);
 progress.style.width=`${Math.min(100,time/16*100)}%`;clock.textContent=`${format(time)} / 00:16`;
 for(const item of phaseStrip.children)item.classList.toggle('active',item.dataset.phase===phase?.id);
}
function stopAll(reset=false){
 for(const {audio,card,status} of players.values()){
  audio.pause();if(reset)audio.currentTime=0;card.classList.remove('playing');
  if(audio.currentTime>0&&!audio.ended)status.textContent='已暂停';
 }
 active=null;if(reset){now.textContent='已停止，可重新试听。';paintProgress();}
}
function paintChoices(){
 for(const [key,{card,pick,entry}] of players){const selected=choices[entry.theme]===key;card.classList.toggle('chosen',selected);pick.textContent=selected?'✓ 已选这套':'选这套';pick.setAttribute('aria-pressed',String(selected));}
 const names={};for(const theme of ['default','cosmic']){
  names[theme]=choices[theme]?manifest.candidates[choices[theme]].name:'未选择';
  document.querySelector('#'+theme+'Selected').textContent=choices[theme]?'已选：'+names[theme]:'三选一';
 }
 document.querySelector('#selectionSummary').textContent=`默认：${names.default} · 星空：${names.cosmic}`;
}
function choose(theme,key){
 const valid=validThemeChoice(theme,key);if(!valid)return;
 choices={...choices,[theme]:valid};paintChoices();
 try{localStorage.setItem('v7-theme-audio-review',JSON.stringify(choices));}
 catch{document.querySelector('#selectionSummary').textContent+=' · 当前浏览器未保存';}
}
async function start(key,revealOnly=false){
 const {audio,status}=players.get(key);for(const other of players.values())if(other.audio!==audio)other.audio.pause();
 audio.currentTime=revealOnly?11.8:0;
 try{await audio.play();}catch{status.textContent='播放未启动，点击重试';}
}
function makeCard(key,entry){
 const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
 const card=el('article','candidate'),tag=el('span','tag',entry.character),title=el('h3','',entry.name),description=el('p','description',entry.description);
 const actions=el('div','actions'),play=el('button','primary','▶ 完整试听'),reveal=el('button','secondary','单听揭晓');
 play.type=reveal.type='button';play.setAttribute('aria-label',`完整试听${entry.name}`);reveal.setAttribute('aria-label',`单听${entry.name}揭晓`);
 play.addEventListener('click',()=>start(key));reveal.addEventListener('click',()=>start(key,true));actions.append(play,reveal);
 const audio=el('audio');audio.controls=true;audio.preload='metadata';audio.volume=.8;audio.src=entry.clip.url;audio.setAttribute('aria-label',entry.name+'播放器');
 const status=el('p','status','完整 16 秒 · 点击播放');status.setAttribute('role','status');
 const bottom=el('div','card-bottom'),pick=el('button','pick','选这套'),download=el('a','download','下载音效 ↓');
 pick.type='button';pick.setAttribute('aria-label',`选择${entry.name}`);pick.addEventListener('click',()=>choose(entry.theme,key));
 download.href=entry.clip.url;download.download=key+'.mp3';bottom.append(pick,download);
 audio.addEventListener('play',()=>{
  for(const other of players.values())if(other.audio!==audio){other.audio.pause();other.card.classList.remove('playing');}
  active=audio;card.classList.add('playing');now.textContent=entry.name+' · '+entry.character;status.textContent='正在试听';paintProgress();
 });
 audio.addEventListener('timeupdate',()=>{if(active===audio){paintProgress();status.textContent='正在试听 · '+(phaseAt(audio.currentTime,manifest.phases)?.name||'收尾');}});
 audio.addEventListener('pause',()=>{card.classList.remove('playing');if(audio.ended)return;status.textContent='已暂停';if(active===audio){active=null;now.textContent='已暂停，可继续播放。';}});
 audio.addEventListener('ended',()=>{card.classList.remove('playing');status.textContent='试听完成，可重新播放';if(active===audio){paintProgress();active=null;now.textContent=entry.name+' · 试听完成';}});
 audio.addEventListener('error',()=>{card.classList.remove('playing');status.textContent='音效加载失败，点击重试';if(active===audio){active=null;now.textContent='音效加载失败';}});
 const experience=el('a','experience-link','带入机台体验 ↗');experience.href=`./theme-experience.html?theme=${entry.theme}&sound=${key}`;experience.style.cssText='display:block;margin:16px 0 3px;color:var(--accent,#ded0ff);font-size:12px';
 card.append(tag,title,description,actions,audio,status,bottom,experience);players.set(key,{card,audio,status,pick,entry});return card;
}
document.querySelector('#stopAll').addEventListener('click',()=>stopAll(true));
document.querySelector('#volume').addEventListener('input',event=>{const volume=Number(event.target.value)/100;for(const {audio} of players.values())audio.volume=volume;document.querySelector('#volumeValue').textContent=Math.round(volume*100)+'%';});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAll();});window.addEventListener('pagehide',()=>stopAll());
try{
 const response=await fetch('./theme-audio/manifest.json?v=slot-review-3');if(!response.ok)throw new Error('manifest');manifest=await response.json();
 for(const theme of ['default','cosmic'])document.querySelector('#'+theme+'Candidates').replaceChildren();
 for(const phase of manifest.phases){const span=document.createElement('span');span.dataset.phase=phase.id;span.textContent=phase.name;phaseStrip.append(span);}
 for(const [key,entry] of Object.entries(manifest.candidates))document.querySelector('#'+entry.theme+'Candidates').append(makeCard(key,entry));
 try{choices=sanitizeThemeChoices(JSON.parse(localStorage.getItem('v7-theme-audio-review')||'{}'));}catch{}
 paintChoices();
}catch{
 now.textContent='音效试听加载失败，请刷新重试。';
 for(const theme of ['default','cosmic'])document.querySelector('#'+theme+'Candidates').textContent='试听未加载';
}
