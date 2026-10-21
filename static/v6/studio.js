import {icon as uiIcon} from '/v7/ui.js';
import {createFeedback} from '/v7/feedback.mjs';
import {createPanelHistory} from '/v7/panel-navigation.mjs?v=v7-panel-race-1';
import {invitationPosterModel,invitationPosterBlob} from '/v7/invite-poster.mjs';
import {createStage} from '/v7/theme-stage.mjs?v=ui-polish-20261007';
import {CONTENT,themeSounds,soundFor,audioConfig,appearanceProblem,accessProblem,capabilityAllowed} from '/v7/content-catalog.mjs';
import {scopedStorage, importGuestDrafts} from './draft-storage.mjs';
import {SHARED_PROFILE} from './machine-profiles.mjs?v=ce-contrast-1';
import {initInteractionDiagnostics, recordInteractionDiagnostic} from './interaction-diagnostics.mjs';
import {createSoundRuntime} from '/v7/game-audio.mjs?v=theme-release-1';

initInteractionDiagnostics();

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const uid=()=>crypto.randomUUID();
const displayId=new URLSearchParams(location.search).get('display');
const controllerId=sessionStorage.getItem('clm-controller')||uid();sessionStorage.setItem('clm-controller',controllerId);
let waitingForStop=false,stopRequested=false;
let completedGroupRunId=null;
const copy=v=>JSON.parse(JSON.stringify(v));
const initialAccount=displayId?{kind:'guest',features:[],draft_scope:'guest:0'}:await fetch('/api/v6/status',{credentials:'same-origin'}).then(async r=>{if(!r.ok){const error=await r.json().catch(()=>({}));if(r.status===403&&error.must_change_password){const next=location.pathname+location.search+location.hash;location.replace('/login.html?mode=password&next='+encodeURIComponent(next));throw new Error('正在前往修改密码页面…');}throw new Error(error.error||'账号状态暂时不可用，请刷新重试');}const d=await r.json();if(!d.draft_scope)throw new Error('服务版本已更新，请重启服务后刷新');return d;}).catch(e=>{$('#stageLoading').textContent=e.message;throw e;});
if(initialAccount.kind==='user'&&!initialAccount.role){try{const response=await fetch('/api/me',{credentials:'same-origin'});if(response.ok)initialAccount.role=(await response.json()).user?.role;}catch{}}
const privateStorage=scopedStorage(localStorage,initialAccount.draft_scope);
let draftImportFailed=false;
for(const source of initialAccount.guest_draft_scopes||[]){try{importGuestDrafts(localStorage,source,initialAccount.draft_scope);}catch{draftImportFailed=true;}}
const storage={get:(k,fallback)=>privateStorage.get(k,fallback),set(k,v){try{privateStorage.set(k,v);}catch{toast('设备存储不可用，请登录保存重要配置');}}};
if(!displayId){
 try{localStorage.setItem('clm-session-scope',initialAccount.draft_scope);}catch{}
 window.addEventListener('storage',e=>{if(e.key==='clm-session-scope'&&e.newValue!==initialAccount.draft_scope)location.reload();});
}
const APPS={
 food:{title:'今天吃点什么？',subtitle:'不纠结，抽一下。让一颗胶囊替你决定。',button:'抽一道',name:'今天吃什么',items:['火锅','饺子','寿司','螺蛳粉','烤肉','麻辣烫','披萨','沙拉'],modes:{normal:'等概率 · 随机选择',no_repeat:'本轮不重复',weighted:'按公开权重'},presets:{午饭:['盖浇饭','面条','饺子','便当','炒饭','米线'],朋友聚餐:['火锅','烤肉','粤菜','披萨','川菜','自助餐']}},
 play:{title:'下一站，玩点什么？',subtitle:'给平凡的一天，抽一个不一样的选择。',button:'抽个玩法',name:'今天玩什么',items:['逛书店','打羽毛球','看电影','玩桌游','去散步','一起做饭','骑自行车','逛展览'],modes:{normal:'等概率 · 随机选择',no_repeat:'本轮不重复'},presets:{双人:['逛书店','看电影','打羽毛球','一起做饭','玩桌游','逛展览'],宅家:['玩桌游','看电影','拼拼图','听音乐','一起做饭','做手工'],运动:['打羽毛球','骑自行车','打乒乓球','跳绳','去散步']}},
 prize:{title:'让好运，找到主人。',subtitle:'一份期待，一次揭晓。每一份好运都有记录。',button:'开始抽奖',name:'幸运抽奖',items:['保温杯','电影票','咖啡券','帆布袋','蓝牙音箱','纪念徽章'],modes:{inventory:'从奖品池抽奖品 · 按库存',normal:'从奖品池随机选一个',weighted:'奖品按公开权重',winners:'给奖品抽获奖人'},presets:{年会:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远']}},
 person:{title:'下一位，就是你。',subtitle:'让每个名字，都有被看见的机会。',button:'开始点名',name:'我的班级',items:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远'],modes:{no_repeat:'本轮不重复点名',groups:'随机均衡分组'},presets:{课堂:['林小夏','陈一诺','周可可','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','许知远'],小组讨论:['第一位','第二位','第三位','第四位','第五位','第六位','第七位','第八位','第九位','第十位']}}
};
const defaults=key=>({title:APPS[key].name,app:key,mode:Object.keys(APPS[key].modes)[0],machine:key==='person'?'sphere':'capsule',theme:'classic',count:1,group_count:2,items:APPS[key].items.map(name=>({id:uid(),name,weight:1,stock:1,excluded:false,tags:[]})),awards:[],cross_award_unique:true,brand:'',accent:'#a3ff70'});
const query=new URLSearchParams(location.search);
const requestedApp=query.get('app')||query.get('scene');
let appKey=APPS[requestedApp]?requestedApp:storage.get('clm-app','food');if(!APPS[appKey])appKey='food';
let draft=storage.get('clm-drafts',{}), config=draft[appKey]?.config||defaults(appKey), run=draft[appKey]?.run||null;
let saved=draft[appKey]?.saved||null, busy=false, dirty=false, stage=null, result=null, resultPageMeta=null, paginationReady=false, skip=false, timer=null, pendingRequest=draft[appKey]?.pendingRequest||null, account=initialAccount,muted=storage.get('clm-muted',false),preview=draft[appKey]?.preview||null,pace=storage.get('clm-draw-pace','standard')==='calm'?'calm':'standard';
if($('#adminLink'))$('#adminLink').hidden=displayId||account.role!=='superadmin';
let appearanceBusy=false;
let formMode=config.mode;
let orderTimer=null,modalVersion=0,modalPanel='',suppressedModalCloses=0,modalCleanup=null;
const panelHistory=createPanelHistory(window.history,window.location,['settings','shop','invite','panel']);
function stopOrderWatch(){soundRuntime.stop();clearTimeout(orderTimer);orderTimer=null;modalVersion++;modalCleanup?.();modalCleanup=null;}
function setPerformanceMode(active){
 const panel=$('.stage-panel');if(!panel)return;
 panel.classList.toggle('busy',active);
 const hiddenControls=active||panel.classList.contains('result-visible');
 for(const selector of ['.game-top','.machine-rail','.game-tool-rail','.game-invite','.game-tools','.stage-bottom','#settingsPanel']){
  const node=$(selector);if(node)node.inert=selector==='#settingsPanel'?!node.classList.contains('open')||active:hiddenControls;
 }
}
function syncGameFullscreen(){
 const panel=$('.stage-panel'),button=$('#fullscreenButton');if(!panel||!button)return;
 const mode=document.fullscreenElement===panel?'native':panel.classList.contains('immersive')?'page':'none';
 panel.dataset.fullscreenMode=mode;button.setAttribute('aria-pressed',String(mode!=='none'));
 button.title=mode==='native'?'退出全屏':mode==='page'?'退出页面沉浸':'进入全屏';
}
function hideGameControls(){
 // A keyboard user must have time to reach and activate the exit control.
 if(document.activeElement?.closest?.('#edgeReveal,#touchExit'))return;
 $('.stage-panel')?.classList.remove('controls-visible');
}
function requestGameFullscreen(){
 const panel=$('.stage-panel');if(!panel)return;
 panel.classList.add('immersive','controls-visible');document.body.classList.add('in-performance');
 clearTimeout(controlsTimer);controlsTimer=setTimeout(hideGameControls,2400);
 syncGameFullscreen();
 if(!document.fullscreenElement&&panel.requestFullscreen){try{const request=panel.requestFullscreen();request?.then(syncGameFullscreen,syncGameFullscreen);}catch{syncGameFullscreen();}}
}
function leaveGameFullscreen(){
 const panel=$('.stage-panel');panel?.classList.remove('immersive','controls-visible');document.body.classList.remove('in-performance');
 if(document.fullscreenElement)document.exitFullscreen?.().then(syncGameFullscreen,syncGameFullscreen);
 syncGameFullscreen();
}
function toggleGameFullscreen(){
 if(document.fullscreenElement||$('.stage-panel')?.classList.contains('immersive'))leaveGameFullscreen();else requestGameFullscreen();
}
document.addEventListener('fullscreenchange',()=>{
 const panel=$('.stage-panel');if(!panel)return;
 if(!document.fullscreenElement&&document.body.classList.contains('in-performance')){panel.classList.remove('immersive','controls-visible');document.body.classList.remove('in-performance');}
 else if(document.fullscreenElement===panel){panel.classList.add('immersive');document.body.classList.add('in-performance');}
 syncGameFullscreen();
});
let selectedAward=draft[appKey]?.selectedAward||'';
function syncSoundButton(state){
 const button=$('#muteButton');
 const label=state==='muted'?'音效已关闭，点击开启并试听':state==='unavailable'?'音效未能启动，点击重试':state==='pending'?'音效待启动，点击重试':state==='ready'?'音效已开启，点击关闭':'音效已开启，抽取时播放';
 button.textContent=state==='muted'?'♩':state==='unavailable'||state==='pending'?'♪!':'♪';
 button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(!muted));button.title=label;
 recordInteractionDiagnostic(`audio ${state}`);
}
const soundRuntime=createSoundRuntime(undefined,syncSoundButton,undefined,phase=>{const data=$('#stage').dataset;data.audioPhase=phase;if(phase==='motion')data.audioStarts=String((Number(data.audioStarts)||0)+1);if(phase==='reveal'){data.audioReveals=String((Number(data.audioReveals)||0)+1);data.lastRevealSound=config.sound;}});
soundRuntime.setMuted(muted);
soundRuntime.setHidden(document.hidden);
let soundVolume=Math.max(0,Math.min(1,Number(storage.get('clm-sound-volume',.8))||0));
soundRuntime.volume(soundVolume);
function configureSound(){config.sound=soundFor(config.theme,config.sound||storage.get('clm-theme-sounds',{})[config.theme]);soundRuntime.configure(audioConfig(config));$('#stage').dataset.sound=config.sound;}
async function api(path,body,headers={}){
 const response=await fetch('/api'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(!displayId&&path.startsWith('/v6/')?{'X-Draft-Scope':initialAccount.draft_scope}:{}),...headers},body:body?JSON.stringify(body):undefined});
 let data;try{data=await response.json();}catch{throw new Error('服务暂时不可用，请稍后重试');}
 if(!response.ok){const detail=Array.isArray(data.detail)?data.detail.map(e=>e.msg).join('；'):data.detail;const error=new Error(data.error||detail||'操作失败');error.status=response.status;throw error;}return data;
}
function toast(message){const node=$('#toast'),parent=$('#modal')?.open?$('#modal'):document.fullscreenElement||document.body;if(node.parentElement!==parent)parent.append(node);clearTimeout(timer);node.textContent=message;node.hidden=false;timer=setTimeout(()=>node.hidden=true,4200);}
function persist(){if(displayId)return;draft={...storage.get('clm-drafts',{}),[appKey]:{config,run,saved,pendingRequest,preview,selectedAward,touched:!!draft[appKey]?.touched}};storage.set('clm-drafts',draft);storage.set('clm-app',appKey);}
function openModalHistory(key){
 if(displayId)return;
 // A native dialog queues its close event. Consume its old history before a
 // quick reopen so that closing the new panel cannot reveal the stale panel.
 if(modalPanel&&!$('#modal').open)panelHistory.close(modalPanel);
 modalPanel=key;panelHistory.open(key);
}
function openModal(title){
 stopOrderWatch();
 const modal=$('#modal');
 if(!modal.open)openModalHistory(title==='机台与主题'?'shop':title==='邀请好友'?'invite':'panel');
 $('#modalTitle').textContent=title;
 const previousBody=$('#modalBody'),body=previousBody.cloneNode(false);previousBody.replaceWith(body);
 if(!modal.open)modal.showModal();
 return body;
}
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function itemRow(parent,title,desc,label,action){const row=element('div',undefined,'modal-item'),txt=element('div');txt.append(element('b',title),element('p',desc));row.append(txt);if(label){const btn=element('button',label);btn.onclick=()=>Promise.resolve(action()).catch(e=>toast(e.message));row.append(btn);}parent.append(row);return row;}
function confirmAction(message){
 return new Promise(resolve=>{const d=document.createElement('dialog');const heading=element('h2','确认操作');heading.style.fontSize='18px';d.append(heading,element('p',message,'modal-copy'));const buttons=element('div',undefined,'panel-actions'),cancel=element('button','保持当前'),ok=element('button','确认继续','solid');buttons.append(cancel,ok);d.append(buttons);document.body.append(d);const finish=value=>{d.close();d.remove();resolve(value);};cancel.onclick=()=>finish(false);ok.onclick=()=>finish(true);d.oncancel=e=>{e.preventDefault();finish(false);};d.showModal();});
}
function askReason(message){return new Promise(resolve=>{const d=document.createElement('dialog'),input=document.createElement('textarea');input.setAttribute('aria-label','弃奖原因');d.append(element('p',message,'modal-copy'),input);const row=element('div',undefined,'panel-actions'),cancel=element('button','取消'),ok=element('button','记录弃奖');row.append(cancel,ok);d.append(row);document.body.append(d);const finish=v=>{d.close();d.remove();resolve(v);};cancel.onclick=()=>finish(null);ok.onclick=()=>{if(input.value.trim())finish(input.value.trim());};d.oncancel=e=>{e.preventDefault();finish(null);};d.showModal();});}

