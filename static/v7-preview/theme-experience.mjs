import {createStage as createClassicStage} from '/v6/stage.js?v=machine-motion-2';
import {createStage as createStellarStage} from './stellar-stage.js?v=machine-motion-2';
import {THEME_CHOICES,sanitizeThemeChoices} from './theme-audio-state.mjs?v=slot-review-3';
import {SPIN_MS,resolveExperience,expectedRevealSeconds,isRevealEvent,parseNames,createRoundGate} from './theme-experience-state.mjs?v=slot-review-3';
import {createThemeExperienceAudio} from './theme-experience-audio.mjs?v=slot-review-3';

const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const demos={
 capsule:['火锅','寿司','烤肉','披萨','饺子','沙拉','麻辣烫','咖喱饭'],
 wheel:['电影票','咖啡券','保温杯','蓝牙音箱','帆布袋','鲜花','甜点','纪念徽章'],
 sphere:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远','苏念','陆景行','顾星河','叶清禾','江南','程子衿','夏知秋','方以宁','宋见山','温予安','白露','唐予墨','余小溪','许星野','安可','谢听澜','林沐阳','沈初晴','何望舒','陈遇']
};
const machineNames={capsule:'胶囊机',wheel:'幸运转盘',sphere:'姓名星球'};
const motionText={capsule:'胶囊翻滚中，让惊喜再转一会儿',wheel:'幸运正在转动',sphere:'每一个名字，都在星球上转动'};
const coastText={capsule:'一颗胶囊，即将为你打开',wheel:'慢慢停下来，等好运落定',sphere:'星球减速，寻找属于你的名字'};
let choices={default:'',cosmic:''};
try{choices=sanitizeThemeChoices(JSON.parse(localStorage.getItem('v7-theme-audio-review')||'{}'));}catch{}
let {theme,machine,candidate}=resolveExperience(new URLSearchParams(location.search),choices);
let stage,manifest,toastTimer,lastVolume=80,disposed=false,roundStart=0,revealHeard=false;
const round=createRoundGate();
const audio=createThemeExperienceAudio({onPhase:phase=>{
 const data=document.body.dataset;data.audio=phase;
 if(phase==='ended'){
  // Local preview evidence only; survives a user's return to the comparison UI.
  // No account data, persistence or network transmission.
  const completed=JSON.parse(data.completedAuditions||'{}');
  completed[`${data.activeSound}/${machine}`]={reveal:data.revealEvent,seconds:data.revealSeconds,pulses:data.rhythmCount,spinRate:data.spinRollRate,coastRate:data.coastRollRate};
  data.completedAuditions=JSON.stringify(completed);
 }
},onMotion:motion=>{
 const data=document.body.dataset;data.rollRate=motion.rate.toFixed(3);data.rollGain=motion.gain.toFixed(3);data.rollPhase=motion.phase;
 if(motion.phase==='spin')data.spinRollRate=motion.rate.toFixed(3);
 if(motion.phase==='reveal'&&motion.speed>0)data.coastRollRate=motion.rate.toFixed(3);
},onRhythm:cue=>{
 const data=document.body.dataset;data.rhythmCount=String(Number(data.rhythmCount||0)+1);
 data.rhythmSpeed=cue.speed.toFixed(2);data.rhythmInterval=cue.interval?.toFixed(3)||'';
 const key=cue.phase==='reveal'?'coastPulses':'spinPulses';data[key]=String(Number(data[key]||0)+1);
 if(cue.phase==='reveal'&&cue.kind==='pulse'&&cue.interval){data.coastInterval=cue.interval.toFixed(3);data.coastSpeed=cue.speed.toFixed(2);}
 if(cue.phase==='spin'&&cue.kind==='pulse'&&cue.interval){data.spinInterval=cue.interval.toFixed(3);data.spinSpeed=cue.speed.toFixed(2);}
}});
const busy=()=>round.phase==='loading'||round.phase==='running';
const items=()=>demos[machine].map((name,i)=>({id:`${machine}-${i}`,name,excluded:false,weight:1,stock:1}));
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);}
function uiPhase(phase){
 document.body.dataset.phase=phase;document.body.classList.toggle('running',phase==='loading'||phase==='running');document.body.classList.toggle('has-result',phase==='result');
 for(const node of $$('.hud'))node.inert=phase!=='idle';
 $('#performance').hidden=phase==='idle';$('#phaseLabel').hidden=phase==='result';$('#result').hidden=phase!=='result';
}
function syncUrl(){const url=new URL(location.href);url.searchParams.set('theme',theme);url.searchParams.set('machine',machine);url.searchParams.set('sound',candidate);history.replaceState(null,'',url);}
function paintSelection(){
 const selected=choices[theme]===candidate;
 $('#pick').textContent=selected?'✓ 已记下这套声音':'选这套声音';$('#resultPick').textContent=selected?'✓ 已记下这套声音':'喜欢这套声音，记下来';
 $('#savedChoice').textContent=choices[theme]?`本机已选：${manifest.candidates[choices[theme]].name}`:'每个主题各选一套，选择会保存在本机';
 for(const button of $$('[data-sound]'))button.setAttribute('aria-pressed',String(button.dataset.sound===candidate));
}
function paintTheme(){
 document.body.dataset.theme=theme;
 $('#themeLabel').textContent=theme==='default'?'默认主题 · 滚轮新声':'星空主题 · 滚轮新声';
 $('#title').replaceChildren(...(theme==='default'?['让好运，','转起来。']:['把惊喜，','交给星光。']).flatMap((text,i)=>i?[document.createElement('br'),document.createTextNode(text)]:[document.createTextNode(text)]));
 $('#description').textContent=theme==='default'?'像街机一样，启动、滚动、停稳、揭晓。听完整轮，再选喜欢的。':'星点随着转动逐渐变密，再缓缓散开。轻盈滚动，清透揭晓。';
 for(const button of $$('.themes [data-theme]'))button.setAttribute('aria-pressed',String(button.dataset.theme===theme));
 for(const button of $$('[data-machine]'))button.setAttribute('aria-pressed',String(button.dataset.machine===machine));
 $('#soundOptions').replaceChildren(...THEME_CHOICES[theme].map((key,i)=>{
  const entry=manifest.candidates[key],button=document.createElement('button');button.type='button';button.className='sound-option';button.dataset.sound=key;button.setAttribute('aria-label',entry.name+'，'+entry.character);
  const orb=document.createElement('span');orb.className='orb';orb.textContent=['✧','◌','✦'][i];orb.setAttribute('aria-hidden','true');
  const copy=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small'),check=document.createElement('span');name.textContent=entry.name;detail.textContent=entry.character;check.textContent='✓';check.className='check';copy.append(name,detail);button.append(orb,copy,check);
  button.onclick=()=>{if(busy())return;audio.stop();candidate=key;paintSelection();syncUrl();};return button;
 }));
 $('#poolCaption').textContent=machineNames[machine]+' · '+demos[machine].length+' 个体验选项';paintSelection();syncUrl();
}
function stageSound(kind,value){
 if(round.phase!=='running')return;
 audio.event(kind,value);
 if(!isRevealEvent(machine,kind)||revealHeard)return;
 revealHeard=audio.reveal();
 document.body.dataset.revealEvent=kind;document.body.dataset.revealSeconds=((performance.now()-roundStart)/1000).toFixed(2);
 $('#phaseLabel').textContent='惊喜已揭晓';
}
function renderStage(){
 paintTheme();$('#play').disabled=true;
 try{stage?.dispose();stage=null;stage=(theme==='default'?createClassicStage:createStellarStage)($('#scene'),play,stageSound,false,true);stage.quality('high');stage.configure({machine,theme:theme==='default'?'classic':'cosmic',items:items(),mode:'normal',count:1});$('#play').disabled=false;}
 catch(error){console.error(error);toast('3D 机台加载失败，请刷新重试。');}
}
function reset(focus=true){round.cancel();audio.stop();stage?.reset();uiPhase('idle');if(focus)$('#play').focus({preventScroll:true});}
async function play(){
 if(!stage||!manifest||disposed||$('#listDialog').open||busy())return;
 const id=round.begin();if(id===null)return;
 uiPhase('loading');$('#phaseLabel').textContent='正在准备画面与声音…';$('#stop').focus({preventScroll:true});
 delete document.body.dataset.revealEvent;delete document.body.dataset.revealSeconds;
 for(const key of ['rhythmCount','spinPulses','coastPulses','rhythmSpeed','rhythmInterval','spinInterval','spinSpeed','coastInterval','coastSpeed','rollRate','rollGain','rollPhase','spinRollRate','coastRollRate'])delete document.body.dataset[key];
 try{
  const entry=manifest.candidates[candidate];
  const ready=await audio.prepare(entry.clip.url,{...entry,machine});
  if(!round.active(id)||disposed)return;if(!ready)throw new Error('音效未能加载，请再试一次。');
  // Clear the previous result before starting, so replay has no late return sound.
  stage.reset();round.set(id,'running');uiPhase('running');roundStart=performance.now();revealHeard=false;
  if(!await stage.start())throw new Error('机台未能启动，请重试。');if(!round.active(id))return;
  audio.start();$('#phaseLabel').textContent=motionText[machine];document.body.dataset.activeSound=candidate;
  await delay(SPIN_MS);if(!round.active(id)||disposed)return;
  const pool=items(),random=new Uint32Array(1);crypto.getRandomValues(random);const winner=pool[Math.floor(random[0]/4294967296*pool.length)];
  stage.reveal([winner]);const landing=stage.revealDelay();audio.coast(expectedRevealSeconds(machine,landing));$('#phaseLabel').textContent=coastText[machine];
  await delay(landing+220);if(!round.active(id)||disposed)return;
  // Do not manufacture a reveal cue if the renderer has not actually emitted it.
  if(!revealHeard){reset();toast('这一轮声音未与揭晓同步，请重新体验。');return;}
  round.set(id,'result');uiPhase('result');$('#resultName').textContent=winner.name;$('#resultSound').textContent=manifest.candidates[candidate].name+' · '+manifest.candidates[candidate].character+' · '+machineNames[machine];paintSelection();$('#again').focus({preventScroll:true});
 }catch(error){if(round.active(id)){reset();toast(error.message||'体验未能启动，请重试。');}}
}
function choose(){
 // Re-read to preserve the other theme if another review tab changed it.
 try{choices=sanitizeThemeChoices(JSON.parse(localStorage.getItem('v7-theme-audio-review')||'{}'));choices[theme]=candidate;localStorage.setItem('v7-theme-audio-review',JSON.stringify(choices));paintSelection();toast('已记下'+manifest.candidates[candidate].name+'，可以继续比较。');}
 catch{toast('当前浏览器未保存选择，请告诉我你喜欢的方案。');}
}
function updateVolume(){const value=Number($('#volume').value);if(value>0)lastVolume=value;audio.volume(value/100);$('#volumeValue').textContent=value+'%';$('#mute').setAttribute('aria-label',value?'静音':'开启声音');$('#mute').textContent=value?'♫':'♩';}
for(const button of $$('.themes [data-theme]'))button.onclick=()=>{if(busy()||button.dataset.theme===theme||!manifest)return;reset(false);theme=button.dataset.theme;candidate=choices[theme]||THEME_CHOICES[theme][0];renderStage();};
for(const button of $$('[data-machine]'))button.onclick=()=>{if(busy()||button.dataset.machine===machine||!manifest)return;reset(false);machine=button.dataset.machine;renderStage();};
$('#play').onclick=play;$('#again').onclick=play;$('#stop').onclick=()=>reset();$('#back').onclick=()=>reset();$('#pick').onclick=choose;$('#resultPick').onclick=choose;
$('#volume').oninput=updateVolume;$('#mute').onclick=()=>{$('#volume').value=Number($('#volume').value)?'0':String(lastVolume);updateVolume();};
$('#fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():$('#experience').requestFullscreen?.();promise?.catch(()=>toast('当前窗口不支持系统全屏，机台仍会铺满页面。'));};
document.addEventListener('fullscreenchange',()=>{$('#fullscreen').setAttribute('aria-label',document.fullscreenElement?'退出全屏':'进入全屏');});
$('#editList').onclick=()=>{if(busy())return;$('#names').value=demos[machine].join('\n');$('#listError').textContent='';$('#listDialog').showModal();};
$('#closeList').onclick=()=>$('#listDialog').close();
$('#listForm').onsubmit=event=>{event.preventDefault();try{const names=parseNames($('#names').value);if(names.length<2)throw new Error('至少需要两个不同的选项。');demos[machine]=names;reset(false);renderStage();$('#listDialog').close();}catch(error){$('#listError').textContent=error.message;}};
document.addEventListener('keydown',event=>{
 if(event.code==='Escape'&&round.phase!=='idle'&&!$('#listDialog').open){event.preventDefault();reset();return;}
 if(event.code!=='Space'||event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||$('#listDialog').open||event.target?.closest('input,textarea,select,a,[contenteditable]'))return;
 if(event.target?.closest('button')&&!['play','again','stop'].includes(event.target.id))return;
 event.preventDefault();play();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&round.phase!=='idle')reset(false);});
window.addEventListener('storage',event=>{if(event.key==='v7-theme-audio-review'){try{choices=sanitizeThemeChoices(JSON.parse(event.newValue||'{}'));if(manifest)paintSelection();}catch{}}});
window.addEventListener('pagehide',()=>{disposed=true;round.cancel();audio.dispose();stage?.dispose();clearTimeout(toastTimer);});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
try{
 const response=await fetch('./theme-audio/manifest.json?v=slot-review-3');if(!response.ok)throw new Error('manifest');manifest=await response.json();document.body.dataset.audioRevision=manifest.version;updateVolume();renderStage();
}catch{toast('主题资源加载失败，请刷新重试。');}
