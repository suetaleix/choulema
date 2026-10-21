import {$,$$,icon,brand,previewBar,footer,addOverlayShell,openDialog,closeDialog,toast,readDemo,writeDemo,copyText,escapeHTML} from './ui.js';

const page=document.body.dataset.page;
const scenes={
  food:{label:'抽吃什么',icon:'food',title:'今天，吃点什么？',subtitle:'把纠结放进胶囊，把期待留给下一餐。',brief:'给每一餐一点新鲜感',button:'抽一道',items:['火锅','寿司','烤肉','小龙虾','披萨','拉面','粤菜','饺子','麻辣烫','泰国菜','汉堡','轻食']},
  play:{label:'抽玩什么',icon:'play',title:'今天，玩点不一样。',subtitle:'一次随机的选择，也许就是今天的小惊喜。',brief:'发现下一个好主意',button:'抽个玩法',items:['看电影','逛书店','打羽毛球','一起做饭','玩桌游','骑自行车','去散步','看展览','做手工','逛公园','拼拼图','去唱歌']},
  prize:{label:'抽奖品',icon:'gift',title:'让好运，找到主人。',subtitle:'每一份期待，都值得一次认真揭晓。',brief:'让惊喜有仪式感',button:'开始抽奖',items:['电影票','咖啡券','蓝牙音箱','保温杯','帆布袋','小夜灯','纪念徽章','无线耳机','零食礼盒','拍立得','花束','书店礼卡']},
  person:{label:'抽点名',icon:'person',title:'下一位，就是你。',subtitle:'每个名字都在这颗星球上，等待属于自己的高光。',brief:'让每个人都有机会',button:'开始点名',items:['林小夏','许知远','周可可','陈一诺','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','何以宁','苏青禾','程亦辰','唐思语','陆知遥','宋嘉树','方一禾','顾星河','周予安','陈子衿','李沐阳','许清和','江望舒','林予曦','王若楠','赵景行','刘知意','徐朝雨','夏初晴','沈听澜']},
};
const machineNames={capsule:'胶囊机',sphere:'姓名星球',wheel:'经典转盘'};
const initialScene=new URLSearchParams(location.search).get('scene');
let sceneKey=scenes[initialScene]?initialScene:'food';
let machine=sceneKey==='person'?'sphere':'capsule';
let theme='classic',stage=null,phase='idle',used=new Set(),historyItems=[];
let noRepeat=false,immersiveDefault=true,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
let items=makeItems(scenes[sceneKey].items),controlsTimer;
function makeItems(names){return names.map((name,index)=>({id:`prototype-${index}`,name,weight:1,stock:1,excluded:false,tags:[]}));}
function sceneConfig(){return {machine,theme,items,backdrop:'prototype-transparent',title:scenes[sceneKey].title,app:sceneKey,mode:'normal',count:1,brand:''};}
function sceneLoading(){return '<div class="stage-fallback"><div class="fallback-orb"></div><p>正在点亮你的 3D 机台…</p></div>';}
function inviteHint(){const reward=readDemo().invite;return reward.enabled?`会员 ${reward.proDays} 天${reward.skin==='cosmic'?` · 星空皮肤 ${reward.skinDays} 天`:''}`:'邀请朋友，免费一起玩';}
function loginMarkup(){
  return `${previewBar('login')}<header class="header">${brand()}<nav class="header-nav" aria-label="介绍"><button class="nav-how" data-action="intro">怎么玩</button><button data-action="pricing">免费与升级</button><a class="button compact" href="./play.html">直接体验 ${icon('arrow')}</a></nav></header>
  <main class="login-main"><div class="login-layout"><section class="login-hero"><div class="hero-orbit-label"><i class="dot"></i> 免费 3D 机台</div><div class="hero-copy"><span class="eyebrow"><i class="dot"></i> 不必纠结，来抽一下</span><h1>让选择，<br><em>值得期待。</em></h1><p>吃什么，玩什么，下一位是谁。<br>交给机台，收获一点意料之外。</p></div><div id="sceneMount" class="hero-scene" aria-label="可拖动查看的胶囊机">${sceneLoading()}</div><div class="hero-actions"><a class="button light" href="./play.html">免费玩一局 ${icon('arrow')}</a><small>无需注册 · 完整体验 · 不限次数</small></div><div class="hero-caption"><b>真实的转动。刚刚好的悬念。</b><span>胶囊机 · 基础外观</span></div></section>
  <section class="auth-card" aria-labelledby="authTitle"><div class="auth-glyph">${icon('spark')}</div><h2 id="authTitle">给好运留个位置。</h2><p>免费注册，保存你的专属名单与玩法。</p><div class="segment" role="group" aria-label="账号操作"><button class="selected" data-auth="register">免费注册</button><button data-auth="login">登录账号</button></div><div id="inviteArrival" class="notice purple" hidden></div><form id="authForm"><div class="auth-inputs"><label class="field">账号<input name="account" placeholder="原型账号，无需填写真实资料" autocomplete="off"></label><label class="field">密码<input name="password" type="password" placeholder="原型不会提交或保存密码" autocomplete="off"></label></div><label class="check-label"><input id="agreement" type="checkbox" checked><span>我已了解<button type="button" class="text-button" data-action="agreement">使用与隐私说明</button></span></label><button class="button primary wide" id="authSubmit" type="submit">免费注册，开始玩 ${icon('arrow')}</button></form><p class="fineprint">这里是交互原型，点击后进入示例账户。<br>正式版基础玩法免费，不自动续费。</p><div class="auth-tail">${icon('shield')} 免费玩，也可以有自己的风格。</div></section></div>
  <section class="login-under" aria-label="四种玩法"><div><h3>同一份期待，四种玩法。</h3><p>日常选择，也能有点仪式感。</p></div>${Object.entries(scenes).map(([key,s])=>`<a class="scene-link" href="./play.html?scene=${key}"><span class="scene-glyph">${icon(s.icon)}</span><span><b>${s.label}</b><small>${s.brief}</small></span></a>`).join('')}</section></main>${footer()}`;
}
function playMarkup(){
  return `${previewBar('play')}<main class="game-shell"><section class="play-stage game-stage" id="playStage" aria-label="全屏游戏舞台"><div class="stage-canvas" id="sceneMount" aria-label="拖动查看机台，轻点机台抽取">${sceneLoading()}</div>
  <header class="game-top stage-ui">${brand()}<nav class="game-scenes" aria-label="切换玩法">${Object.entries(scenes).map(([key,s])=>`<button data-scene="${key}" class="${key===sceneKey?'selected':''}" aria-pressed="${key===sceneKey}">${icon(s.icon)}<span>${s.label}</span></button>`).join('')}</nav><div class="game-account"><button class="icon-button" data-action="fullscreen" aria-label="进入浏览器全屏">${icon('fullscreen')}</button><button class="account-button" data-action="account"><span class="avatar">${readDemo().signedIn?'夏':icon('person')}</span><span id="accountLabel">${readDemo().signedIn?'我的账户':'登录 / 注册'}</span></button></div></header>
  <div class="game-caption stage-ui"><span class="eyebrow"><i class="dot"></i><span id="machineCaption">${machineNames[machine]} · 免费</span></span><h1 id="sceneTitle">${scenes[sceneKey].title}</h1><p id="sceneSubtitle">${scenes[sceneKey].subtitle}</p></div>
  <nav class="machine-rail stage-ui" aria-label="换机台">${Object.entries(machineNames).map(([key,name])=>`<button data-machine="${key}" class="${key===machine?'active':''}" aria-pressed="${key===machine}" title="${name}">${icon(key)}<span>${name}<small>免费机台</small></span></button>`).join('')}</nav>
  <nav class="game-tool-rail stage-ui" aria-label="游戏工具"><button data-action="candidates" title="候选与规则">${icon('settings')}<span>设置</span></button><button data-action="shop" title="皮肤与机台">${icon('spark')}<span>外观</span></button><button data-action="history" title="抽取记录">${icon('history')}<span>记录</span></button><button data-action="experience" title="演出偏好">${icon('fullscreen')}<span>体验</span></button></nav>
  <button class="game-invite stage-ui" data-action="invite">${icon('gift')}<span>把好运分享给朋友<small>${inviteHint()}</small></span>${icon('chevron')}</button>
  <div class="stage-bottom stage-ui"><button class="draw-button" id="drawButton" disabled>${icon('spark')}<span id="drawLabel">${scenes[sceneKey].button}</span>${icon('arrow')}</button><span class="draw-hint"><span class="desktop-key"><kbd>空格</kbd> 也可以抽取</span><span>·</span> 拖动机台，换个角度</span></div>
  <button class="candidate-chip stage-ui" data-action="candidates"><span>我的候选 <b id="poolCount">${items.length}</b><small>随机选一个 · 免费不限次</small></span>${icon('edit')}</button>
  <div id="resultOverlay" class="result-overlay" hidden><span>这次，就选</span><h2 id="resultName"></h2><div class="row"><button class="button light" data-action="again">再抽一次 ${icon('arrow')}</button><button class="button ghost" data-action="return">返回机台</button></div><p class="result-note">原型随机演示 · 不写入正式抽取记录</p></div>
  <button class="immersive-exit" id="exitImmersive">${icon('close')} 退出沉浸</button><p class="immersive-hint">Esc 退出沉浸 · 结果会保留</p></section></main>`;
}