function markedResult(state,data){return {...data,forfeited:state.events.filter(e=>e.kind==='forfeit'&&e.payload.draw_id===data.id).map(e=>e.payload.candidate_id)};}
function updateResultPaginationControls(){
 const shown=resultPageMeta&&resultPageMeta.total>1;
 $('#resultPagination').hidden=!shown;
 const blocked=busy||!paginationReady;
 $('#resultPrevious').disabled=blocked||!resultPageMeta||resultPageMeta.page<=0;
 $('#resultNext').disabled=blocked||!resultPageMeta||resultPageMeta.page>=resultPageMeta.pageCount-1;
 $$('#groupResult button').forEach(button=>{button.disabled=blocked;});
 $('#resultPageInfo').textContent=shown?`共 ${resultPageMeta.total}${resultPageMeta.kind==='groups'?' 组':' 项'} · ${resultPageMeta.page+1}/${resultPageMeta.pageCount} 页`:'';
}
function clearResultPagination(){
 recordInteractionDiagnostic('clearResultPagination-entry',{hidden:$('#result').hidden});
 result=null;resultPageMeta=null;paginationReady=false;$('#resultPagination').hidden=true;$('.stage-panel').classList.remove('result-visible');setPerformanceMode(busy);
 $('#resultPageInfo').textContent='';$('#resultPrevious').disabled=true;$('#resultNext').disabled=true;
 $('#multiResult').replaceChildren();$('#groupResult').replaceChildren();
}
function resultPageChanged(event){
 const info=event.detail;
 if(!info){resultPageMeta=null;updateResultPaginationControls();return;}
 resultPageMeta={...info};
 const list=$('#multiResult'),groups=$('#groupResult');list.replaceChildren();groups.replaceChildren();
 if(info.kind==='results'){
  const data=result,forfeited=new Set(data?.forfeited||[]),counts=new Map();
  (data?.results||[]).forEach(item=>counts.set(item.name,(counts.get(item.name)||0)+1));
  const items=(data?.results||[]).slice(info.start,info.end),multiple=(data?.results?.length||0)>1;
  list.hidden=!multiple;$('#result').classList.toggle('multiple',multiple);
  items.forEach(item=>{
   const li=element('li'),name=element('span',item.name+(forfeited.has(item.id)?'（已弃奖）':''));li.append(name);
   if(counts.get(item.name)>1)li.append(element('small','编号 '+item.id));list.append(li);
  });
 }else{
  list.hidden=true;$('#result').classList.add('multiple');
  const groupsInSnapshot=result?.groups||[],counts=new Map();
  groupsInSnapshot.flat().forEach(item=>counts.set(item.name,(counts.get(item.name)||0)+1));
  groupsInSnapshot.slice(info.start,info.end).forEach((members,offset)=>{
   const index=info.start+offset,card=element('section',undefined,'result-group-entry'),heading=element('strong',`第 ${index+1} 组 · ${members.length} 人`);
   const button=element('button','查看完整名单');button.type='button';button.disabled=busy||!paginationReady;
   button.onclick=()=>showGroupMembers(index,counts);card.append(heading,button);groups.append(card);
  });
 }
 updateResultPaginationControls();
}
function showGroupMembers(index,counts){
 const snapshot=result,members=snapshot?.groups?.[index];if(!members)return;
 const body=openModal(`第 ${index+1} 组 · ${members.length} 人`);
 members.forEach(item=>body.append(element('p',counts.get(item.name)>1?`${item.name}（编号 ${item.id}）`:item.name,'modal-copy result-member-name')));
}
function changeResultPage(page){
 if(busy||!paginationReady||!stage||!resultPageMeta)return;
 stage.showResultPage(page);
}
function showResult(data,animate=false){
 recordInteractionDiagnostic('showResult-entry',{hidden:$('#result').hidden});
 const stageAtShow=stage;
 result=data;resultPageMeta=null;paginationReady=!animate;
 if(data.groups?.length&&run)completedGroupRunId=run.id;
 const forfeited=new Set(data.forfeited||[]),multiple=!data.groups?.length&&data.results.length>1;
 $('#resultKicker').textContent=(data.rehearsal?'演练 · ':'')+(data.award||'这次就选');
 $('#resultName').textContent=data.groups?.length?'分组完成':multiple?`本轮 ${data.results.length} 项结果`:(data.results[0]?.name||'')+(forfeited.has(data.results[0]?.id)?'（已弃奖）':'');
 $('#acceptButton').textContent=data.groups?.length?'新一轮分组':'再抽一次';
 $('#acceptButton').setAttribute('aria-label',data.groups?.length?'保留本轮记录并开始新一轮分组':'保留本次结果并再抽一次');
 $('#multiResult').replaceChildren();$('#multiResult').hidden=!multiple;$('#groupResult').replaceChildren();
 $('#result').classList.toggle('multiple',multiple||!!data.groups?.length);$('#result').hidden=false;$('.stage-panel').classList.add('result-visible');setPerformanceMode(busy);updateResultPaginationControls();
 if(data.groups?.length)stageAtShow?.revealGroups(data.groups);
 else stageAtShow?.reveal(data.results.map(item=>({...item,name:forfeited.has(item.id)?'已弃奖·'+item.name:item.name})),!forfeited.size);
 if(animate){$('#result').hidden=true;return (async()=>{
  const until=performance.now()+(stageAtShow?.revealDelay()||0);
  while(result===data&&stage===stageAtShow&&!skip&&!$('#reduceMotion').checked&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,40));
  const sameSnapshot=result===data&&stage===stageAtShow,reduced=$('#reduceMotion').checked;
  if(sameSnapshot){
   if(skip||reduced)stageAtShow?.finishReveal();
   $('#result').hidden=false;paginationReady=true;updateResultPaginationControls();
  }
  recordInteractionDiagnostic('showResult-animation-end',{sameSnapshot,skip,reduced,hidden:$('#result').hidden});
 })();}
 if((skip||!animate)&&result===data&&stage===stageAtShow)stageAtShow?.finishReveal();paginationReady=true;updateResultPaginationControls();
}
function paint(){
 formMode=config.mode;
 configureSound();
 clearResultPagination();
 $('.stage-panel').classList.toggle('cosmic-stage',CONTENT.themes[config.theme]?.renderer==='cosmic');
 const meta=APPS[appKey];$('#sceneTitle').textContent=meta.title;$('#sceneSubtitle').textContent=meta.subtitle;$('#sceneNumber').textContent=String(Object.keys(APPS).indexOf(appKey)+1).padStart(2,'0');
 $$('.app').forEach(b=>b.classList.toggle('active',b.dataset.app===appKey));$$('[data-machine]').forEach(b=>{const key=b.dataset.machine,reason=machineProblem(key);b.classList.toggle('active',key===config.machine);b.hidden=key==='sphere'&&!['person','prize'].includes(appKey)&&config.machine!==key;b.disabled=!!reason;b.title=reason||'切换机台，保留当前规则和轮次';b.setAttribute('aria-label',(CONTENT.machines[key]?.name||key)+(reason?' · '+reason:CONTENT.machines[key]?.feature?' · 增值机台':' · 免费'));});
 $('#drawButton strong').textContent=nextDrawLabel();$('#configTitle').value=config.title;
 $('#drawMode').replaceChildren(...Object.entries(meta.modes).map(([v,t])=>{const o=element('option',t);o.value=v;return o;}));$('#drawMode').value=config.mode;
 $('#drawCount').value=config.count;$('#drawCount').disabled=['food','play'].includes(appKey);$('#groupCount').value=config.group_count;$('#groupField').hidden=config.mode!=='groups';
 $('#candidates').value=config.items.map(i=>(i.excluded?'!':'')+i.name+(config.mode==='inventory'?','+i.stock:config.mode==='weighted'?','+i.weight:'')+(i.tags||[]).map(t=>' #'+t).join('')).join('\n');
 $('#candidateHelp').textContent=config.mode==='inventory'?'每行：奖品名称,库存；例如 保温杯,3':config.mode==='weighted'?'每行：选项名称,权重；默认权重为 1':'每行一项；行首加 ! 临时排除。重名按编号区分。';
 $('#prizeSettings').hidden=config.mode!=='winners';$('.brand-files').classList.toggle('visible',config.mode==='winners');renderBrand(config);$('#awards').value=config.awards.map(a=>`${a.name},${a.count}`).join('\n');$('#crossUnique').checked=config.cross_award_unique;$('#brandTitle').value=config.brand;
 const award=selectedAward||$('#currentAward').value;$('#currentAward').replaceChildren(...config.awards.map(a=>{const o=element('option',a.name);o.value=a.id;return o;}));if(config.awards.some(a=>a.id===award))$('#currentAward').value=award;
 $('#rehearsal').checked=!!run?.rehearsal||!!preview;$('#modeBadge').textContent=(run?.rehearsal||preview?'演练 · ':'')+(CONTENT.themes[config.theme]?.name||config.theme);$('#modeBadge').classList.toggle('preview-banner',!!preview);
 const count=config.items.filter(i=>!i.excluded).length;$('#poolBadge').textContent=config.machine==='sphere'?`${count} 个候选 · 全部组成姓名球`:count>48?`${count} 个候选 · 动画展示其中 48 个`:`${count} 个候选`;$('#candidateCount').textContent=`${count} 项参与`;
 $('#drawContext').textContent=config.mode==='groups'?`随机均衡分组 · ${config.group_count} 组`:`${meta.modes[config.mode]} · 每次 ${config.count} 个`;
 $('#presets').replaceChildren();Object.entries(meta.presets).forEach(([name,names])=>{const b=element('button',name);b.onclick=()=>guard(async()=>{if(run&&!await confirmAction('使用预设会保留旧记录，并开始新的配置。继续？'))return;await releaseRun();config={...defaults(appKey),title:name,items:names.map(n=>({id:uid(),name:n,stock:1,weight:1,excluded:false,tags:[]}))};if(name==='年会'){config.mode='winners';config.machine='sphere';config.awards=[{id:uid(),name:'一等奖',count:1},{id:uid(),name:'二等奖',count:3}];}saved=null;draft[appKey]={...draft[appKey],touched:true};dirty=false;paint();persist();});$('#presets').append(b);});
 $('#classReport').hidden=appKey!=='person';$('#classSwitch').hidden=appKey!=='person';$('#tagFilterField').hidden=!['food','play'].includes(appKey);const tagSelect=$('#tagFilter');tagSelect.replaceChildren(...['',...new Set(config.items.flatMap(i=>i.tags||[]))].map(tag=>{const option=element('option',tag||'全部标签');option.value=tag;return option;}));tagSelect.value=config.tag_filter||'';
 if(['food','play'].includes(appKey))$('#candidateHelp').textContent+=' 可用 #标签 分类，例如：火锅 #聚餐。';$('#runProgress').textContent='';
 $('#result').hidden=true;stage?.reset();stage?.configure(visualConfig());
}
function visualConfig(){return {...config,backdrop:config.backdrop||'',items:config.items.map(i=>({...i,excluded:i.excluded||!!(config.tag_filter&&!i.tags?.includes(config.tag_filter))}))};}
function nextDrawLabel(){return config.mode==='groups'?(run?.id&&run.id===completedGroupRunId?'新一轮分组':'开始分组'):APPS[appKey].button;}
async function refreshProgress(state){
 if(displayId||!run)return;const id=run.id;state ||= await api(`/v6/runs/${id}`);if(run?.id!==id)return;
 if(config.mode==='groups'&&state.draws.length){completedGroupRunId=id;if(!busy)$('#drawButton strong').textContent=nextDrawLabel();}
 const used=state.draws.flatMap(d=>d.results),active=config.items.filter(i=>!i.excluded&&(!config.tag_filter||i.tags?.includes(config.tag_filter)));
 const usedIds=new Set(used.map(i=>i.id));let text=`已完成 ${state.draws.length} 次抽取`;
 if(config.mode==='inventory')text+=' · 剩余库存 '+active.map(i=>`${i.name} ${Math.max(0,i.stock-used.filter(r=>r.id===i.id).length)}`).join(' / ');
 else if(['no_repeat','winners','groups'].includes(config.mode))text+=` · 已抽 ${usedIds.size} 个 · 尚未抽到 ${active.filter(i=>!usedIds.has(i.id)).length} 个`;
 if(config.mode==='winners'&&config.awards.length){const forfeits=new Set(state.events.filter(e=>e.kind==='forfeit').map(e=>e.payload.draw_id+':'+e.payload.candidate_id));text+=' · '+config.awards.map(a=>{const count=state.draws.filter(d=>d.award_id===a.id).reduce((sum,d)=>sum+d.results.filter(i=>!forfeits.has(d.id+':'+i.id)).length,0);return `${a.name} ${count}/${a.count}`;}).join(' / ');}
 $('#runProgress').textContent=text;
}
async function releaseRun(){soundRuntime.stop();if(run?.control_token){await api(`/v6/runs/${run.id}/archive`,{control_token:run.control_token});}stage?.reset();run=null;pendingRequest=null;}
async function guard(action){if(busy||appearanceBusy){toast('正在揭晓，请稍候');return;}try{await action();}catch(e){toast(e.message);}}
function readConfig(mode=$('#drawMode').value){
 const used=new Set(),machine=mode==='groups'?'sphere':config.machine;
 const items=$('#candidates').value.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
  const excluded=line.startsWith('!');if(excluded)line=line.slice(1);const tags=[...line.matchAll(/\s+#([^\s#]{1,30})/g)].map(m=>m[1]);line=line.replace(/\s+#[^\s#]+/g,'');const parts=line.split(/[,，]/),name=parts[0].trim();const prior=config.items.find(i=>i.name===name&&!used.has(i.id));const id=prior?.id||uid();used.add(id);
  const number=parts.length>1?Number(parts[1]):1;if(!name||!Number.isInteger(number)||number<(mode==='inventory'?0:1))throw new Error('请检查候选名称与数量/权重，使用整数');
  return {id,name,excluded,stock:mode==='inventory'?number:prior?.stock??1,weight:mode==='weighted'?number:prior?.weight??1,tags};
 });
 const awards=mode==='winners'?$('#awards').value.split('\n').map(s=>s.trim()).filter(Boolean).map((s,i)=>{const [name,n]=s.split(/[,，]/);const count=Number(n||1);if(!name||!Number.isInteger(count)||count<1)throw new Error('奖项格式为：名称,正整数名额');return{id:config.awards[i]?.name===name?config.awards[i].id:uid(),name,count};}):[];
 const count=['food','play'].includes(appKey)?1:Number($('#drawCount').value);
 if(!items.length)throw new Error('请先添加至少一个候选');
 if(machine==='wheel'&&count>1)throw new Error('多人抽取请先选择姓名星球');
 return {...config,title:$('#configTitle').value.trim()||APPS[appKey].name,mode,machine,items,count,tag_filter:$('#tagFilter').value||'',group_count:Number($('#groupCount').value),awards,cross_award_unique:$('#crossUnique').checked,brand:mode==='winners'?$('#brandTitle').value.trim():''};
}
async function applySettings(){const next=readConfig();if(run&&!await confirmAction('应用修改将结束当前轮次，历史记录会保留。继续？'))return false;const rehearsal=$('#rehearsal').checked;await releaseRun();config=next;draft[appKey]={...draft[appKey],touched:true};dirty=false;preview=preview?{...preview}:null;paint();$('#rehearsal').checked=rehearsal;persist();toast('设置已应用');return true;}
async function ensureRun(){if(!run){const rehearsal=!!preview||$('#rehearsal').checked;if(config.mode==='winners'&&!rehearsal){const active=config.items.filter(i=>!i.excluded).length;if(!await confirmAction(`即将开始正式抽奖：${active} 名候选，每次 ${config.count} 人；${config.awards.map(a=>a.name+' '+a.count+'名').join('，')||'无分级奖项'}；${config.cross_award_unique?'跨奖项不重复':'不同奖项允许重复'}。请确认名单和规则。`))throw new Error('已取消正式开场，配置保留');}run=await api('/v6/runs',{config:{...config,source_config_id:saved?.id||'',source_config_revision:saved?.revision||0},rehearsal});persist();}return run;}
function playMachineSound(kind,energy){
 if(!kind.startsWith('motion-')&&!['capsule','wheel','sphere','capsule-impact'].includes(kind))recordInteractionDiagnostic(`sound ${kind}`);
 const played=soundRuntime.play(kind,energy,config.theme);
 if(played&&!kind.startsWith('motion-')&&!['capsule','wheel','sphere','capsule-impact'].includes(kind))recordInteractionDiagnostic(`audio-output ${kind}`);
}
async function draw(){
 if(displayId)return;
 if(waitingForStop)return;
 if(busy||appearanceBusy)return;if(result?.groups?.length||(config.mode==='groups'&&run?.id&&run.id===completedGroupRunId))return repeatResult();if(dirty){toast('候选或规则已修改，请先点“应用设置”');return;}if(!stage){toast('3D 机台尚未就绪');return;}
 // Unlock sound during the gesture, before fullscreen can consume activation.
 soundRuntime.setHidden(document.hidden);
 configureSound();
 if(!muted)soundRuntime.arm();
 requestGameFullscreen();
 let succeeded=false;busy=true;setPerformanceMode(true);$('.stage-panel').classList.remove('result-visible');$('.stage-panel').classList.add('requesting');$('.stage-panel').classList.remove('manual-stop');$('#gameStatus').hidden=false;skip=false;stopRequested=false;clearResultPagination();$('#drawButton').disabled=true;$('#result').hidden=true;$('#drawContext').textContent='机台准备中…';
 try{
  await ensureRun();pendingRequest ||= {request_id:uid(),award_id:$('#currentAward').value||''};persist();
  const body={...pendingRequest,control_token:run.control_token,controller_id:controllerId};
  const presentation=await api(`/v6/runs/${run.id}/start`,body);if(!muted&&!await soundRuntime.whenReady())toast('音效暂未加载，画面继续播放；可稍后点击声音重试');stage.configure(visualConfig());$('#drawContext').textContent='机台准备中…';if(!await stage.start())throw new Error("机台已切换，请重新开始");$('.stage-panel').classList.remove('requesting');$('#gameStatus').hidden=true;$('#drawContext').textContent='正在抽取…';
  const start=performance.now(),manual=config.mode==='winners'&&presentation.phase==='spinning';
  if(manual){waitingForStop=true;$('.stage-panel').classList.add('manual-stop');$('.stage-bottom').inert=false;$('#drawButton').disabled=false;$('#drawButton strong').textContent='停止并揭晓';$('#drawContext').textContent='主持人控制中 · 点击按钮停止并揭晓';while(!stopRequested)await new Promise(r=>setTimeout(r,70));waitingForStop=false;$('.stage-panel').classList.remove('manual-stop');$('.stage-bottom').inert=true;$('#drawButton').disabled=true;}
  const data=await api(`/v6/runs/${run.id}/draw`,body);
  const standardWait=SHARED_PROFILE.timing.automaticRunMs,duration=$('#reduceMotion').checked||manual?0:pace==='calm'?standardWait+1600:standardWait;
  while(!skip&&!$('#reduceMotion').checked&&performance.now()-start<duration)await new Promise(r=>setTimeout(r,50));
  $('#drawContext').textContent='正在揭晓…';pendingRequest=null;await showResult(data,!skip);soundRuntime.finish();succeeded=true;persist();refreshProgress().catch(()=>{});
 }catch(e){soundRuntime.stop();stage.reset();toast(e.message+(!e.status&&run&&pendingRequest?'；可再次点击，恢复同一次抽取':''));
  if(e.status&&pendingRequest){try{await api(`/v6/runs/${run.id}/cancel`,{...pendingRequest,control_token:run.control_token,controller_id:controllerId});}catch{}pendingRequest=null;}persist();
  }finally{busy=false;waitingForStop=false;$('.stage-panel').classList.remove('manual-stop','requesting');$('#gameStatus').hidden=true;setPerformanceMode(false);updateResultPaginationControls();$('#drawButton').disabled=false;$('#skipButton').hidden=true;$('#drawButton strong').textContent=nextDrawLabel();$('#drawContext').textContent=succeeded?(config.mode==='groups'?'本轮分组完成 · 新开一轮可重新分组':'结果已保存 · 可以继续抽取'):'本次未新增结果 · 请检查提示';}
}
async function endPreview(){
 if(!preview)return;
 const original=preview;if(run?.rehearsal)await releaseRun();
 config=original.config;run=original.run;saved=Object.hasOwn(original,'saved')?original.saved:saved;pendingRequest=original.pendingRequest||null;selectedAward=original.selectedAward||'';preview=null;dirty=false;
}
async function togglePreview(selection={theme:'cosmic'}){
 if(dirty)return toast('请先应用修改，再开始或结束主题预览');
 if(preview){await endPreview();paint();persist();if(run)await restoreState(await api(`/v6/runs/${run.id}`));return;}
 if(pendingRequest)return toast('请先完成当前抽取，再预览主题');
 preview={config:copy(config),run,saved,pendingRequest,selectedAward};
 const theme=selection.theme||config.theme,machine=selection.machine||config.machine;
 const problem=machineProblem(machine,theme);if(problem){preview=null;throw new Error(problem);}
 config={...copy(config),theme,machine,sound:soundFor(theme,storage.get('clm-theme-sounds',{})[theme])};run=null;saved=null;pendingRequest=null;paint();persist();
 if(stage)api('/v7/events',{event:'skin_preview'}).catch(()=>{});
}
async function switchApp(key){if(dirty&&!await confirmAction('切换前放弃尚未应用的修改？'))return;soundRuntime.stop();if(preview)await endPreview();persist();appKey=key;config=copy(draft[key]?.config||defaults(key));run=draft[key]?.run||null;saved=draft[key]?.saved||null;preview=null;dirty=false;pendingRequest=draft[key]?.pendingRequest||null;selectedAward=draft[key]?.selectedAward||'';paint();persist();if(run)await restoreState(await api(`/v6/runs/${run.id}`));}
function machineProblem(key,theme=config.theme){return appearanceProblem(CONTENT,{...config,machine:key,theme,sound:''},account.content||CONTENT);}
async function applyAppearance(change){
 if(busy||appearanceBusy||pendingRequest)throw new Error('请先完成当前抽取，再调整外观');
 if(dirty)throw new Error('请先应用设置再调整外观');
 const theme=change.theme||config.theme;
 const next={machine:change.machine||config.machine,theme,sound:soundFor(theme,change.sound||(theme===config.theme?config.sound:storage.get('clm-theme-sounds',{})[theme]))};
 const reason=machineProblem(next.machine,next.theme);if(reason)throw new Error(reason);
 const denied=accessProblem(CONTENT,next,account.features);if(denied&&!preview&&!run?.rehearsal)throw new Error(denied);
 if(next.machine===config.machine&&next.theme===config.theme&&next.sound===config.sound)return;
 appearanceBusy=true;
 try{
  if(run)await api(`/v6/runs/${run.id}/appearance`,{...next,control_token:run.control_token});
  soundRuntime.stop();Object.assign(config,next);
  storage.set('clm-theme-sounds',{...storage.get('clm-theme-sounds',{}),[theme]:next.sound});
  paint();persist();
 }finally{appearanceBusy=false;}
}
async function switchMachine(key){await applyAppearance({machine:key});toast('机台已切换，当前轮次与规则保持');}
function soundChoices(body){
 const section=element('section',undefined,'sound-picker');section.setAttribute('aria-label','主题音效');
 section.append(element('h3',(CONTENT.themes[config.theme]?.name||config.theme)+' · 选择音效'));
 section.append(element('p','三种声音均随当前主题提供，节奏跟随机台转动。','modal-copy'));
 for(const [id,preset] of themeSounds(config.theme)){
  const row=element('div',undefined,'sound-choice'),info=element('div');info.append(element('b',preset.character),element('p',preset.description));
  const select=element('button',id===config.sound?'已选择':'选用');select.setAttribute('aria-label','选用'+preset.character);select.setAttribute('aria-pressed',String(id===config.sound));
  select.onclick=()=>guard(async()=>{await applyAppearance({sound:id});themes('sounds');});
  const listen=element('button','试听');listen.setAttribute('aria-label','试听'+preset.character);
  listen.onclick=()=>guard(async()=>{
   if(muted||soundVolume===0){toast('请先开启声音并调高音量');return;}
   soundRuntime.configure(audioConfig({...config,sound:id}));listen.disabled=true;
   const current=modalVersion;
   try{const played=await soundRuntime.audition();if(current===modalVersion)toast(played?'正在试听 · '+preset.character:'音效未能加载，请重试');}
   finally{listen.disabled=false;}
  });
  row.append(info,select,listen);section.append(row);
 }
 body.append(section);audioPreferences(body);
}
function audioPreferences(body){
 const row=element('div',undefined,'sound-volume'),label=element('label','音量','field'),slider=element('input'),value=element('output',Math.round(soundVolume*100)+'%');
 slider.type='range';slider.min='0';slider.max='100';slider.step='1';slider.value=String(Math.round(soundVolume*100));slider.setAttribute('aria-label','音效音量');
 slider.oninput=()=>{soundVolume=Number(slider.value)/100;soundRuntime.volume(soundVolume);storage.set('clm-sound-volume',soundVolume);value.textContent=slider.value+'%';};
 label.append(slider);const toggle=element('button',muted?'开启声音':'关闭声音');
 toggle.onclick=async()=>{await $('#muteButton').onclick();toggle.textContent=muted?'开启声音':'关闭声音';};row.append(label,value,toggle);body.append(row);
}
function themes(selectedTab='themes'){
 if(!['themes','sounds','machines'].includes(selectedTab))selectedTab='themes';
 const body=openModal('机台与主题'),version=modalVersion;
 body.append(element('p','三款机台免费玩。换一种外观，换一份期待。','modal-copy'));
 body.append(element('p','当前机台：'+CONTENT.machines[config.machine].name+' · 对比两套外观','appearance-current'));
 const tabs=element('div',undefined,'appearance-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','外观分类');
 const panels={};
 for(const [key,label] of [['themes','主题'],['sounds','音效'],['machines','机台']]){
  const button=element('button',label);button.id='appearance-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(key===selectedTab));button.setAttribute('aria-controls','appearance-panel-'+key);button.tabIndex=key===selectedTab?0:-1;
  button.onclick=()=>{soundRuntime.stop();for(const node of tabs.children){const active=node===button;node.setAttribute('aria-selected',String(active));node.tabIndex=active?0:-1;}for(const [id,panel] of Object.entries(panels))panel.hidden=id!==key;};
  button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const nodes=[...tabs.children],at=nodes.indexOf(button),next=event.key==='Home'?0:event.key==='End'?nodes.length-1:(at+(event.key==='ArrowRight'?1:-1)+nodes.length)%nodes.length;nodes[next].focus();nodes[next].click();};
  tabs.append(button);const panel=element('section',undefined,'appearance-panel');panel.id='appearance-panel-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.hidden=key!==selectedTab;panels[key]=panel;
 }
 body.append(tabs,...Object.values(panels));
 const themePanel=panels.themes;
 const cards=element('div',undefined,'theme-cards');themePanel.append(cards);
 const classic=itemRow(cards,'默认主题 · 免费','清透材质 · 三种游戏音效',config.theme==='classic'?'正在使用':'使用默认主题',async()=>{if(preview)await endPreview();await applyAppearance({theme:'classic'});themes();});
 classic.classList.add('theme-visual-card');
 const cosmic=itemRow(cards,'星空主题','三款机台的星空外观 · 三种专属音效',preview?'结束免费预览':account.features.includes('cosmic')?(config.theme==='cosmic'?'正在使用':'使用星空主题'):'免费体验完整演出',async()=>{if(account.features.includes('cosmic')&&!preview){await applyAppearance({theme:'cosmic'});}else await togglePreview();$('#modal').close();});
 cosmic.classList.add('theme-visual-card','theme-preview-offer');
 for(const [card,id] of [[classic,'classic'],[cosmic,'cosmic']]){const image=element('img');image.src='/v7/previews/'+id+'-'+config.machine+'.png';image.alt=(id==='classic'?'默认主题':'星空主题')+' · '+CONTENT.machines[config.machine].name+'实景';image.width=600;image.height=400;card.prepend(image);if(config.theme===id){const badge=element('span',preview&&id==='cosmic'?'预览中':'当前主题','theme-current');card.append(badge);}}
 const info=element('details',undefined,'preview-help');info.append(element('summary','免费预览与购买说明'),element('p','预览包含完整演出，不消耗原来的候选、库存和奖项轮次。结束预览会恢复原配置；原结果仍可在记录中查看。主题与功能会员分别开通，不自动续费，也不改变抽取结果。'));themePanel.append(info);
 for(const [id,t]of Object.entries(CONTENT.themes)){if(['classic','cosmic'].includes(id))continue;itemRow(themePanel,t.name,t.description,'免费预览',async()=>{if(preview)await endPreview();await togglePreview({theme:id});$('#modal').close();});}
 soundChoices(panels.sounds);
 for(const [key,m]of Object.entries(CONTENT.machines)){const reason=machineProblem(key),owned=!m.feature||account.features.includes(m.feature);itemRow(panels.machines,m.name,reason||(m.feature?'独立机台权益':'完整 3D · 免费使用'),reason?null:config.machine===key?'正在使用':owned?'使用':'免费预览',async()=>{if(owned)await switchMachine(key);else{if(preview)await endPreview();await togglePreview({machine:key,theme:'classic'});}$('#modal').close();});}
 const price=element('div',undefined,'theme-purchase');price.append(element('p','正在读取价格…','modal-copy'));cosmic.append(price);
 const professional=element('section',undefined,'pro-offer');professional.append(element('h3','让课堂与年会更从容'),element('p','课堂：导入名单、切换班级、查看课次统计。年会：设置多奖项、展示品牌舞台、导出结果。','modal-copy'));themePanel.append(professional);
 api('/v6/shop').then(data=>{if(version!==modalVersion||!body.isConnected)return;const products=Array.isArray(data.products)?data.products:[],skin=products.find(p=>p.slug==='cosmic');price.replaceChildren();if(skin)shopRows(price,[skin],{compact:true,ordersLink:false});else price.append(element('p','商品信息暂不可用，仍可免费预览。','modal-copy'));shopRows(themePanel,products.filter(p=>p.kind==='skin'&&p.slug!=='cosmic'),{ordersLink:false});shopRows(professional,products.filter(p=>p.kind==='feature'),{ordersLink:false});shopRows(panels.machines,products.filter(p=>p.kind==='machine'),{ordersLink:false});}).catch(()=>{if(body.isConnected)price.replaceChildren(element('p','价格暂时未能加载，稍后重试；免费预览仍可使用。','modal-copy'));});
}
function shopRows(body,products,{compact=false,ordersLink=true}={}){
 for(const product of products){const price=product.price_cents===null?'定价待确认':`¥${(product.price_cents/100).toFixed(2)} / ${product.days} 天`;
  const row=itemRow(body,compact?'':product.name,`${compact?'':product.description+' · '}${price}${product.kind==='skin'?' · 适用：'+product.machines.map(id=>{const m=CONTENT.machines[id];return (m?.name||id)+(m?.feature?'（需另有机台权益）':'');}).join('、'):''}`,product.owned?'已拥有':product.sale_enabled?'购买':'暂未开放购买',async()=>{
   if(product.owned){const change=product.kind==='skin'?{theme:product.target}:product.kind==='machine'?{machine:product.target,theme:'classic'}:null;if(change){if(preview)await endPreview();await applyAppearance(change);$('#modal').close();}return;}
   if(!product.sale_enabled)return toast('商品暂未开放销售，可免费预览');
   if(account.kind==='guest'){persist();location.href='/login.html?next='+encodeURIComponent('/play.html');return;}
   const key='clm-checkout-'+product.slug;const request=storage.get(key,null)||uid();storage.set(key,request);
   const channel=matchMedia('(max-width: 700px)').matches?'mobile':'pc';
   let order;try{order=await api('/v6/checkout',{slug:product.slug,request_id:request,channel,price_version:product.price_version});}
   catch(error){if(error.status!==409)throw error;
    const latest=await api('/v6/shop'),fresh=latest.products?.find(item=>item.slug===product.slug);
    if(!fresh?.sale_enabled){toast('商品销售状态已变化，请重新打开商品页');return;}
    const before=`¥${(product.price_cents/100).toFixed(2)}`,after=`¥${(fresh.price_cents/100).toFixed(2)}`;
    if(!await confirmAction(`${product.name}价格由 ${before} 调整为 ${after}，期限仍为 ${fresh.days} 天。按新价格继续下单？`))return;
    order=await api('/v6/checkout',{slug:product.slug,request_id:request,channel,price_version:fresh.price_version});
   }
   storage.set('clm-last-order',order.order_no);await renderOrder(order);
  });row.classList.add('theme-product',`theme-product-${product.slug}`);
  if(compact){row.classList.add('compact-product');row.querySelector('p').textContent=price+' · 不自动续费';}if(!product.owned&&!product.sale_enabled)row.querySelector('button').disabled=true;
 }
 if(ordersLink){const ordersButton=element('button','查看我的订单');ordersButton.onclick=()=>guard(orders);body.append(ordersButton);}
}
async function orders(){const body=openModal('我的订单');const data=await api('/v6/orders');if(!data.orders.length)body.append(element('p','暂无订单。','modal-copy'));for(const o of data.orders)itemRow(body,o.name,`¥${(o.amount/100).toFixed(2)} · ${orderState(o.state)}`,'查看',()=>renderOrder(o));}
async function inviteFriends(){
 if(account.kind==='guest'){persist();location.href='/login.html?next='+encodeURIComponent('/play.html#invite');return;}
 const body=openModal('邀请好友'),version=modalVersion;body.append(element('p','正在读取邀请活动与奖励进度…','modal-copy'));
 try{
  const [publicData,mine]=await Promise.all([api('/v7/public'),api('/v7/referrals/me')]);
  if(version!==modalVersion||!$('#modal').open)return;body.replaceChildren();const campaign=Object.hasOwn(mine,'campaign')?mine.campaign:publicData.campaign;
  if(!campaign)body.append(element('p','当前没有开放中的邀请活动。','modal-copy'));
  else{
   const pro=Number(campaign.pro_days)||0,skinDays=Number(campaign.skin_days)||0,skinName=campaign.skin_feature==='cosmic'?'星空主题皮肤':campaign.skin_feature||'指定皮肤';
   body.append(element('h3',campaign.name||'好友注册，邀请奖励按活动规则发放','modal-copy'));
   const rewards=[];if(pro)rewards.push(`邀请人获得专业功能会员 ${pro} 天`);if(skinDays&&campaign.skin_feature)rewards.push(`邀请人获得${skinName} ${skinDays} 天`);if(campaign.reward_newcomer)rewards.push('新用户也将获得活动所列奖励');
   body.append(element('p',rewards.join('；')||'活动当前未设置奖励。','modal-copy'));
   const terms=[`每月奖励上限：${campaign.monthly_cap} 次`,`归因有效期：${campaign.attribution_days} 天`,campaign.require_experience?'好友注册后还需完成一次有效体验。':'完成有效新账号注册后计入，不要求好友购买。'];
   if(campaign.starts_at)terms.push(`活动开始：${new Date(campaign.starts_at*1000).toLocaleDateString('zh-CN')}`);if(campaign.ends_at)terms.push(`活动截止：${new Date(campaign.ends_at*1000).toLocaleDateString('zh-CN')}`);
   const list=element('ul',undefined,'invite-terms');for(const term of terms)list.append(element('li',term));body.append(list);
  }
  const linkPath=mine.link_path||'';const inviteLink=/^\/(?![\/\\])/.test(linkPath)?new URL(linkPath,location.origin).href:'';
  if(inviteLink){const label=element('label','你的专属邀请链接','field'),row=element('div',undefined,'invite-link-row'),input=element('input');input.type='url';input.readOnly=true;input.value=inviteLink;input.setAttribute('aria-label','你的专属邀请链接');const copyButton=element('button','复制链接');copyButton.onclick=()=>guard(async()=>{await navigator.clipboard.writeText(inviteLink);toast('邀请链接已复制');});row.append(input,copyButton);label.append(row);body.append(label);mountInvitePoster(body,version);}
  const cap=campaign?.monthly_cap;body.append(element('p',`本月已奖励 ${Number(mine.completed_this_month)||0} 次${cap?` / ${cap} 次`:''}`,'modal-copy'));
  if(mine.records?.length){body.append(element('h3','邀请记录','invite-heading'));for(const record of mine.records){const status=({pending:'待处理',held:'待核验',rewarded:'已发放',revoked:'已撤销',capped:'达到月上限'})[record.status]||record.status;const details=[];if(record.pro_days)details.push(`会员 ${record.pro_days} 天`);if(record.skin_feature&&record.skin_days)details.push(`${record.skin_feature==='cosmic'?'星空主题皮肤':'指定皮肤'} ${record.skin_days} 天`);const time=record.rewarded_at||record.created_at,when=time?new Date(time*1000).toLocaleString('zh-CN'):'';itemRow(body,record.invitee_label||'新用户',`${status}${when?' · '+when:''}${details.length?' · '+details.join(' + '):''}`,null,null);}}
 }catch(error){if(version===modalVersion&&$('#modal').open)body.replaceChildren(element('p',error.message||'邀请信息暂时不可用，请稍后重试。','modal-copy'));}
}
function mountInvitePoster(body,version){
 const host=element('section',undefined,'invite-poster'),generate=element('button','生成邀请海报'),status=element('p','海报会读取当前邀请规则，不包含你的手机号或好友资料。','modal-copy'),preview=element('div');
 generate.type='button';status.setAttribute('role','status');host.append(generate,status,preview);body.append(host);
 let controller=null,objectURL=null;
 const current=()=>version===modalVersion&&$('#modal').open&&host.isConnected;
 modalCleanup=()=>{controller?.abort();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;};
 generate.onclick=()=>guard(async()=>{
  if(generate.disabled||!current())return;
  generate.disabled=true;status.textContent='正在读取规则并生成海报…';controller?.abort();controller=new AbortController();
  try{
   const [fresh,shop]=await Promise.all([api('/v7/referrals/me'),api('/v6/shop').catch(()=>({products:[]}))]);
   if(!current())return;
   const model=invitationPosterModel({link:fresh.link_path,origin:location.origin,campaign:fresh.campaign,products:shop.products});
   const blob=await invitationPosterBlob(model,{signal:controller.signal});if(!current())return;
   if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(blob);
   const image=element('img');image.alt='邀请海报预览';image.src=objectURL;
   const download=element('a','保存邀请海报 · PNG','invite-poster-save');download.href=objectURL;download.download='choulema-invitation.png';
   download.onclick=()=>toast('已提交图片下载，也可以长按海报保存。');
   preview.replaceChildren(image,download);status.textContent=model.localNote;generate.textContent='按最新规则重新生成';
  }catch(error){if(current()){status.textContent=error.message||'生成失败，请稍后重试或复制邀请链接。';throw error;}}
  finally{if(current())generate.disabled=false;}
 });
}
async function redeemCard(){const body=openModal('兑换卡密');body.append(element('p','输入管理员发放的会员或皮肤卡密。兑换后会立即加到当前账号，并从已有到期日顺延。','modal-copy'));
 const input=element('input');input.placeholder='CLM-…';input.autocomplete='off';input.spellcheck=false;input.style.cssText='width:100%;padding:12px;margin:8px 0 16px';
 const action=element('button','确认兑换','solid'),message=element('p','', 'modal-copy');body.append(input,action,message);
 action.onclick=()=>guard(async()=>{action.disabled=true;try{const result=await api('/v6/cards/redeem',{code:input.value.trim()});
  account=await api('/v6/status');message.textContent=(result.already_redeemed?'这张卡已由当前账号兑换。':'兑换成功，权益已生效。')+(result.expires_at?` 到期：${new Date(result.expires_at*1000).toLocaleDateString('zh-CN')}`:'');
  $('#accountButton').textContent=`${account.name} · ${account.features.includes('pro')?'专业功能已开通':'免费账号'}`;
 }finally{action.disabled=false;}});
}
function orderState(state){return {requesting:'订单处理中',unknown:'等待渠道确认',pending:'等待支付',paid:'支付成功',refunded:'已全额退款',closed:'已关闭',failed:'支付失败',cancelled:'已撤销',legacy_unavailable:'历史订单 · 原渠道已停用'}[state]||state;}
async function renderOrder(order){
 stopOrderWatch();const version=modalVersion;
 if(!$('#modal').open){openModalHistory('panel');$('#modal').showModal();}$('#modalTitle').textContent=order.name;const body=$('#modalBody');body.replaceChildren();body.append(element('h2',`¥${(order.amount/100).toFixed(2)}`),element('p',orderState(order.state),'modal-copy'),element('p',`订单：${order.order_no}`,'modal-copy'));
 if(order.state==='paid'){
  if(order.refund_state==='partial_review')body.append(element('p',`检测到退款 ¥${(order.refund_cents/100).toFixed(2)}，权益暂时保留，请联系管理员核对。`,'modal-copy'));
  account=await api('/v6/status');if(version!==modalVersion||!$('#modal').open)return;storage.set('clm-checkout-'+order.slug,null);storage.set('clm-last-order',null);
  const use=element('button','返回并立即使用');use.onclick=()=>guard(async()=>{if(order.slug==='cosmic'){if(preview)await endPreview();await applyAppearance({theme:'cosmic'});}$('#modal').close();toast('权益已生效，当前配置已保留');});body.append(use);return;
 }
 if(['refunded','closed','failed','cancelled','legacy_unavailable'].includes(order.state)){storage.set('clm-checkout-'+order.slug,null);if(storage.get('clm-last-order',null)===order.order_no)storage.set('clm-last-order',null);body.append(element('p',order.state==='refunded'?'该订单已全额退款，对应权益已撤销。其他有效卡密或订单权益不受影响。':'此订单不能继续支付。需要购买时请返回主题库重新下单。','modal-copy'));return;}
 const pd=order.pay_data||{}, type=(pd.payDataType||'').toLowerCase(),value=pd.qrCode||pd.payData;
 if(type==='payurl'&&/^https:\/\/(?:openapi\.alipay\.com|openapi-sandbox\.dl\.alipaydev\.com)\/gateway\.do\?/i.test(value)){const link=element('a',order.channel==='mobile'?'前往支付宝付款 ↗':'打开支付宝收银台 ↗');link.href=value;link.target=order.channel==='mobile'?'_self':'_blank';link.rel='noopener noreferrer';link.className='solid';link.style.cssText='display:block;text-align:center;padding:12px;margin:12px 0';body.append(link);
  if(order.channel==='pc'){const img=document.createElement('img');img.alt='用手机扫码打开支付宝收银台';img.src='/api/qr?data='+encodeURIComponent(value);img.style.cssText='display:block;width:220px;background:white;margin:18px auto';body.append(img);}
 }else if(value&&type==='codeurl'||pd.qrCode){const img=document.createElement('img');img.alt='支付二维码';img.src='/api/qr?data='+encodeURIComponent(value);img.style.cssText='display:block;width:220px;background:white;margin:18px auto';body.append(img);
 }else body.append(element('p','暂未获取可展示的支付信息，请查询状态。不要重复付款。','modal-copy'));
 const refresh=element('button','我已支付，查询状态');refresh.onclick=()=>guard(async()=>{refresh.disabled=true;try{const next=await api(`/v6/orders/${order.order_no}/refresh`,{});if(version===modalVersion&&$('#modal').open)await renderOrder(next);}finally{refresh.disabled=false;}});body.append(refresh,element('p','关闭窗口不会丢失订单，可在我的订单中恢复。','modal-copy'));
 const number=order.order_no;
 const watch=async()=>{
  if(version!==modalVersion||!$('#modal').open)return;
  try{const next=await api(`/v6/orders/${number}/refresh`,{});
   if(version!==modalVersion||!$('#modal').open)return;
   if(next.state!==order.state||JSON.stringify(next.pay_data)!==JSON.stringify(order.pay_data)){await renderOrder(next);return;}
  }catch{ /* Keep the same order; transient network failure must not create another payment. */ }
  if(version===modalVersion&&$('#modal').open)orderTimer=setTimeout(watch,6000);
 };orderTimer=setTimeout(watch,6000);
}

