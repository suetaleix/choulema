import {createStage as createStellarStage} from './stellar-stage.js?v=1';
import {createStage as createClassicStage} from '/v6/stage.js?v=v7-fullstage-1';
import {createStellarAudio} from './stellar-audio.mjs?v=sound-styles-4';
import {SOUND_STYLES,MACHINE_SOUND_PROFILES,validSoundStyle} from './stellar-audio-profiles.mjs?v=sound-styles-4';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const skins={
 capsule:{title:'星空胶囊',lead:'把惊喜，<br>藏进一颗星光。',description:'虹彩玻璃包裹流动星尘，胶囊在深空里翻滚。开壳的那一刻，让期待有声有色。',features:['虹彩球壳','真实滚碰','星尘开壳'],caption:'珠光机身 / 虹彩玻璃',detail:'保留胶囊翻滚、出仓与开壳的实体动作。紫蓝金属与虹彩接缝，配疏落的星光音符和轻柔揭晓和弦。',phase:'胶囊正与星光一起翻滚',sound:'滚动碰撞 · 晶体开壳',names:['火锅','寿司','烤肉','披萨','饺子','沙拉','麻辣烫','咖喱饭']},
 wheel:{title:'星轨转盘',lead:'每一次转动，<br>都有星光回应。',description:'星空珐琅与虹彩金属相遇，发光刻度划过指针。循着逐渐放缓的星轨，等好运抵达。',features:['星空珐琅','发光刻度','星轨流光'],caption:'虹彩金属 / 星空珐琅',detail:'深空珐琅扇区、双层光刻边框、中央晶体与星点嵌饰。星光音符跟随过格节奏，控制密度，停稳后用柔和和声揭晓。',phase:'星轨正在转动，等待好运停靠',sound:'机械过格 · 星辉落锁',names:['电影票','咖啡券','保温杯','蓝牙音箱','帆布袋','鲜花','甜点','纪念徽章']},
 sphere:{title:'星云姓名球',lead:'每个名字，<br>都是一颗独特的星。',description:'姓名化作彩色晶体，围成一片缓缓转动的星云。没有连线，只有属于每个人的高光。',features:['晶体姓名卡','整球旋转','空间星铃'],caption:'彩色晶体 / 星云空间',detail:'所有演示姓名构成球体，紫、蓝、青、粉晶体卡交错分布；无连接线、无实体球核。整体旋转后，选中姓名转向正面飞出，柔和和声收束为星铃。',phase:'名字汇成星云，下一束光属于谁',sound:'旋转气流 · 星铃聚焦',names:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远','苏念','陆景行','顾星河','叶清禾','江南','程子衿','夏知秋','方以宁','宋见山','温予安','白露','唐予墨','余小溪','许星野','安可','谢听澜','林沐阳','沈初晴','何望舒','陈遇']}
};
let machine=['capsule','wheel','sphere'].includes(location.hash.slice(1))?location.hash.slice(1):'wheel',classic=false,stage,phase='idle',token=0,soundToken=0,muted=false,lastVolume=80,toastTimer,disposed=false;
const audio=createStellarAudio();
let soundStyle=validSoundStyle(new URLSearchParams(location.search).get('sound')),auditionStyle=soundStyle,playingStyle=null;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
function setUiBusy(busy){for(const n of $$('.gallery-ui'))n.inert=busy;}
function updateText(){
 const skin=skins[machine];$('#skinTitle').textContent=skin.title;$('#skinLead').innerHTML=skin.lead;$('#skinDescription').textContent=skin.description;
 $('#featureChips').replaceChildren(...skin.features.map(text=>{const s=document.createElement('span');s.textContent=text;return s;}));
 $('#objectCaption').textContent=classic?'经典免费外观 / 对照预览':skin.caption;
 $('#compareButton').setAttribute('aria-pressed',String(classic));$('#compareLabel').textContent=classic?'正在对照经典，返回星空皮肤':'切换经典外观，对比一下';
 for(const button of $$('[data-machine]'))button.setAttribute('aria-pressed',String(button.dataset.machine===machine));
 $('#actionNote').textContent=classic?'经典免费外观对照 · 空格开始':'免费预览 · 约 11 秒 · 空格开始';
}
function updateSound(){const on=!muted&&Number($('#volume').value)>0;$('#muteButton').textContent=on?'♫':'♩';$('#muteButton').setAttribute('aria-label',on?'关闭音效':'开启音效');$('#muteButton').setAttribute('aria-pressed',String(on));$('#volumeValue').textContent=$('#volume').value+'%';$('#soundStyleName').textContent=SOUND_STYLES[soundStyle].name;$('#soundStyleButton').setAttribute('aria-label',`当前音效${SOUND_STYLES[soundStyle].name}，选择其他音效`);$('#soundLevelLabel').textContent='同音量试听 · '+$('#volume').value+'%';audio.setEnabled(on);audio.setVolume(Number($('#volume').value)/100);}
function items(){return skins[machine].names.map((name,i)=>({id:`${machine}-${i}`,name,excluded:false,weight:1,stock:1}));}
function onSound(kind,energy){audio.event(kind,energy);}
function renderStage(){
 audio.select(machine,classic?'classic':'cosmic',soundStyle);updateText();
 try{stage?.dispose();stage=(classic?createClassicStage:createStellarStage)($('#scene'),()=>play(),onSound,false);stage.quality('high');stage.configure({machine,theme:classic?'classic':'cosmic',items:items(),mode:'normal',count:1});$('#loading')?.remove();$('#playButton').disabled=false;}
 catch(error){$('#playButton').disabled=true;toast('3D 预览未能加载，请刷新重试');console.error(error);}
}
function exitFullscreen(){if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});}
function reset(){
 token++;soundToken++;audio.stop();stage?.reset();phase='idle';document.body.classList.remove('running','has-result');$('#performance').hidden=true;$('#result').hidden=true;setUiBusy(false);exitFullscreen();$('#playButton').focus({preventScroll:true});
}
async function play(){
 if(!stage||phase==='busy'||$('#details').open||$('#soundDialog').open||disposed)return;
 const id=++token;soundToken++;audio.stop();audio.select(machine,classic?'classic':'cosmic',soundStyle);if(!muted)audio.arm();
 // The review runs edge-to-edge inside its tab so it can sit beside other previews.
 phase='busy';setUiBusy(true);document.body.classList.remove('has-result');document.body.classList.add('running');$('#result').hidden=true;$('#performance').hidden=false;$('#phaseLabel').textContent=skins[machine].phase;
 const pool=items(),random=new Uint32Array(1);crypto.getRandomValues(random);const winner=pool[Math.floor(random[0]/4294967296*pool.length)];
 try{
  if(!await stage.start())throw new Error('预览未能开始');
  if(!muted)audio.whenReady().then(ok=>{if(id===token&&!ok)toast('音频未能启动，可退出后点击试听重试');});
  await delay(6500);if(id!==token||disposed)return;$('#phaseLabel').textContent='让星光，为这一刻停留';stage.reveal([winner]);
  await delay(stage.revealDelay()+180);if(id!==token||disposed)return;
  phase='result';document.body.classList.remove('running');document.body.classList.add('has-result');$('#phaseLabel').textContent='';$('#resultName').textContent=winner.name;$('#result').hidden=false;$('#backButton').focus({preventScroll:true});
 }catch(error){if(id===token){reset();toast(error.message||'演出预览失败，请重试');}}
}
function updateSoundOptions(){
 for(const button of $$('[data-sound]')){
  const selected=button.dataset.sound===auditionStyle,playing=button.dataset.sound===playingStyle;
  button.setAttribute('aria-pressed',String(selected));button.classList.toggle('is-playing',playing);
  button.querySelector('.sound-listen').textContent=playing?'♫ 播放中':'▶ 试听';
 }
 $('#soundSelectionLabel').textContent='当前使用：'+SOUND_STYLES[soundStyle].name;
 $('#applySoundStyle').textContent='使用'+SOUND_STYLES[auditionStyle].name+' ↗';
 $('#stopAudition').disabled=!playingStyle;
}
function stopAudition(message='试听已停止，可继续选择。'){
 soundToken++;audio.stop();playingStyle=null;updateSoundOptions();$('#auditionStatus').textContent=message;
}
function openSoundChooser(){
 if(phase==='busy')return;stopAudition('点击一款试听，约 6 秒，包含运转与揭晓。');auditionStyle=soundStyle;updateSoundOptions();
 $('#soundMachineLabel').textContent=skins[machine].title;$('#machineSoundDescription').textContent=MACHINE_SOUND_PROFILES[machine].label;$('#soundDialog').showModal();
}
async function audition(style){
 if(phase==='busy'||!$('#soundDialog').open)return;
 stopAudition();auditionStyle=validSoundStyle(style);playingStyle=auditionStyle;const id=soundToken;
 audio.select(machine,classic?'classic':'cosmic',auditionStyle);muted=false;if(Number($('#volume').value)===0)$('#volume').value=String(lastVolume||80);updateSound();updateSoundOptions();
 $('#auditionStatus').textContent='正在唤醒音频…';audio.arm();const ok=await audio.whenReady();if(id!==soundToken||disposed)return;
 if(!ok){stopAudition('音频未能启动，请再次点击试听。');return;}
 $('#auditionStatus').textContent='正在试听：'+SOUND_STYLES[auditionStyle].name+' · 机台运转';audio.event(`${machine}-start`);
 for(let i=0;i<26;i++){
  await delay(170);if(id!==soundToken||disposed)return;
  const base=machine==='sphere'?5:machine==='wheel'?9:1;
  const energy=.25+.75*Math.sin((i+1)/27*Math.PI);
  audio.event('motion-'+machine,{phase:'spin',speed:base*energy});audio.event(machine,energy);
  if(i===22&&machine==='capsule')audio.event('capsule-exit');
  if(i===25&&machine!=='capsule')audio.event(machine+'-land');
 }
 if(id!==soundToken||disposed)return;$('#auditionStatus').textContent='正在试听：'+SOUND_STYLES[auditionStyle].name+' · 星光揭晓';
 audio.event(machine==='capsule'?'capsule-open':`${machine}-reveal`);
 await delay(1500);if(id===soundToken)stopAudition('试听结束。喜欢这款，就把它带进机台。');
}
$('#soundOptions').innerHTML=Object.entries(SOUND_STYLES).map(([key,p],i)=>`<button type="button" class="sound-option" data-sound="${key}" aria-pressed="false" aria-label="试听${p.name}"><span class="sound-art" aria-hidden="true">${['✧','✦','◎','◒'][i]}</span><span class="sound-info"><strong>${p.name}<em>${p.tag}</em></strong><small>${p.character}</small><p>${p.description}</p></span><span class="sound-listen">▶ 试听</span></button>`).join('');
$('#soundPreview small').textContent=Object.keys(SOUND_STYLES).length+' 款';
for(const button of $$('[data-sound]'))button.onclick=()=>audition(button.dataset.sound);
$('#stopAudition').onclick=()=>stopAudition();$('#closeSoundDialog').onclick=()=>$('#soundDialog').close();
$('#soundDialog').addEventListener('close',()=>{stopAudition();audio.select(machine,classic?'classic':'cosmic',soundStyle);});
$('#applySoundStyle').onclick=()=>{
 soundStyle=auditionStyle;const url=new URL(location.href);url.searchParams.set('sound',soundStyle);history.replaceState(null,'',url);updateSound();$('#soundDialog').close();toast('已使用'+SOUND_STYLES[soundStyle].name+'，可体验完整演出');
};
for(const button of $$('[data-machine]'))button.onclick=()=>{if(phase==='busy')return;reset();machine=button.dataset.machine;classic=false;history.replaceState(null,'','#'+machine);renderStage();};
$('#compareButton').onclick=()=>{if(phase==='busy')return;reset();classic=!classic;renderStage();};
$('#playButton').onclick=play;$('#againButton').onclick=play;$('#backButton').onclick=reset;$('#exitPerformance').onclick=reset;$('#soundPreview').onclick=openSoundChooser;$('#soundStyleButton').onclick=openSoundChooser;
$('#volume').oninput=()=>{const v=Number($('#volume').value);if(v>0)lastVolume=v;muted=v===0;updateSound();};
$('#muteButton').onclick=()=>{stopAudition();muted=!muted;if(!muted&&Number($('#volume').value)===0)$('#volume').value=String(lastVolume);updateSound();toast(muted?'音效已关闭':'音效已开启，开始演出或选择试听');};
$('#detailContent').innerHTML=Object.entries(skins).map(([key,skin])=>`<article class="detail-item"><h3>${skin.title} <span>${key==='capsule'?'现有主题的新演出方向':'新增付费皮肤概念'}</span></h3><p>${skin.detail}</p></article>`).join('');
$('#detailButton').onclick=()=>{soundToken++;audio.stop();$('#details').showModal();};$('#closeDetails').onclick=()=>$('#details').close();$('#detailTry').onclick=()=>$('#details').close();
document.addEventListener('keydown',event=>{const inDialog=$('#details').open||$('#soundDialog').open;if(event.code==='Escape'&&phase!=='idle'&&!inDialog){event.preventDefault();reset();return;}if(event.code!=='Space'||event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||inDialog||event.target?.closest('button,input,select,textarea,a,[contenteditable]'))return;event.preventDefault();play();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudition('页面已离开，试听已停止。');});
window.addEventListener('pagehide',()=>{disposed=true;token++;soundToken++;audio.dispose();stage?.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
updateSoundOptions();updateSound();renderStage();

// The next review supersedes these ambient studies; preserve this visual prototype.
function openGameAudioReview(){audio.stop();location.href=`./theme-experience.html?theme=${classic?'default':'cosmic'}&machine=${machine}`;}
$('#soundPreview').innerHTML='♫ 完整体验 <small>三选一</small>';
$('#soundPreview').setAttribute('aria-label','打开新版游戏音效评审');
$('#soundPreview').onclick=openGameAudioReview;$('#soundStyleButton').onclick=openGameAudioReview;