if(page==='admin'){
  const {initAdmin}=await import('./admin.js');
  initAdmin();
}else{
  $('#app').innerHTML=page==='login'?loginMarkup():playMarkup();
  addOverlayShell();bindPage();initStage();
}

async function initStage(){
  try{
    const {createStage}=await import('/v6/stage.js?v=ce-contrast-1');
    stage=createStage($('#sceneMount'),()=>{if(page==='play')draw();},()=>{},reduced);
    stage.quality('high');stage.configure(sceneConfig());
    $('#sceneMount .stage-fallback')?.remove();
    if($('#drawButton'))$('#drawButton').disabled=false;
  }catch(error){
    const fallback=$('#sceneMount .stage-fallback p');
    if(fallback)fallback.textContent='3D 暂时不可用。请使用支持 WebGL 的浏览器；其他原型面板仍可查看。';
    console.error('V7 prototype 3D initialization failed',error);
  }
  window.addEventListener('pagehide',()=>stage?.dispose(),{once:true});
}
function bindPage(){
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-action]');
    if(trigger)handleAction(trigger.dataset.action);
  });
  if(page==='login'){
    let authMode='register';
    $$('[data-auth]').forEach(button=>button.addEventListener('click',()=>{
      authMode=button.dataset.auth;
      $$('[data-auth]').forEach(b=>b.classList.toggle('selected',b===button));
      $('#authTitle').textContent=authMode==='login'?'欢迎回来，继续玩。':'给好运留个位置。';
      $('#authSubmit').innerHTML=(authMode==='login'?'登录，继续玩':'免费注册，开始玩')+icon('arrow');
    }));
    $('#authForm').addEventListener('submit',event=>{
      event.preventDefault();if(!$('#agreement').checked)return toast('请先了解原型的使用说明。');
      writeDemo({signedIn:true});location.href='./play.html';
    });
    if(new URLSearchParams(location.search).get('invite')){
      $('#inviteArrival').hidden=false;
      $('#inviteArrival').textContent='朋友邀请你免费玩抽了马。这是本地邀请原型，不会注册真实账号或实际发奖。';
    }
    return;
  }
  $$('[data-scene]').forEach(button=>button.addEventListener('click',()=>setScene(button.dataset.scene)));
  $$('[data-machine]').forEach(button=>button.addEventListener('click',()=>setMachine(button.dataset.machine)));
  $('#drawButton').addEventListener('click',draw);
  $('#exitImmersive').addEventListener('click',exitImmersive);
  $('#playStage').addEventListener('pointermove',showControls);
  $('#playStage').addEventListener('pointerdown',showControls);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!$('#dialog').open){exitImmersive();return;}
    if(event.code!=='Space'||event.repeat||event.isComposing||$('#dialog').open)return;
    if(event.target.closest('input,textarea,select,button,a,[contenteditable="true"]'))return;
    event.preventDefault();draw();
  });
  document.addEventListener('fullscreenchange',()=>{
    if(!document.fullscreenElement){$('#playStage').classList.remove('immersive');document.body.classList.remove('in-performance');if(phase==='idle')$$('.stage-ui').forEach(node=>node.inert=false);}
  });
}
function refreshStage(){
  stage?.configure(sceneConfig());stage?.reset();phase='idle';
  $$('.stage-ui').forEach(node=>node.inert=false);
  $('#resultOverlay').hidden=true;$('#playStage').classList.remove('show-result');
  $('#playStage').classList.toggle('cosmic',theme==='cosmic');
  $('#sceneTitle').textContent=scenes[sceneKey].title;$('#sceneSubtitle').textContent=scenes[sceneKey].subtitle;
  $('#drawLabel').textContent=scenes[sceneKey].button;$('#poolCount').textContent=items.length;
  $('#machineCaption').textContent=`${machineNames[machine]} · ${theme==='cosmic'?'星空皮肤预览':'免费'}`;
  $$('[data-scene]').forEach(b=>{b.classList.toggle('selected',b.dataset.scene===sceneKey);b.setAttribute('aria-pressed',String(b.dataset.scene===sceneKey));});
  $$('[data-machine]').forEach(b=>{b.classList.toggle('active',b.dataset.machine===machine);b.setAttribute('aria-pressed',String(b.dataset.machine===machine));});
}
function setScene(key){
  if(phase==='busy')return;
  sceneKey=key;items=makeItems(scenes[key].items);used.clear();
  if(key==='person')machine='sphere';theme='classic';refreshStage();
  const url=new URL(location.href);url.searchParams.set('scene',key);history.replaceState(null,'',url);
}
function setMachine(key){if(phase==='busy')return;machine=key;if(key!=='capsule')theme='classic';refreshStage();}
function showControls(){
  if(!$('#playStage')?.classList.contains('immersive'))return;
  $('#playStage').classList.add('controls-visible');
  clearTimeout(controlsTimer);controlsTimer=setTimeout(()=>$('#playStage')?.classList.remove('controls-visible'),1900);
}
function enterImmersive(){
  const element=$('#playStage');if(!element)return;
  element.classList.add('immersive');document.body.classList.add('in-performance');showControls();
  $$('.stage-ui').forEach(node=>node.inert=true);
  $('#sceneMount').setAttribute('tabindex','-1');$('#sceneMount').focus({preventScroll:true});
  // Called before awaiting anything, while the initiating click/key is still a user gesture.
  if(!document.fullscreenElement&&element.requestFullscreen)element.requestFullscreen().catch(()=>{});
}
function exitImmersive(){
  $('#playStage')?.classList.remove('immersive','controls-visible');document.body.classList.remove('in-performance');
  if(phase==='idle')$$('.stage-ui').forEach(node=>node.inert=false);
  if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function draw(){
  if(!stage||phase==='busy'||$('#dialog').open)return;
  const pool=items.filter(item=>!noRepeat||!used.has(item.id));
  if(!pool.length)return toast('本轮候选已抽完。在设置中点击“重新开始一轮”即可继续。');
  phase='busy';$('#playStage').classList.add('busy');$('#playStage').classList.remove('show-result');$('#resultOverlay').hidden=true;
  $$('.stage-ui').forEach(node=>node.inert=true);
  if(immersiveDefault)enterImmersive();
  // This isolated prototype has no draw API. Production results must remain server-authoritative.
  const random=new Uint32Array(1);crypto.getRandomValues(random);
  const winner=pool[Math.floor((random[0]/4294967296)*pool.length)];
  try{
    if(!await stage.start())throw new Error('机台尚未准备好，请再试一次。');
    await delay(reduced?250:6800);
    stage.reveal([winner]);await delay(reduced?150:stage.revealDelay()+150);
    used.add(winner.id);historyItems.unshift({name:winner.name,scene:scenes[sceneKey].label,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})});
    $('#resultName').textContent=winner.name;$('#resultOverlay').hidden=false;$('#playStage').classList.add('show-result');phase='result';
    $('#resultOverlay [data-action="again"]').focus({preventScroll:true});
  }catch(error){phase='idle';exitImmersive();stage.reset();toast(error.message||'机台暂时不可用，请重试。');}
  finally{$('#playStage').classList.remove('busy');if(phase==='idle')$$('.stage-ui').forEach(node=>node.inert=false);}
}
function handleAction(action){
  if(page==='play'&&phase==='busy'&&action!=='fullscreen')return;
  const actions={intro:showIntro,pricing:showPricing,agreement:showAgreement,account:showAccount,invite:showInvite,candidates:showCandidates,shop:showShop,history:showHistory,experience:showExperience,fullscreen:enterImmersive,again:draw,return:()=>{exitImmersive();refreshStage();},library:showLibrary,redeem:showRedeem,orders:showOrders};
  actions[action]?.();
}
function showIntro(){
  openDialog('四种玩法，一样免费。',`<p>选择一个场景，放入你的候选，然后按下抽取。三台基础机台都可以自由使用。</p><div class="intro-grid">${Object.entries(scenes).map(([key,s])=>`<article class="intro-card"><div class="scene-glyph">${icon(s.icon)}</div><h3>${s.label}</h3><p>${s.brief}。${key==='play'?'只给出做什么，不安排活动日程。':'编辑自己的候选，给选择一个漂亮的开场。'}</p><a class="text-button" href="./play.html?scene=${key}">免费试试看 ${icon('arrow')}</a></article>`).join('')}</div><p class="fineprint" style="margin-bottom:0;margin-top:20px">玩法决定抽什么，机台决定怎么演出。皮肤改变外观，付费不改变结果。</p>`);
}
function showPricing(){
  const {prices}=readDemo();
  openDialog('免费尽兴，升级随心。',`<p>先免费玩，喜欢再升级。皮肤和功能会员分别购买，不自动续费。</p><div class="prices-grid"><article class="price-card"><span class="tag green">一直免费</span><h3>基础玩法</h3><strong>¥0</strong><p>四种用途 · 三台基础机台<br>完整 3D 演出 · 免费不限次<br>免费注册后保存个人配置</p><a class="button" href="./play.html">现在就玩 ${icon('arrow')}</a></article><article class="price-card featured"><span class="tag purple">给机台换个风格</span><h3>星空胶囊皮肤</h3><strong>¥${prices.cosmic.toFixed(2)}<small> / 年</small></strong><p>胶囊机专属星空材质<br>虹彩壳缝 · 星尘揭晓<br>仅包含这一款皮肤 · 365 天</p><button class="button primary" id="previewCosmic">免费预览 ${icon('spark')}</button></article><article class="price-card"><span class="tag">适合课堂与年会</span><h3>专业功能会员</h3><strong>¥${prices.pro.toFixed(2)}<small> / 年</small></strong><p>多班级课次 · 多奖项抽取<br>品牌舞台 · 导入与导出<br>进阶功能权益 · 365 天</p><button class="button" id="showProDetail">看看功能 ${icon('arrow')}</button></article></div><div class="notice" style="margin-top:20px">后续会增加可单独购买的皮肤、新机台和功能包。现有免费机台继续免费；会员不默认包含所有皮肤。原型没有付款能力。</div>`);
  $('#previewCosmic').onclick=()=>{if(page==='play'){closeDialog();machine='capsule';theme='cosmic';refreshStage();toast('正在免费预览星空皮肤，演示结果不会保存到正式记录。');}else location.href='./play.html?skin=cosmic';};
  $('#showProDetail').onclick=()=>openDialog('专业功能会员',`<p>适合需要重复使用名单、管理多轮抽取的课堂和活动组织者。</p><div class="intro-grid"><div class="intro-card"><h3>课堂更有序</h3><p>保存班级，继续课次，查看点名统计；随机分组后查看完整成员。</p></div><div class="intro-card"><h3>活动更从容</h3><p>多奖项、跨奖项不重复、品牌舞台、抽取记录和导出。</p></div></div><div class="notice" style="margin-top:20px">具体可用能力以已验收上线清单为准。会员 ¥${prices.pro.toFixed(2)}／365 天，不包含星空皮肤，不影响中奖概率。</div>`);
}
function showAgreement(){openDialog('使用与隐私说明 · 原型',`<p>本页是设计原型。表单不会提交账号或密码，点击注册／登录仅切换为示例账户。请不要填写真实敏感资料。</p><p>正式产品将说明账号信息、个人配置的存储和删除、邀请归因、收费期限及售后渠道。隐私与服务条款需在上线前完成正式文案。</p>`);}
function showAccount(){
  if(!readDemo().signedIn){openDialog('免费注册，把玩法留下来。',`<div class="account-hero"><span class="avatar">${icon('person')}</span><div><h3>你正在免费体验</h3><p>不登录，也能完整抽取。</p></div></div><p>注册后可以保存配置、查看自己的权益、邀请好友领取会员和皮肤。</p><button class="button primary wide" id="demoSignIn">使用示例账号继续 ${icon('arrow')}</button><a class="button ghost wide" href="./login.html" style="margin-top:10px">查看登录与注册页</a><p class="fineprint">原型演示，不创建真实账号。</p>`,true);$('#demoSignIn').onclick=()=>{writeDemo({signedIn:true});$('#accountLabel').textContent='我的账户';showAccount();};return;}
  openDialog('我的账户',`<div class="account-hero"><span class="avatar">夏</span><div><h3>林小夏 <span class="tag">示例账户</span></h3><p>免费基础用户 · 先免费玩，再按需升级</p></div></div><button class="list-link" data-action="invite">${icon('gift')}<span>邀请好友<small>领 30 天功能会员 + 星空胶囊皮肤</small></span>${icon('chevron')}</button><button class="list-link" data-action="library">${icon('folder')}<span>我的配置<small>把常用菜单、名单留下来</small></span>${icon('chevron')}</button><button class="list-link" data-action="shop">${icon('spark')}<span>我的权益与外观<small>皮肤、机台、功能分别查看</small></span>${icon('chevron')}</button><button class="list-link" data-action="redeem">${icon('card')}<span>兑换卡密</span>${icon('chevron')}</button><button class="list-link" data-action="orders">${icon('order')}<span>我的订单</span>${icon('chevron')}</button><button class="button ghost wide" id="demoLogout" style="margin-top:23px">退出示例账号</button>`,true);
  $('#demoLogout').onclick=()=>{writeDemo({signedIn:false});$('#accountLabel').textContent='登录 / 注册';closeDialog();};
}
function showInvite(){
  const config=readDemo().invite;
  if(!readDemo().signedIn){openDialog('注册后，邀请朋友一起玩。',`<div class="reward-hero">${icon('gift')}<span class="eyebrow">邀请好友 · 分享好运</span><h3>好玩的东西，<br>值得分享。</h3><p>免费注册后可获得自己的邀请链接。</p></div><p>好友通过专属链接完成有效注册，你可领取功能会员和指定皮肤。活动具体奖励由后台配置。</p><button class="button primary wide" id="inviteDemoLogin">使用示例账号查看邀请页 ${icon('arrow')}</button><p class="fineprint">这里只演示页面，不注册真实账户或发放权益。</p>`,true);$('#inviteDemoLogin').onclick=()=>{writeDemo({signedIn:true});$('#accountLabel').textContent='我的账户';showInvite();};return;}
  if(!config.enabled){openDialog('邀请好友',`<div class="notice">当前示例邀请活动已关闭。已获得资格的奖励仍应按原活动规则处理。</div><p class="fineprint">可在超管原型的“邀请活动”中重新开启。</p>`,true);return;}
  const inviteURL=new URL('./login.html?invite=DEMO-XIA',location.href).href;
  openDialog('邀请好友，延长你的好体验。',`<div class="reward-hero">${icon('gift')}<span class="eyebrow">邀请好友 · 分享好运</span><h3>朋友来玩，<br>你的风格续上。</h3><p>每成功邀请一位新朋友注册，就送你功能会员和指定皮肤。</p></div><div class="reward-pair"><div>专业功能会员<strong>${config.proDays} <small>天</small></strong><small>在已有到期时间后顺延</small></div><div>${config.skin==='cosmic'?'星空胶囊皮肤':'皮肤奖励未开启'}<strong>${config.skin==='cosmic'?config.skinDays:0} <small>天</small></strong><small>后台指定皮肤，独立生效</small></div></div><span class="section-label">你的专属邀请链接 · 本地演示</span><div class="copy-row"><input id="inviteLink" readonly value="${escapeHTML(inviteURL)}" aria-label="原型邀请链接"><button class="button primary compact" id="copyInvite">${icon('copy')} 复制</button></div><div class="divider"></div><div class="row between"><b style="font-size:13px">本月已奖励 0 / ${config.cap} 位</b><span class="tag">示例进度</span></div><ul class="simple-list"><li>仅新注册账号计入，不要求好友购买。</li><li>${config.experience?'本活动要求注册后完成一次有效体验。':'好友完成有效注册后发放，不另设体验门槛。'}</li><li>每月最多奖励 ${config.cap} 次。同项权益累加，不覆盖已购权益。</li><li>${config.newcomer?'新朋友同时获得上述奖励。':'奖励给邀请人，新朋友可免费使用基础玩法。'}</li></ul><p class="fineprint">活动条款为建议规则。此原型不会记录邀请关系或发放真实权益。</p>`,true);
  $('#copyInvite').onclick=()=>copyText(inviteURL);
}
function showCandidates(){
  openDialog('候选与规则',`<label class="field">这次抽什么<textarea id="candidateInput" rows="9" maxlength="4000">${escapeHTML(items.map(i=>i.name).join('\n'))}</textarea></label><p class="fineprint">每行一个。原型最多保留 48 项；正式姓名星球继续支持完整名单。</p><label class="mini-settings"><span>本轮不重复<small>同一个候选抽中后，本轮暂不再抽。</small></span><input class="switch" id="repeatInput" type="checkbox" ${noRepeat?'checked':''}></label><div class="divider"></div><div class="row"><button class="button primary" id="applyCandidates">保存并回到机台</button><button class="button" id="resetRound">重新开始一轮</button></div><p class="fineprint">原型只演示单个结果；库存、多奖项和分组设置在 V7 正式接线阶段复用现有能力。</p>`,true);
  $('#applyCandidates').onclick=()=>{const names=$('#candidateInput').value.split('\n').map(s=>s.trim()).filter(Boolean);if(!names.length)return toast('至少放入一个候选再开始。');if(names.length>48)return toast('此 UI 原型最多展示 48 项，请精简后再试。');if(names.some(name=>name.length>50))return toast('此原型每项最多 50 个字符，请缩短长项。');items=makeItems(names);noRepeat=$('#repeatInput').checked;used.clear();closeDialog();refreshStage();toast('候选已更新。只在本次原型页面中保留。');};
  $('#resetRound').onclick=()=>{used.clear();closeDialog();refreshStage();toast('新一轮已准备好。');};
}
function showShop(category='skin'){
  const {prices}=readDemo();
  const skin=`<div class="shop-card"><div class="skin-preview"><span>胶囊机专属 · 材质示意</span></div><div class="shop-title"><h3>星空胶囊</h3><strong>¥${prices.cosmic.toFixed(2)}<small> / 年</small></strong></div><p>深空色彩，虹彩胶囊与星尘揭晓。先完整预览，再决定要不要拥有。</p><div class="row"><button class="button primary" id="useCosmic">免费预览</button><button class="button" id="useClassic">恢复基础外观</button></div><p class="fineprint">365 天 · 仅适用于胶囊机 · 不自动续费<br>原型不提供真实付款。</p></div>`;
  const machines=`<div class="stack">${Object.entries(machineNames).map(([key,name])=>`<button class="mini-item" data-shop-machine="${key}"><span>${name}<small>基础机台，持续免费使用</small></span><span class="tag green">免费</span></button>`).join('')}</div><div class="notice" style="margin-top:18px">后续收费机台将在完成开发与体验验收后上架。目前没有待售新机台。</div>`;
  const features=`<div class="shop-card"><div class="shop-title"><h3>专业功能会员</h3><strong>¥${prices.pro.toFixed(2)}<small> / 年</small></strong></div><ul class="simple-list"><li>多班级、课次管理与点名统计</li><li>活动多奖项与品牌展示</li><li>候选导入、记录导出</li></ul><button class="button primary wide" data-action="pricing">查看免费与付费的完整区别</button><p class="fineprint">365 天 · 不含皮肤 · 不自动续费。此处为权益说明原型。</p></div>`;
  openDialog('外观与进阶体验',`<div class="shop-category"><button data-category="skin" class="${category==='skin'?'active':''}">皮肤</button><button data-category="machine" class="${category==='machine'?'active':''}">机台</button><button data-category="feature" class="${category==='feature'?'active':''}">功能</button></div>${category==='skin'?skin:category==='machine'?machines:features}`,true);
  $$('[data-category]').forEach(button=>button.onclick=()=>showShop(button.dataset.category));
  if(category==='skin'){$('#useCosmic').onclick=()=>{machine='capsule';theme='cosmic';closeDialog();refreshStage();toast('星空皮肤预览已开启，可以免费抽一局。');};$('#useClassic').onclick=()=>{theme='classic';closeDialog();refreshStage();};}
  $$('[data-shop-machine]').forEach(button=>button.onclick=()=>{closeDialog();setMachine(button.dataset.shopMachine);});
}
function showHistory(){openDialog('本次体验记录',`${historyItems.length?`<div class="stack">${historyItems.slice(0,12).map(item=>`<div class="mini-item"><span>${escapeHTML(item.name)}<small>${item.scene} · 原型随机演示</small></span><span class="muted small">${item.time}</span></div>`).join('')}</div>`:'<div class="notice">还没有抽取记录。先抽一次，让好运开个场。</div>'}<p class="fineprint">记录仅保留在本次页面内，刷新即清空。正式版由服务器保存和校验。</p>`,true);}
function showExperience(){openDialog('你的演出偏好',`<label class="mini-settings"><span>抽取时进入沉浸演出<small>界面自动隐去，只看机台过程。</small></span><input class="switch" type="checkbox" id="immersivePref" ${immersiveDefault?'checked':''}></label><label class="mini-settings"><span>简洁动效<small>缩短等待，减少动态效果。</small></span><input class="switch" type="checkbox" id="reducedPref" ${reduced?'checked':''}></label><div class="mini-settings"><span>画面质量<small>原型默认使用最高画质。</small></span><span class="tag purple">最高</span></div><ul class="simple-list"><li>空格键与点击抽取相同；长按和连按不会重复创建抽取。</li><li>输入和打开面板时，空格留给当前控件。</li><li>Esc 退出沉浸；移动设备轻触上方可唤起退出入口。</li></ul><div class="notice">进入玩法即铺满页面。浏览器原生全屏需要点击触发，部分手机会使用页面内全屏。</div>`,true);$('#immersivePref').onchange=e=>immersiveDefault=e.target.checked;$('#reducedPref').onchange=e=>{reduced=e.target.checked;stage?.reduced(reduced);};}
function showLibrary(){openDialog('我的配置 · 示例',`<div class="stack"><button class="mini-item" id="loadFood"><span>不纠结午餐<small>12 个候选 · 胶囊机</small></span>${icon('chevron')}</button><button class="mini-item" id="loadPeople"><span>朋友点名局<small>32 个候选 · 姓名星球</small></span>${icon('chevron')}</button></div><p class="fineprint">示例配置仅用于体验切换，尚未连接个人云端配置。</p>`,true);$('#loadFood').onclick=()=>{closeDialog();setScene('food');};$('#loadPeople').onclick=()=>{closeDialog();setScene('person');};}
function showRedeem(){openDialog('兑换卡密',`<p>会员与皮肤分别激活，已有有效期可以顺延。</p><label class="field">卡密<input id="demoCode" placeholder="原型请使用 DEMO 开头的示意卡密"></label><button class="button primary wide" id="demoRedeem">查看激活示意</button><p class="fineprint">请勿在原型输入真实卡密。此入口不请求兑换接口。</p>`,true);$('#demoRedeem').onclick=()=>{if(!$('#demoCode').value.startsWith('DEMO'))return toast('请使用 DEMO 开头的示意卡密。');toast('激活提示示意：专业功能会员增加 30 天。没有发放真实权益。');};}
function showOrders(){openDialog('我的订单',`<div class="notice">示例账号暂无订单。</div><p class="fineprint">正式版在此继续待付款订单、查询支付结果、查看退款与权益发放进度。原型没有支付接线。</p>`,true);}
if(page==='play'&&new URLSearchParams(location.search).get('skin')==='cosmic'){machine='capsule';theme='cosmic';refreshStage();}