async function library(){
 if(preview)return toast('请先结束主题预览，再载入配置');
 const body=openModal('我的配置'),version=modalVersion,d=await api('/v6/configs');if(version!==modalVersion||!body.isConnected)return;
 const recovered=storage.get('clm-draft-recovery',[]).filter(r=>r?.config).map(r=>({config:r.config,localRecovery:true}));
 const sections=[['我保存的配置',[...d.configs,...d.legacy.filter(r=>!r.recommended)]],['推荐模板',d.legacy.filter(r=>r.recommended)],['设备保留的草稿',recovered]];
 if(!sections[0][1].length)body.append(element('p',account.kind==='guest'?'免费注册即可保存自己的名单。也可以直接使用下面的模板。':'还没有保存的配置。在候选面板编辑名单后，点击保存配置即可。','modal-copy'));
 if(!d.legacy.some(r=>r.recommended))sections[1][1]=Object.keys(APPS).map(key=>({config:defaults(key),recommended:true}));
 for(const [heading,entries] of sections){if(!entries.length)continue;const section=element('section',undefined,'config-section');section.append(element('h3',heading));body.append(section);
  for(const row of entries){const meta=`${({food:'抽吃什么',play:'抽玩什么',prize:'抽奖品',person:'抽点名'})[row.config.app]||'保存的配置'} · ${row.config.items.length} 项候选`;
   const card=itemRow(section,row.config.title,meta,row.recommended?'使用模板':'载入',async()=>{if(dirty&&!await confirmAction('载入配置会放弃尚未应用的修改，继续？'))return;persist();appKey=row.config.app;config={...defaults(appKey),...copy(row.config)};saved=row.id?{id:row.id,revision:row.revision}:null;run=null;pendingRequest=null;selectedAward='';dirty=false;paint();persist();$('#modal').close();});
   if(row.id){const actions=element('div',undefined,'config-actions');for(const [label,duplicate] of [['重命名',false],['复制',true]]){const button=element('button',label);button.onclick=()=>guard(()=>editConfigName(row,duplicate));actions.append(button);}card.append(actions);}
  }
 }
}
function editConfigName(row,duplicate){
 const body=openModal(duplicate?'复制配置':'重命名配置'),form=element('form'),label=element('label','配置名称','field'),input=element('input');input.value=row.config.title+(duplicate?' · 副本':'');input.maxLength=80;input.required=true;label.append(input);const submit=element('button',duplicate?'保存副本':'保存名称','solid');submit.type='submit';form.append(label,submit);body.append(form);
 form.onsubmit=event=>{event.preventDefault();guard(async()=>{const title=input.value.trim();if(!title)return toast('请输入配置名称');submit.disabled=true;try{const value=await api('/v6/configs',{config:{...row.config,title},...(duplicate?{}:{id:row.id,revision:row.revision})});if(!duplicate&&saved?.id===row.id){saved=value;if(!dirty){config.title=title;$('#configTitle').value=title;}persist();}toast(duplicate?'副本已保存':'名称已更新');if(body.isConnected)await library();}finally{submit.disabled=false;}});};
}
async function history(){const body=openModal('抽取记录');if(!run){const all=await api('/v6/runs');for(const r of all.runs)itemRow(body,r.title,`${r.rehearsal?'演练':'正式'} · ${new Date(r.created_at*1000).toLocaleString()}`,'查看',()=>showHistory(r.id));if(!all.runs.length)body.append(element('p','还没有记录，抽一次就会出现在这里。','modal-copy'));}else await showHistory(run.id);}
async function showHistory(id){
 const version=modalVersion,body=$('#modalBody'),state=await api(`/v6/runs/${id}`);if(version!==modalVersion||!body.isConnected||!$('#modal').open)return;body.replaceChildren();body.append(element('p',`${state.config.title} · ${state.rehearsal?'演练，不作为正式结果':'正式记录'} · ${state.draws.length} 次`,'modal-copy'));
 const forfeited=new Set(state.events.filter(e=>e.kind==='forfeit').map(e=>e.payload.draw_id+':'+e.payload.candidate_id));
 for(const d of state.draws){itemRow(body,d.award||'抽取结果',d.results.map(i=>`${i.name} (${i.id})${forfeited.has(d.id+':'+i.id)?' · 已弃奖':''}`).join('、'),null);
  if(state.config.mode==='winners'&&run?.id===id&&run.control_token&&!state.archived)for(const c of d.results){if(forfeited.has(d.id+':'+c.id))continue;const b=element('button',`${c.name} 弃奖 / 补抽`);b.onclick=()=>guard(async()=>{const reason=await askReason('请填写弃奖原因，原获奖记录会保留：');if(!reason)return;await api(`/v6/runs/${id}/forfeit`,{control_token:run.control_token,draw_id:d.id,candidate_id:c.id,reason});toast('已记录弃奖，可以继续抽取该奖项');const updated=await api(`/v6/runs/${id}`);await refreshProgress(updated);if(updated.draws.length)showResult(markedResult(updated,updated.draws.at(-1)));await showHistory(id);});body.append(b);}
 }
 for(const event of state.events)body.append(element('p',`${event.kind==='forfeit'?'弃奖':'操作'}记录：${event.payload.reason}`,'modal-copy'));
 if(!state.archived){const resume=element('button','接管并恢复此场次');resume.onclick=()=>guard(()=>recoverRun(id));body.append(resume);}
 const all=element('button','全部场次');all.onclick=()=>guard(async()=>{const data=await api('/v6/runs');body.replaceChildren();for(const r of data.runs)itemRow(body,r.title,`${r.rehearsal?'演练':'正式'} · ${r.archived?'已结束':'进行中'}`,'查看',()=>showHistory(r.id));});body.append(all);
 const exportRow=element('div',undefined,'panel-actions export-history-row'),filter=document.createElement('select');filter.setAttribute('aria-label','导出奖项');
 const allAwards=element('option','全部奖项 / 完整场次');allAwards.value='';filter.append(allAwards);
 for(const award of state.config.awards||[]){const option=element('option',award.name);option.value=award.id;filter.append(option);}
 filter.hidden=!(state.config.awards||[]).length;
 const ex=element('button','导出 CSV · 专业');ex.onclick=async()=>{
  if(!capabilityAllowed(CONTENT,account,'result_export'))return toast('导出为专业权益；结果可免费复制');
  ex.disabled=true;ex.textContent='正在导出…';const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch(`/api/v6/runs/${id}/export${filter.value?'?award_id='+encodeURIComponent(filter.value):''}`,{credentials:'same-origin',signal:controller.signal,headers:{'X-Draft-Scope':initialAccount.draft_scope}});
   if(!response.ok){let message='导出失败，请稍后重试';try{const data=await response.json();message=data.error||message;}catch{}throw new Error(message);}
   if(!response.headers.get('content-type')?.includes('text/csv'))throw new Error('导出内容异常，请稍后重试');
   const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=`choulema-${id.slice(0,8)}-${state.rehearsal?'rehearsal':'formal'}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);toast('已提交下载，请查看浏览器下载记录');
  }catch(e){toast(e.name==='AbortError'?'导出超时，主持状态保留，请重试':e instanceof TypeError?'网络中断，导出未完成，请重试':e.message||'导出未完成，请重试');}
  finally{clearTimeout(timeout);ex.disabled=false;ex.textContent='导出 CSV · 专业';}
 };exportRow.append(filter,ex);body.append(exportRow);
 body.append(element('p','导出保留原结果、弃奖原因及时间，补抽结果单独列出；演练有明确标记。','modal-copy'));
}

let brandVersion=0,shownLogo=null,shownBackdrop=null;
const brandUploadVersions={logo:0,backdrop:0};
function decodedImage(value){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{if(img.naturalWidth*img.naturalHeight>16000000)reject(new Error('图片尺寸过大，请控制在1600万像素内'));else resolve(img);};img.onerror=()=>reject(new Error('图片无法加载，请换一张图片'));img.src=value;});}
function renderBrand(data){
 stage?.background(data);
 const logo=data.logo||'',backdrop=data.backdrop||'';
 if(logo===shownLogo&&backdrop===shownBackdrop)return;
 shownLogo=logo;shownBackdrop=backdrop;const version=++brandVersion,panel=$('.stage-panel'),logoEl=$('#brandLogo');
 logoEl.hidden=true;logoEl.removeAttribute('src');panel.classList.remove('has-backdrop');panel.style.backgroundImage='';
 if(logo)decodedImage(logo).then(()=>{if(version!==brandVersion)return;logoEl.src=logo;logoEl.hidden=false;}).catch(()=>{if(version===brandVersion&&!displayId)toast('Logo 未能加载，已使用默认舞台');});
 if(backdrop)decodedImage(backdrop).then(()=>{if(version!==brandVersion)return;panel.style.backgroundImage=`url("${backdrop}")`;panel.classList.add('has-backdrop');}).catch(()=>{if(version===brandVersion&&!displayId)toast('背景未能加载，已使用默认舞台');});
}

$('#importButton').onclick=()=>guard(async()=>{if(!capabilityAllowed(CONTENT,account,'roster_import'))return toast('文件导入为专业功能；也可以免费粘贴名单');$('#importFile').click();});
$('#importFile').onchange=()=>guard(async()=>{const file=$('#importFile').files[0];if(!file)return;const form=new FormData();form.append('file',file);const response=await fetch('/api/v6/import',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw new Error(data.error||'文件导入失败');
 const body=openModal('确认导入字段'),select=document.createElement('select');select.setAttribute('aria-label','姓名或名称列');const rows=data.rows;const width=Math.max(...rows.slice(0,10).map(r=>r.length));for(let i=0;i<width;i++){const opt=element('option',`第 ${i+1} 列：${rows[0]?.[i]||''}`);opt.value=i;select.append(opt);}const skip=document.createElement('input');skip.type='checkbox';skip.checked=true;const label=element('label','第一行为标题，不导入','checkbox');label.prepend(skip);body.append(element('p','选择姓名或奖品名称所在列，编号将在导入时分配。重复名字会保留为不同候选。','modal-copy'),select,label);const button=element('button','填入清单，等待应用');button.onclick=()=>{const names=rows.slice(skip.checked?1:0).map(r=>(r[+select.value]||'').trim()).filter(Boolean);$('#candidates').value=names.join('\n');dirty=true;$('#modal').close();toast(`已填入 ${names.length} 项，请检查后应用设置`);};body.append(button);
});
for(const [id,key,limit]of [['#logoFile','logo',500000],['#backdropFile','backdrop',1000000]])$(id).onchange=()=>guard(async()=>{const file=$(id).files[0];if(!file)return;const target=config,version=++brandUploadVersions[key];if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>limit)throw new Error('请选择 PNG/JPEG/WebP 图片，Logo 不超过 500 KB，背景不超过 1 MB');try{const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择'));reader.readAsDataURL(file);});if(config!==target||brandUploadVersions[key]!==version)return;await decodedImage(value);if(config!==target||brandUploadVersions[key]!==version)return;config[key]=value;dirty=true;toast('图片已选，请应用设置；可在演练中预览');}catch(e){if(config!==target||brandUploadVersions[key]!==version)return;throw e;}});
$('#clearBrand').onclick=()=>guard(()=>{brandUploadVersions.logo++;brandUploadVersions.backdrop++;config.logo='';config.backdrop='';dirty=true;renderBrand(config);});
$('#classSwitch').onclick=()=>guard(async()=>{
 if(dirty)return toast('请先应用或保存当前修改，再切换班级');
 const data=await api('/v6/classes'),body=openModal('我的班级');
 body.append(element('p','继续课次会保留已点名单和分组结果。载入最新配置会准备新的课次。','modal-copy'));
 if(!data.classes.length)body.append(element('p','先在点个名中编辑名单并保存配置，即可加入班级列表。','modal-copy'));
 for(const row of data.classes){
  const desc=`${row.sessions} 个正式课次${row.pending_changes?' · 保存的名单已有更新，当前课次保留原名单':''}`;
  if(row.active_run_id)itemRow(body,row.title,desc,'继续课次',()=>recoverRun(row.active_run_id));
  itemRow(body,row.active_run_id?row.title+' · 使用最新名单':row.title,row.active_run_id?'下一次抽取将新开课次':desc,'载入配置',async()=>{
   const library=await api('/v6/configs'),entry=library.configs.find(c=>c.id===row.id);if(!entry)throw new Error('班级配置不存在，请刷新列表');
   if(preview)return toast('请先结束主题预览再切换班级');
   persist();appKey='person';config={...defaults('person'),...entry.config};saved={id:entry.id,revision:entry.revision};run=null;pendingRequest=null;selectedAward='';dirty=false;paint();persist();$('#modal').close();toast('班级已载入，下一次抽取新开课次');
  });
 }
});
$('#classReport').onclick=()=>guard(async()=>{if(!saved?.id)return toast('先保存班级配置，再开始课次即可记录统计');const data=await api(`/v6/configs/${saved.id}/report`);const body=openModal(data.title+' · 课次统计');body.append(element('p',`${data.sessions} 个正式课次，演练不计入`,'modal-copy'));for(const s of data.students)itemRow(body,s.name,`编号 ${s.id} · 被点到 ${s.count} 次`,null);if(!data.students.length)body.append(element('p','还没有正式点名记录。','modal-copy'));});
$('#drawButton').onclick=()=>{if(waitingForStop){stopRequested=true;return;}guard(draw);};
$('#skipButton').onclick=()=>{};
$('#resultPrevious').onclick=()=>changeResultPage((resultPageMeta?.page||0)-1);
$('#resultNext').onclick=()=>changeResultPage((resultPageMeta?.page||0)+1);
async function repeatResult(){
 if(busy)return;
 if(!result?.groups?.length&&!(config.mode==='groups'&&run?.id&&run.id===completedGroupRunId))return draw();
 busy=true;let confirmed=false;
 try{
  if(!await confirmAction('本轮分组已经完成。保留本轮记录，并按当前名单开始新一轮分组？'))return;
  const rehearsal=!!run?.rehearsal;
  await releaseRun();paint();$('#rehearsal').checked=rehearsal;persist();confirmed=true;
 }catch(e){toast(e.message);}
 finally{busy=false;setPerformanceMode(false);}
 if(confirmed)await draw();
}
$('#acceptButton').onclick=()=>guard(repeatResult);
$('#closeResult').onclick=()=>{
 if(busy)return;
 // Return to an idle machine; saved results remain in the round's history.
 $('#result').hidden=true;clearResultPagination();soundRuntime.stop();stage?.reset();
 leaveGameFullscreen();$('#drawButton').focus({preventScroll:true});
};
$('#copyButton').onclick=()=>guard(async()=>{if(!result)return;const text=result.groups?.length?result.groups.map((g,i)=>`第${i+1}组：${g.map(x=>x.name).join('、')}`).join('\n'):result.results.map(i=>i.name+(result.forfeited?.includes(i.id)?'（已弃奖）':'')).join('、');await navigator.clipboard.writeText(text);toast('结果已复制');});
for(const [id,machine] of Object.entries(CONTENT.machines)){
 if($(`[data-machine="${id}"]`))continue;
 const button=element('button');button.dataset.machine=id;
 const text=element('div',machine.name);text.append(element('small',machine.description));
 button.append(element('span',machine.icon||'◉'),text,element('em',machine.feature?'增值':'免费'));
 $('.machines').append(button);
}
$$('[data-app]').forEach(b=>b.onclick=()=>guard(()=>switchApp(b.dataset.app)));$$('[data-machine]').forEach(b=>b.onclick=()=>guard(()=>switchMachine(b.dataset.machine)));
$('#themeButton').onclick=()=>guard(themes);$('#mobileMachine').onclick=()=>guard(themes);$('#libraryButton').onclick=()=>guard(library);$('#historyButton').onclick=()=>guard(history);$('#inviteButton').onclick=()=>guard(inviteFriends);$('#experienceButton').onclick=()=>guard(async()=>{const body=openModal('演出偏好');body.append(element('p','每次进入默认最高画质、完整动效。简洁动效仅本次生效；声音与节奏会保存在本设备。','modal-copy'));audioPreferences(body);itemRow(body,'当前音效',themeSounds(config.theme).find(([id])=>id===config.sound)?.[1].character||'默认声音','选择音效',()=>themes('sounds'));const quality=$('#quality').cloneNode(true);quality.removeAttribute('id');quality.value=$('#quality').value;const qualityLabel=element('label','画面质量','field');qualityLabel.append(quality);quality.onchange=()=>{$('#quality').value=quality.value;stage?.quality(quality.value);};body.append(qualityLabel);const paceSelect=document.createElement('select');for(const [value,label]of [['standard','标准 · 默认节奏'],['calm','从容 · 多等待约 1.6 秒']]){const option=element('option',label);option.value=value;paceSelect.append(option);}paceSelect.value=pace;paceSelect.onchange=()=>{pace=paceSelect.value==='calm'?'calm':'standard';storage.set('clm-draw-pace',pace);};const paceLabel=element('label','抽取节奏','field');paceLabel.append(paceSelect);body.append(paceLabel);const simple=element('label','简洁动效','checkbox'),toggle=element('input');toggle.type='checkbox';toggle.checked=$('#reduceMotion').checked;toggle.onchange=()=>{$('#reduceMotion').checked=toggle.checked;stage?.reduced(toggle.checked);};simple.prepend(toggle);body.append(simple,element('p','空格键只在舞台空闲且没有打开面板时开始抽取。演出中可以按 Esc 退出全屏，已保存结果会保留。','modal-copy'));});$('#applyButton').onclick=()=>guard(applySettings);
$('#saveButton').onclick=()=>guard(async()=>{if(preview)return toast('主题预览不会覆盖正式配置，请结束预览后再保存');if(dirty&&!await applySettings())return;if(account.kind==='guest'){persist();location.href='/login.html?next='+encodeURIComponent('/play.html');return;}saved=await api('/v6/configs',{config,...saved});persist();toast('已保存到账号');});
$('#newRoundButton').onclick=()=>guard(async()=>{if(!await confirmAction('明确开始新一轮？上一轮记录会保留。'))return;await releaseRun();clearResultPagination();$('#result').hidden=true;paint();persist();toast('已准备好新一轮');});
$('#displayButton').onclick=()=>guard(async()=>{if(dirty)return toast('请先应用设置');await ensureRun();const body=openModal('观众大屏'),link=element('a','打开只读展示页 ↗','display-link');link.href=`/play.html?display=${run.id}#${run.view_token}`;link.target='_blank';link.rel='noopener';body.append(element('p','此链接只展示抽取状态和已揭晓结果，不显示完整名单，也不能控制抽奖。主持页面保持打开即可。','modal-copy'),link);const button=element('button','复制大屏链接');button.onclick=()=>guard(async()=>{await navigator.clipboard.writeText(link.href);toast('大屏链接已复制');});body.append(button);});
const feedbackUI=createFeedback({context:()=>({page:'play',app:appKey,machine:config.machine,theme:config.theme,width:innerWidth,height:innerHeight})});
const showFeedback=()=>feedbackUI.open();
$('#accountButton').onclick=()=>guard(async()=>{const b=openModal(account.kind==='guest'?'账号与反馈':'我的账号');if(account.kind==='guest'){b.append(element('p','基础玩法免费不限次。注册后可保存配置，也可随时提出问题与建议。','modal-copy'));const link=element('a','登录 / 免费注册 ↗');link.href='/login.html?next='+encodeURIComponent('/play.html');link.className='modal-copy';link.onclick=persist;b.append(link);itemRow(b,'问题与建议','反馈体验问题，查看处理进度','提交 / 查看',showFeedback);return;}
 b.append(element('p',`${account.name} · 基本抽取免费不限次。会员功能与主题皮肤分别计时。`,'modal-copy'));
 const details=await api('/v6/account');
 for(const [feature,name] of Object.values(CONTENT.products).map(p=>[p.feature,p.name])){
  const active=details.features[feature],sources=details.sources.filter(s=>s.feature===feature&&s.active);
  const expiry=active?.expires_at?new Date(active.expires_at*1000).toLocaleDateString('zh-CN'):'长期有效';
  const sourceNames={card:'卡密',online:'在线订单',referral:'邀请奖励',admin:'管理员赠送',legacy:'历史权益'};
  const kinds=[...new Set(sources.map(s=>sourceNames[s.source_kind]||s.source_kind).filter(Boolean))];
  itemRow(b,name,active?`已开通 · ${expiry}${kinds.length?' · 来源：'+kinds.join('、'):''}`:'未开通 · 可免费体验基础抽取',null,null);
 }
 const shortcuts=element('div',undefined,'account-shortcuts');for(const [label,action] of [['我的订单',orders],['我的配置',library],['兑换卡密',redeemCard],['主题与升级',themes],['问题与建议',showFeedback]]){const button=element('button',label);button.onclick=()=>guard(action);shortcuts.append(button);}b.append(shortcuts);
 const change=element('a','修改密码 ↗');change.href='/password.html?next='+encodeURIComponent(location.pathname+location.search);change.className='modal-copy';change.style.cssText='display:inline-block;margin:16px';b.append(change);
 itemRow(b,'账号操作','退出后本设备保留未保存的配置草稿','退出登录',async()=>{await api('/logout',{});location.reload();});});
$('#modal').addEventListener('close',()=>{
 if(suppressedModalCloses){suppressedModalCloses--;return;}
 if($('#modal').open)return;
 stopOrderWatch();
 const closing=modalPanel;modalPanel='';if(!displayId)panelHistory.close(closing);
});
let settingsReturnTarget=$('#mobileSettings');
function openSettings(pushHistory=true){
 const panel=$('#settingsPanel');if(busy||panel.classList.contains('open'))return;
 settingsReturnTarget=document.activeElement instanceof HTMLElement?document.activeElement:$('#mobileSettings');
 panel.inert=false;panel.classList.add('open');$('#settingsBackdrop').hidden=false;
 // Opening a panel must not summon the phone keyboard and hide its controls.
 $('#closeSettings').focus({preventScroll:true});if(pushHistory&&!displayId)panelHistory.open('settings');
}
function closeSettings(useHistory=true){
 const panel=$('#settingsPanel');if(!panel.classList.contains('open'))return;
 panel.classList.remove('open');panel.inert=true;$('#settingsBackdrop').hidden=true;
 settingsReturnTarget?.focus({preventScroll:true});if(useHistory&&!displayId)panelHistory.close('settings');
}
function closeModalFromHistory(){
 if($('#modal').open){stopOrderWatch();suppressedModalCloses++;$('#modal').close();}
 modalPanel='';
}
function restorePanelFromHistory(){
 if(displayId)return;
 panelHistory.settle();
 const key=panelHistory.current();
 if(key==='settings'){closeModalFromHistory();openSettings(false);return;}
 closeSettings(false);
 if(key&&key===modalPanel&&$('#modal').open)return;
 closeModalFromHistory();
 if(key==='shop')guard(themes);
 else if(key==='invite')guard(inviteFriends);
 else if(key==='panel'){
  if($('#modalBody').childNodes.length){modalPanel='panel';$('#modal').showModal();}
  else panelHistory.close('panel');
 }
}
window.addEventListener('popstate',restorePanelFromHistory);
$('#modalClose').onclick=()=>$('#modal').close();
$('#mobileSettings').onclick=()=>openSettings();$('#closeSettings').onclick=()=>closeSettings();$('#settingsBackdrop').onclick=()=>closeSettings();
if(!displayId)panelHistory.initialize();
$('#fullscreenButton').onclick=toggleGameFullscreen;$('#touchExit').onclick=leaveGameFullscreen;syncGameFullscreen();
let soundToggleVersion=0;
$('#muteButton').onclick=async()=>{
 const version=++soundToggleVersion;
 const retry=['unavailable','pending'].includes(soundRuntime.status());
 muted=retry?false:!muted;soundRuntime.setMuted(muted);storage.set('clm-muted',muted);
 if(muted)return toast('音效已关闭');
 soundRuntime.setHidden(document.hidden);
 if(!soundRuntime.arm())return toast('音效未能启动，请点击声音按钮重试');
 const ready=await soundRuntime.whenReady();
 if(version!==soundToggleVersion||muted||soundRuntime.status()==='hidden'||soundRuntime.status()==='idle')return;
 if(!ready)return toast('音效未能启动，请点击声音按钮重试');
 const played=soundRuntime.play(`${config.machine}-start`,1,config.theme);
 toast(played?'音效已开启，正在试听':'音效暂时不可用，请重试');
};$('#quality').onchange=e=>stage?.quality(e.target.value);$('#reduceMotion').onchange=e=>{stage?.reduced(e.target.checked);};
for(const selector of ['#configTitle','#candidates','#drawCount','#groupCount','#awards','#crossUnique','#brandTitle'])$(selector).addEventListener('input',()=>{dirty=true;});
$('#tagFilter').onchange=()=>{dirty=true;};
$('#currentAward').onchange=()=>{if(busy){$('#currentAward').value=pendingRequest?.award_id||selectedAward;toast('正在抽取，当前奖项已锁定');return;}selectedAward=$('#currentAward').value;persist();};
async function changeDrawMode(mode){
 const previous=formMode;
 if(preview){$('#drawMode').value=previous;return toast('请结束主题预览后修改规则');}
 if(mode===previous)return;
 const from=previous==='winners'?'winners':'pool',to=mode==='winners'?'winners':'pool';
 if(appKey!=='prize'||from===to){
  // A rule is part of the same unsaved form. Never repaint from the saved config.
  formMode=mode;dirty=true;
  $('#groupField').hidden=mode!=='groups';
  $('#candidateHelp').textContent=mode==='inventory'?'每行：奖品名称,库存；例如 保温杯,3':mode==='weighted'?'每行：选项名称,权重；默认权重为 1':'每行一项；行首加 ! 临时排除。重名按编号区分。';
  if(['food','play'].includes(appKey))$('#candidateHelp').textContent+=' 可用 #标签 分类。';
  toast('规则已选择，名单已保留；应用设置后生效');return;
 }
 $('#drawMode').value=previous;
 if(!await confirmAction('奖品清单与获奖人名单分别保存。继续将保留当前输入并切换名单；如有未应用修改，当前轮次会结束，历史记录保留。'))return;
 if(dirty){const next=readConfig(previous);await releaseRun();config=next;}
 const modes=storage.get('clm-prize-modes',{});
 modes[from]={config,run,saved,pendingRequest,selectedAward};storage.set('clm-prize-modes',modes);
 const cached=modes[to];
 if(cached){({config,run,saved,pendingRequest,selectedAward}=cached);}
 else{config=defaults('prize');run=null;saved=null;pendingRequest=null;selectedAward='';if(to==='winners'){config.items=APPS.person.items.map(name=>({id:uid(),name,stock:1,weight:1,excluded:false,tags:[]}));config.machine='sphere';config.awards=[{id:uid(),name:'幸运奖',count:1}];}}
 if(run&&config.mode!==mode)await releaseRun();config.mode=mode;dirty=false;paint();persist();if(run)await restoreState(await api(`/v6/runs/${run.id}`));toast('名单已切换，当前输入与原记录已保留');
}
$('#drawMode').onchange=()=>{const mode=$('#drawMode').value;if(busy||appearanceBusy){$('#drawMode').value=formMode;return toast('正在揭晓，请稍候');}guard(()=>changeDrawMode(mode));};
$('#rehearsal').onchange=()=>{if(run){$('#rehearsal').checked=run.rehearsal;toast('请新开一轮后切换演练或正式');}};
document.addEventListener('keydown',e=>{
 // Leave system shortcuts and IME composition to their original owner.
 if(e.ctrlKey||e.altKey||e.metaKey||e.isComposing||e.defaultPrevented)return;
 const settings=$('#settingsPanel'),inSettings=settings.classList.contains('open');
 if(document.querySelector('dialog[open]'))return;
 if(e.code==='Escape'&&inSettings){e.preventDefault();closeSettings();return;}
 if(e.code==='Escape'&&document.body.classList.contains('in-performance')&&!document.fullscreenElement){leaveGameFullscreen();return;}
 if(e.code==='Tab'&&inSettings){
  const nodes=$$('#settingsPanel a[href],#settingsPanel button:not([disabled]),#settingsPanel input:not([disabled]),#settingsPanel select:not([disabled]),#settingsPanel textarea:not([disabled])').filter(node=>node.getClientRects().length);
  if(nodes.length){const first=nodes[0],last=nodes.at(-1),inside=settings.contains(document.activeElement);if(e.shiftKey&&(document.activeElement===first||!inside)){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||!inside)){e.preventDefault();first.focus();}}
  return;
 }
 if(e.code!=='Space'&&e.key!==' '&&e.key!=='Spacebar')return;
 if(waitingForStop&&e.target?.closest?.('#drawButton')){e.preventDefault();return;}
 if(inSettings)return;
 const target=e.target;
 // The stage owns Space even after a mouse click leaves focus on a toggle or
 // toolbar button. Forms, result actions and the exit control keep native keys.
 if(target?.closest?.('textarea,select,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]),[contenteditable],#result,#edgeReveal,#touchExit')||target?.isContentEditable)return;
 e.preventDefault();
 // Suppress native activation on repeats too; otherwise a held Space can
 // toggle the focused checkbox or activate a toolbar after the draw finishes.
 if(e.repeat||busy||displayId)return;
 guard(draw);
});
let controlsTimer=null;document.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'&&(event.clientX<24||event.clientX>innerWidth-24)){const panel=$('.stage-panel');panel.classList.add('controls-visible');clearTimeout(controlsTimer);controlsTimer=setTimeout(hideGameControls,2500);}});
$('#edgeReveal').onclick=()=>{const panel=$('.stage-panel');panel.classList.add('controls-visible');clearTimeout(controlsTimer);controlsTimer=setTimeout(hideGameControls,3000);$('#touchExit').focus({preventScroll:true});};
for(const node of [$('#edgeReveal'),$('#touchExit')]){
 node.addEventListener('focus',()=>$('.stage-panel').classList.add('controls-visible'));
 node.addEventListener('blur',()=>{clearTimeout(controlsTimer);controlsTimer=setTimeout(hideGameControls,1000);});
}
window.addEventListener('beforeunload',()=>persist());
document.addEventListener('visibilitychange',()=>soundRuntime.setHidden(document.hidden));
window.addEventListener('pagehide',()=>soundRuntime.setHidden(true));
window.addEventListener('pageshow',()=>soundRuntime.setHidden(document.hidden));
// Each visit starts with the full experience, regardless of old device preferences.
$('#reduceMotion').checked=false;
$('#quality').value='high';
$('#stage').addEventListener('resultpagechange',resultPageChanged);
try{soundRuntime.stop();stage=createStage($('#stage'),draw,playMachineSound,$('#reduceMotion').checked);stage.quality('high');$('#stageLoading').remove();const info=stage.resultPageInfo();if(info)resultPageChanged({detail:info});}catch(e){$('#stageLoading').textContent='3D 初始化失败，请使用支持 WebGL 的浏览器或刷新重试。';$('#drawButton').disabled=true;console.error(e);}
async function restoreState(state,{revealSaved=false}={}){
 // A late read from startup or a different scene must not interrupt a new draw.
 if(!run||state.id!==run.id||busy)return;
 if(state.archived){run=null;pendingRequest=null;persist();return;}
 refreshProgress(state);const p=state.presentation;
 if(p?.phase==='spinning'){
  if(p.controller_id!==controllerId){toast('另一主持页面正在抽取；可从记录中明确接管');return;}
  pendingRequest={request_id:p.request_id,award_id:p.award_id};persist();toast('已恢复进行中的抽取，继续后停止揭晓');$('#drawButton strong').textContent='恢复本次抽取';
 }else if(revealSaved&&state.draws.length)showResult(markedResult(state,state.draws.at(-1)));
}
async function recoverRun(id){
 if(preview)return toast('请先结束主题预览，再接管正式场次');
 if(!await confirmAction('接管后，旧主持页面的操作权将失效。已保存结果和进行中的抽取都会保留。继续？'))return;
 const state=await api(`/v6/runs/${id}`),control=await api(`/v6/runs/${id}/control`,{controller_id:controllerId});
 persist();appKey=state.config.app;config=state.config;run=control;saved=config.source_config_id?{id:config.source_config_id,revision:config.source_config_revision||0}:null;dirty=false;preview=null;pendingRequest=null;paint();await restoreState(await api(`/v6/runs/${id}`),{revealSaved:true});persist();$('#modal').close();toast('主持控制已恢复');
}
if(displayId){
 document.body.classList.add('display-mode');let last=null,displayState=null;const token=location.hash.slice(1);
 const poll=async()=>{try{
  const d=await api(`/v6/display/${encodeURIComponent(displayId)}`,undefined,{'X-View-Token':token});renderBrand(d);$('.stage-panel').classList.toggle('cosmic-stage',CONTENT.themes[d.theme]?.renderer==='cosmic');$('#sceneTitle').textContent=d.brand||d.title;$('#sceneSubtitle').textContent=(d.rehearsal?'演练场次 · ':'')+(d.archived?'本场已结束':d.presentation?.phase==='spinning'?'好运正在靠近，请等待主持人揭晓':'现场抽奖 · 请等待主持人');$('#sceneNumber').textContent='';$('#poolBadge').textContent='观众大屏';$('#modeBadge').textContent=d.rehearsal?'演练 · 不作为正式结果':'现场展示';
  const current=d.draws.at(-1),resultKey=current?current.id+':'+(current.forfeited||[]).join(','):'',spinning=d.presentation?.phase==='spinning';
  const placeholders={...defaults('person'),machine:d.machine,theme:d.theme,backdrop:d.backdrop||'',items:Array.from({length:32},(_,i)=>({id:String(i),name:'好运',excluded:false}))};
  if(spinning){if(displayState?.presentation?.request_id!==d.presentation.request_id||displayState?.presentation?.phase!=='spinning'){stage?.configure(placeholders);stage?.start();$('#result').hidden=true;}}
  else if(current&&(resultKey!==last||displayState?.presentation?.phase==='spinning')){last=resultKey;stage?.configure({...placeholders,items:current.results});showResult(current);}
  else if(!displayState||displayState.presentation?.phase==='spinning')stage?.configure(placeholders);
  displayState=d;
 }catch(e){$('#sceneSubtitle').textContent='连接中断，保留已确认结果 · '+e.message;}setTimeout(poll,1000);};poll();
}else{
 paint();if(CONTENT.themes[query.get('skin')]&&!preview)guard(()=>togglePreview({theme:query.get('skin')}));if(draftImportFailed)toast('设备草稿暂未恢复，原数据已保留；释放浏览器存储后刷新重试');api('/v6/status').then(async d=>{if(d.kind==='user'&&!d.role){try{const response=await fetch('/api/me',{credentials:'same-origin'});if(response.ok)d.role=(await response.json()).user?.role;}catch{}}account=d;if($('#adminLink'))$('#adminLink').hidden=d.role!=='superadmin';const lastOrder=storage.get('clm-last-order',null);if(lastOrder&&d.kind==='user'){api('/v6/orders/'+lastOrder).then(o=>{if(o.state==='paid'){storage.set('clm-checkout-'+o.slug,null);storage.set('clm-last-order',null);toast('上次购买已生效，可在机台库使用');}else if(!['closed','failed','cancelled'].includes(o.state))toast('有未完成订单，可在我的账号 → 我的订单继续查询');}).catch(()=>{});}$('#accountButton').textContent=d.kind==='guest'?'账号与反馈 ↗':`${d.name} · ${d.features.includes('pro')?'专业功能已开通':'免费账号'}`;
  if(run){const restoringRunId=run.id;try{await restoreState(await api(`/v6/runs/${restoringRunId}`));}catch(e){if(run?.id===restoringRunId&&!busy){if(e.status===404){run=null;pendingRequest=null;persist();}else toast('记录暂未恢复，请保持页面后重试');}}}
  if(CONTENT.machines[query.get('machine')]&&!preview)await guard(()=>switchMachine(query.get('machine')));
 const returnOrder=query.get('order'),validReturnOrder=!!returnOrder&&/^[A-Za-z0-9]{12,64}$/.test(returnOrder);
 if(returnOrder&&!validReturnOrder){const body=openModal('订单状态');body.append(element('p','订单号格式不正确，请从订单链接或“我的订单”重新打开。','modal-copy'));}
 else if(validReturnOrder&&d.kind!=='user'){location.href='/login.html?next='+encodeURIComponent(`/play.html?order=${encodeURIComponent(returnOrder)}`);return;}
 else if(validReturnOrder&&d.kind==='user'){try{await renderOrder(await api(`/v6/orders/${encodeURIComponent(returnOrder)}/refresh`,{}));}catch(e){const body=openModal('订单状态');body.append(element('p',e.message||'暂时无法读取订单。订单仍保留在账号中，请稍后从我的订单重试。','modal-copy'));}}
 else if(panelHistory.current())restorePanelFromHistory();
 }).catch(e=>toast(e.message));
}
for(const [id,name] of [['mobileSettings','users'],['themeButton','spark'],['historyButton','history'],['experienceButton','settings']]){const node=$('#'+id+' span');if(node)node.innerHTML=uiIcon(name);}
$('#fullscreenButton').innerHTML=uiIcon('fullscreen');
$('#libraryButton').innerHTML=uiIcon('folder');
// HTML keeps controls inert until asynchronous account loading and input
// handlers are ready, so early Space/clicks cannot activate unbound controls.
$('.stage-panel').inert=false;
