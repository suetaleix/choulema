import {createStage as createClassicStage} from '/v6/stage.js?v=v7-fullstage-1';
import {createStage as createCosmicStage} from './stellar-stage.js?v=1';
import {createGameAudio} from './game-audio-runtime.mjs';
import {CANDIDATES,MACHINES,validCandidate,validMachine} from './game-audio-score.mjs';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],delay=t=>new Promise(r=>setTimeout(r,t));
const params=new URLSearchParams(location.search);
let candidate=validCandidate(params.get('take')),machine=validMachine(location.hash.slice(1)),theme='classic',stage,mode='idle',token=0,disposed=false,muted=false,previousVolume=80,rewardAt=0;
const audio=createGameAudio(),reel=$('#reel');
const names={capsule:['火锅','寿司','烤肉','披萨','饺子','沙拉','甜点','咖喱饭'],wheel:['咖啡券','电影票','鲜花','保温杯','蓝牙音箱','纪念徽章','帆布袋','甜点'],sphere:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远','苏念','陆景行','顾星河','叶清禾','江南','程子衿','夏知秋','方以宁','宋见山','温予安','白露','唐予墨','余小溪','许星野','安可','谢听澜','林沐阳','沈初晴','何望舒','陈遇']};
function items(){return names[machine].map((name,id)=>({id:'demo-'+id,name,weight:1,stock:1,excluded:false}));}
function status(text,phase){$('#status').textContent=text;for(const n of $$('[data-phase]'))n.classList.toggle('active',n.dataset.phase===phase);}
function controls(){const busy=mode!=='idle';$('#stop').disabled=!busy;$('#play').disabled=mode==='loading'||!stage;$('#reward').disabled=mode==='loading';$('#audioState').textContent=mode==='loading'?'正在载入样音':busy?'正在播放':'等待试听';}
function update(){
 const p=CANDIDATES[candidate];document.documentElement.style.setProperty('--accent',p.color);$('#currentCandidate').textContent=candidate.toUpperCase()+' / '+p.name;$('#processNote').textContent=p.process;$('#rewardNote').textContent=p.reward;
 for(const b of $$('[data-take]'))b.setAttribute('aria-pressed',String(b.dataset.take===candidate));
 for(const b of $$('[data-machine]'))b.setAttribute('aria-pressed',String(b.dataset.machine===machine));
 for(const b of $$('[data-theme]'))b.setAttribute('aria-pressed',String(b.dataset.theme===theme));
 reel.src='./game-audio/'+candidate+'-reel.ogg';$('#download').href=reel.getAttribute('src');$('#download').download=candidate.toUpperCase()+'-'+p.name+'.ogg';
 const url=new URL(location.href);url.searchParams.set('take',candidate);url.hash=machine;history.replaceState(null,'',url);controls();
}
function volume(){const v=Number($('#volume').value);$('#volumeValue').textContent=v+'%';const gain=muted?0:v/100;audio.setVolume(gain);reel.volume=gain;$('#mute').textContent=muted?'♩':'♫';$('#mute').setAttribute('aria-label',muted?'开启声音':'关闭声音');}
function stop(text='试听已停止。'){
 token++;audio.stop();reel.pause();stage?.reset();mode='idle';$('#result').hidden=true;status(text);controls();
}
function stageSound(kind,value){
 if(mode!=='live')return;audio.event(kind,value);
 if(kind.endsWith('-start'))status('按下确认 · 机台启动','press');
 else if(kind.startsWith('motion-')&&value.phase==='spin')status('机台运转 · 听动作与力度','spin');
 else if(kind.startsWith('motion-')&&value.phase==='reveal'&&!rewardAt)status('减速收束 · 等待落点','coast');
 else if(kind.endsWith('-exit'))status('胶囊出仓 · 滚动落位','coast');
 else if(kind.endsWith('-land'))status('动作落点 · 准备揭晓','coast');
 else if(kind.endsWith('-open')||kind.endsWith('-reveal')){rewardAt=performance.now();status('奖励短句 · 揭晓结果','reward');}
}
function renderStage(){
 stage?.dispose();
 try{stage=(theme==='cosmic'?createCosmicStage:createClassicStage)($('#scene'),()=>play('live'),stageSound,false);stage.quality('high');stage.configure({machine,theme,items:items(),mode:'normal',count:1});}
 catch(error){stage=null;status('3D 未能加载，仍可播放下方纯音样例。');console.error(error);}
 controls();
}
async function play(type){
 stop();const id=token;mode='loading';controls();status('正在准备 '+CANDIDATES[candidate].name+'…');
 try{
  const [ready]=await Promise.all([audio.arm(),audio.prepare(candidate)]);if(!ready)throw Error('音频未能启动，请再次点击');
  if(id!==token||disposed)return;audio.select(candidate,machine);mode=type;controls();
  if(type==='reward'){
   status('单听揭晓 · '+CANDIDATES[candidate].reward,'reward');audio.reward();await delay(2350);
  }else{
   if(!stage)throw Error('3D 尚未就绪，可试听下方纯音');rewardAt=0;
   if(!await stage.start())throw Error('演出未能开始');await delay(6500);if(id!==token||disposed)return;
   const winner=items()[2];stage.reveal([winner]);await delay(stage.revealDelay()+180);if(id!==token||disposed)return;
   $('#winner').textContent=winner.name;$('#result').hidden=false;
   await delay(Math.max(0,2250-(performance.now()-(rewardAt||performance.now()))));
  }
  if(id!==token||disposed)return;audio.stop();mode='idle';status('试听结束 · 可以切换方案对比');controls();
 }catch(error){if(id!==token||disposed)return;stop(error.message||'声音加载失败，请重试');}
}
$('#candidates').innerHTML=Object.entries(CANDIDATES).map(([key,p])=>`<button class="candidate" data-take="${key}" style="--tone:${p.color}" aria-pressed="false" aria-label="选择方案 ${key.toUpperCase()} ${p.name}"><span class="letter">${key.toUpperCase()}</span><span><strong>${p.name}</strong><small>${p.tag}</small><p>${p.description}</p></span></button>`).join('');
for(const b of $$('[data-take]'))b.onclick=()=>{stop('已选择 '+CANDIDATES[b.dataset.take].name+'，点击完整演出或只听揭晓。');candidate=b.dataset.take;update();};
for(const b of $$('[data-machine]'))b.onclick=()=>{stop();machine=b.dataset.machine;renderStage();update();status('当前机台：'+MACHINES[machine]);};
for(const b of $$('[data-theme]'))b.onclick=()=>{stop();theme=b.dataset.theme;renderStage();update();status('外观已切换，声音仍为当前候选方案。');};
$('#play').onclick=()=>play('live');$('#reward').onclick=()=>play('reward');$('#stop').onclick=()=>stop();
$('#volume').oninput=()=>{if(Number($('#volume').value)>0)previousVolume=Number($('#volume').value);muted=Number($('#volume').value)===0;volume();};
$('#mute').onclick=()=>{muted=!muted;if(!muted&&Number($('#volume').value)===0)$('#volume').value=String(previousVolume);volume();};
reel.addEventListener('play',()=>{token++;audio.stop();stage?.reset();$('#result').hidden=true;mode='reel';status('纯音对比 · 统一胶囊动作，11 秒');controls();});
reel.addEventListener('ended',()=>{mode='idle';status('纯音试听结束 · 可切换候选对比');controls();});
reel.addEventListener('pause',()=>{if(mode==='reel'){mode='idle';status('纯音试听已暂停');controls();}});
reel.addEventListener('error',()=>{if(mode==='reel'||reel.error){mode='idle';status('纯音加载失败，可刷新重试或使用上方试听');controls();}});
for(const select of [$('#defaultChoice'),$('#cosmicChoice')])for(const [key,p] of Object.entries(CANDIDATES)){const option=document.createElement('option');option.value=key;option.textContent=key.toUpperCase()+' / '+p.name;select.append(option);}
try{const saved=JSON.parse(localStorage.getItem('v7-game-audio-review')||'null');if(saved){if(Object.hasOwn(CANDIDATES,saved.default))$('#defaultChoice').value=saved.default;if(Object.hasOwn(CANDIDATES,saved.cosmic))$('#cosmicChoice').value=saved.cosmic;}}catch{}
$('#saveChoices').onclick=()=>{const picks={default:$('#defaultChoice').value,cosmic:$('#cosmicChoice').value};try{localStorage.setItem('v7-game-audio-review',JSON.stringify(picks));$('#choiceStatus').textContent='已记录本机选择，正式主题尚未更改。';}catch{$('#choiceStatus').textContent='浏览器未允许保存，可直接告诉我两个方案字母。';}};
document.addEventListener('keydown',event=>{if(event.code==='Escape'){stop();return;}if(event.code==='Space'&&!event.repeat&&!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.target.closest('button,input,select,textarea,a,audio,[contenteditable]')){event.preventDefault();play('live');}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('离开页面后已停止声音。');});
window.addEventListener('pagehide',()=>{disposed=true;token++;audio.dispose();reel.pause();stage?.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
update();volume();renderStage();
