import {EmailCodeState,emailKey} from './email-verification.mjs';
import {resumePlay} from './resume-play.mjs';
import {createFeedback} from './feedback.mjs';
import {$,$$,icon,brand,footer,addOverlayShell,openDialog,closeDialog,toast,api,escapeHTML,money} from './ui.js';

const playPath='/play.html';
const query=new URLSearchParams(location.search);
const requestedNext=query.get('next');
const safeNext=safeInternalPath(requestedNext)||playPath;
const nextTargetsAdmin=(()=>{try{return new URL(safeNext,location.origin).pathname==='/admin.html';}catch{return false;}})();
const inviteCode=(query.get('invite')||'').trim().slice(0,120);
const scenes={
  food:{label:'抽吃什么',icon:'food',brief:'给每一餐一点新鲜感'},
  play:{label:'抽玩什么',icon:'play',brief:'发现下一个好主意'},
  prize:{label:'抽奖品',icon:'gift',brief:'让惊喜有仪式感'},
  person:{label:'抽点名',icon:'person',brief:'让每个人都有机会'},
};
const capsuleSamples=['火锅','寿司','烤肉','拉面','粤菜','披萨','电影票','咖啡券','保温杯','小夜灯','林小夏','许知远'];
const sphereSamples=['林小夏','许知远','周可可','陈一诺','张星辰','李向阳','王小满','赵一航','刘雨晴','杨子墨','徐安然','沈若溪','何以宁','苏青禾','程亦辰','唐思语'];
const heroMachines={
  capsule:{machine:'capsule',title:'让选择，值得期待。',caption:'胶囊机 · 基础外观',aria:'可拖动查看的真实胶囊机',app:'food',items:capsuleSamples},
  wheel:{machine:'wheel',title:'转一转，让答案揭晓。',caption:'经典转盘 · 基础外观',aria:'可拖动查看的真实经典转盘',app:'food',items:capsuleSamples},
  sphere:{machine:'sphere',title:'让每个人，都有高光时刻。',caption:'姓名星球 · 基础外观',aria:'可拖动查看的真实姓名星球',app:'person',items:sphereSamples},
};
let mode=query.get('mode')==='password'?'password':nextTargetsAdmin?'login':'register';
const emailState=new EmailCodeState();
let emailTimer=null;
let productsPromise=null,productRequestId=0,publicData=null,referralData=null,stage=null;
let currentUser=null,authTouched=false,activeDialog=null,heroMachine='capsule',heroTitleOverride='';
const authDialogKeys=new Set(['intro','pricing','invite-rules']);

function safeInternalPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))return null;
  try{const parsed=new URL(value,location.origin);return parsed.origin===location.origin?parsed.pathname+parsed.search+parsed.hash:null;}catch{return null;}
}
function authDialogFromHash(){const key=location.hash.slice(1);return authDialogKeys.has(key)?key:null;}
function authDialogUrl(key){return `${location.pathname}${location.search}#${key}`;}
function showAuthDialog(key,title,html,{fromHistory=false}={}){
  if(!fromHistory&&authDialogFromHash()!==key){history.pushState({...history.state,loginDialog:key},'',authDialogUrl(key));}
  activeDialog=key;openDialog(title,html);
}
function showDialogState(key){
  if(key==='intro'){showIntro(true);return;}
  if(key==='pricing'){showPricing(true);return;}
  if(key==='invite-rules'&&referralData?.attributed&&referralData.campaign){showReferralRules(referralData.campaign,true);return;}
  closeAuthDialog();
}
function closeAuthDialog(){
  if(authDialogFromHash()){history.back();return;}
  activeDialog=null;closeDialog();
}
function initAuthDialogHistory(){
  const initial=authDialogFromHash();
  if(initial){
    history.replaceState({...history.state,loginDialogBase:true},'',`${location.pathname}${location.search}`);
    history.pushState({...history.state,loginDialog:initial},'',authDialogUrl(initial));
  }
  window.addEventListener('popstate',()=>{
    const next=authDialogFromHash();
    if(next)showDialogState(next);
    else{activeDialog=null;closeDialog();}
  });
  $('#dialog').addEventListener('close',()=>{
    if(!activeDialog)return;
    const closing=activeDialog;activeDialog=null;
    if(authDialogFromHash()===closing)history.back();
  });
  if(initial){
    if(initial==='invite-rules')referralPromise.then(()=>{if(authDialogFromHash()===initial)showDialogState(initial);});
    else showDialogState(initial);
  }
}
function setHeroTitle(value){
  const heading=$('#heroTitle');if(!heading||typeof value!=='string'||!value.trim())return;
  const title=value.replace(/\r\n?/g,'\n').trim(),lines=title.split('\n').map(line=>line.trim()).filter(Boolean);
  heading.replaceChildren();
  if(lines.length>1){
    lines.forEach((line,index)=>{
      const part=document.createElement(index===lines.length-1?'em':'span');
      part.className=index===lines.length-1?'title-accent':'title-line';
      part.append(document.createTextNode(line));heading.append(part);
    });
    return;
  }
  const comma=Math.max(title.indexOf('，'),title.indexOf(','));
  if(comma>0&&comma<title.length-1){
    const first=document.createElement('span');first.className='title-line';first.append(document.createTextNode(title.slice(0,comma+1)));
    const second=document.createElement('em');second.className='title-accent';second.append(document.createTextNode(title.slice(comma+1).trim()));
    heading.append(first,second);return;
  }
  if(title==='让选择，值得期待。'){
    const first=document.createElement('span');first.className='title-line';first.append(document.createTextNode('让选择，'));
    const second=document.createElement('em');second.className='title-accent';second.append(document.createTextNode('值得期待。'));
    heading.append(first,second);return;
  }
  heading.append(document.createTextNode(title));
}
function machineConfig(){
  const selected=heroMachines[heroMachine],items=selected.items.map((name,index)=>({id:`login-${heroMachine}-${index}`,name,weight:1,stock:1,excluded:false,tags:[]}));
  return {machine:selected.machine,theme:'classic',items,backdrop:'v7-transparent',title:selected.caption,app:selected.app,mode:'normal',count:1,brand:''};
}
const copyDefaults={
  intro_text:'选择一种用途，放入候选，然后按下抽取。三台基础机台都可以自由使用。',
  free_description:'四种用途、三台基础机台与基础规则，长期免费使用；注册后可保存个人配置。',
  skin_description:'星空主题带来三款机台的深空外观、星尘揭晓与三种可选音效。',
  pro_description:'多班课次 · 多奖项 · 品牌舞台 · 导入与导出等已提供的专业功能。',
};
function publicText(key,fallback=copyDefaults[key]||''){
  const value=publicData?.content?.[key];return typeof value==='string'&&value.trim()?value.trim():fallback;
}
function sceneDescription(key){
  const value=publicData?.content?.scene_descriptions?.[key];
  return typeof value==='string'&&value.trim()?value.trim():scenes[key].brief;
}
function publicFaq(){
  const faq=publicData?.content?.faq;
  if(Array.isArray(faq)){
    const valid=faq.filter(item=>item&&typeof item.question==='string'&&item.question.trim()&&typeof item.answer==='string'&&item.answer.trim()).slice(0,8);
    if(valid.length)return valid;
  }
  return [
    {question:'基础机台需要付费吗？',answer:'四种基础用途和三台基础机台可以免费使用。'},
    {question:'注册后有什么用？',answer:'免费注册后可以保存个人配置和查看账号权益。'},
    {question:'付费会改变抽取结果吗？',answer:'皮肤只改变外观，专业功能只开放已交付的进阶能力；付费不改变抽取结果。'},
  ];
}
function faqMarkup(){
  const entries=publicFaq();
  return `<section class="auth-faq" aria-label="常见问题"><h3>常见问题</h3>${entries.map(item=>`<details class="auth-faq-item"><summary>${escapeHTML(item.question)}</summary><p>${escapeHTML(item.answer)}</p></details>`).join('')}</section>`;
}
function refreshOpenPublicCopy(){
  if(activeDialog==='intro'){
    const intro=$('#introText');if(intro)intro.textContent=publicText('intro_text');
    for(const key of Object.keys(scenes)){const node=$(`#sceneDescription-${key}`);if(node)node.textContent=sceneDescription(key);}
    const faq=$('#introFaq');if(faq)faq.innerHTML=faqMarkup();
  }else if(activeDialog==='pricing'){
    const values={freeDescription:publicText('free_description'),cosmicDescription:publicText('skin_description'),proDescription:publicText('pro_description')};
    for(const [id,value] of Object.entries(values)){const node=$(`#${id}`);if(node)node.textContent=value;}
    const notice=$('#pricingNotice');if(notice)notice.textContent=publicText('notice','线上商品为 365 天固定期限，不自动续费。购买状态与实际价格以账号和服务端商品信息为准。');
    const faq=$('#pricingFaq');if(faq)faq.innerHTML=faqMarkup();
  }
}
function setHeroMachine(value){
  if(!Object.hasOwn(heroMachines,value))return;
  heroMachine=value;const selected=heroMachines[value];
  $$('[data-hero-machine]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.heroMachine===value)));
  const cta=$('#heroCta');if(cta)cta.href=playPath+'?app='+selected.app+'&machine='+value;
  const mount=$('#sceneMount');if(mount)mount.setAttribute('aria-label',selected.aria);
  const caption=$('#machineCaption');if(caption)caption.textContent=selected.caption;
  if(!heroTitleOverride)setHeroTitle(selected.title);
  if(stage){stage.configure(machineConfig());stage.quality('high');}
}
function loginMarkup(){
  return `<header class="header">${brand('/login.html')}<nav class="header-nav" aria-label="产品介绍"><button class="nav-how" type="button" data-action="intro">怎么玩</button><button type="button" data-action="pricing">免费与升级</button><a class="button compact" href="${playPath}">直接体验 ${icon('arrow')}</a></nav></header>
  <main class="login-main"><div class="login-layout"><section class="login-hero"><div class="hero-orbit-label"><i class="dot"></i> 免费 3D 机台</div><div class="hero-copy"><span class="eyebrow"><i class="dot"></i> 不必纠结，来抽一下</span><h1 id="heroTitle">让选择，<br><em>值得期待。</em></h1><p id="heroText">吃什么，玩什么，下一位是谁。<br>交给机台，收获一点意料之外。</p><p class="hero-notice" id="publicNotice" hidden></p></div><div id="sceneMount" class="hero-scene" aria-label="可拖动查看的真实胶囊机"><div class="stage-fallback"><div class="fallback-orb"></div><p>正在点亮你的 3D 机台…</p></div></div><div class="hero-actions"><a class="button light" href="${playPath}" id="heroCta">免费玩一局 ${icon('arrow')}</a><small>无需注册 · 完整体验 · 不限次数</small></div><div class="hero-machine-picker" role="group" aria-label="预览机台">${Object.entries(heroMachines).map(([key,item])=>`<button type="button" data-hero-machine="${key}" aria-pressed="${key===heroMachine}">${icon(key)}<span>${item.caption.split(' · ')[0]}</span></button>`).join('')}</div><div class="hero-caption" id="heroCaption"><b>真实的转动。刚刚好的悬念。</b><span id="machineCaption">胶囊机 · 基础外观</span></div></section>
  <section class="auth-card" aria-labelledby="authTitle"><div class="auth-glyph">${icon('spark')}</div><h2 id="authTitle">给好运留个位置。</h2><p id="authLead">免费注册，保存你的专属名单与玩法。</p><div id="inviteArrival" class="notice purple" hidden></div><div id="authArea"></div><div class="auth-tail">${icon('shield')} 免费玩，也可以有自己的风格。</div></section></div>
  <section class="login-under" aria-label="四种玩法"><div><h3>同一份期待，四种玩法。</h3><p>日常选择，也能有点仪式感。</p></div>${Object.entries(scenes).map(([key,scene])=>`<a class="scene-link" href="${playPath}?scene=${encodeURIComponent(key)}"><span class="scene-glyph">${icon(scene.icon)}</span><span><b>${scene.label}</b><small>${scene.brief}</small></span></a>`).join('')}</section></main>${footer()}`;
}
function renderAuth(){
  emailState.invalidate();clearInterval(emailTimer);
  const host=$('#authArea');
  $('.auth-card').classList.toggle('returning-user',!!currentUser&&mode!=='password');
  if(mode==='password')return renderPassword(host);
  if(currentUser){
    const label=currentUser.email||currentUser.custom_id||'已登录账号',resume=resumePlay(localStorage,Number(currentUser.id));
    const destination=requestedNext?safeNext:resume?.href||safeNext;
    $('#authTitle').textContent=`欢迎回来，${label}`;
    $('#authLead').textContent=currentUser.must_change_password?'请先修改临时密码，再继续使用。':'让好运，接着发生。';
    host.innerHTML=`<div class="resume-card"><span>${resume?'上次的玩法':'准备好，再来一局'}</span><strong>${escapeHTML(resume?.title||'选一种玩法，开始抽取')}</strong><small>${escapeHTML(resume?.label||'四种玩法 · 三台免费机台')}</small></div><div class="form-actions"><a class="button primary" href="${escapeHTML(currentUser.must_change_password?passwordPath():destination)}">${currentUser.must_change_password?'修改密码':resume?'继续上次玩法':'进入玩法'} ${icon('arrow')}</a><button class="button auth-signout" type="button" id="signOut">退出登录</button></div><p class="fineprint">名单与权益保存在你的账号中。</p>`;
    $('#signOut').addEventListener('click',signOut);
    return;
  }
  $('#authTitle').textContent='给好运留个位置。';
  $('#authLead').textContent=mode==='register'?'免费注册，保存你的专属名单与玩法。':'登录后继续使用已保存的配置与权益。';
  const registrationOpen=publicData?.registration_open!==false;
    host.innerHTML=`<div class="segment" role="group" aria-label="账号操作"><button type="button" data-auth="register" class="${mode==='register'?'selected':''}" ${registrationOpen?'':'hidden'}>免费注册</button><button type="button" data-auth="login" class="${mode==='login'?'selected':''}">登录账号</button></div>
    <form id="authForm" novalidate><div class="auth-inputs"><label class="field">${mode==='register'?'邮箱':'邮箱或账号 ID'}<input name="identifier" type="${mode==='register'?'email':'text'}" inputmode="email" autocomplete="${mode==='register'?'email':'username'}" placeholder="${mode==='register'?'填写常用邮箱':'邮箱地址或已有账号 ID'}" maxlength="254" autocapitalize="none" spellcheck="false" required></label><label class="field">密码<input name="password" type="password" autocomplete="${mode==='register'?'new-password':'current-password'}" placeholder="${mode==='register'?'至少 8 位':'请输入密码'}" minlength="${mode==='register'?8:1}" maxlength="128" required></label></div>${mode==='register'?`<label class="field">邮箱验证码<span class="email-code-row"><input name="email_code" placeholder="6 位验证码" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required><button class="button secondary" id="sendEmailCode" type="button">获取验证码</button></span></label><p class="email-help" id="emailHint">验证邮箱后即可注册，无需手机号。验证码 10 分钟内有效。</p>`:''}<div class="auth-message" id="authMessage" role="status" aria-live="polite"></div><div class="form-actions"><button class="button primary" id="authSubmit" type="submit">${mode==='register'?'免费注册并进入':'登录并继续'} ${icon('arrow')}</button></div></form><p class="fineprint">${mode==='register'?'账号 ID 将自动生成。':''}基础抽取免费不限次；付费不改变抽取结果。</p>`;
  $$('[data-auth]').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.auth;authTouched=false;renderAuth();}));
  $('#authForm').addEventListener('submit',submitAuth);
  if(mode==='register'){
    $('#sendEmailCode').addEventListener('click',sendEmailCode);
    $('#authForm [name="identifier"]').addEventListener('input',()=>{
      emailState.invalidate();$('#authForm [name="email_code"]').value='';updateEmailButton();
      $('#emailHint').textContent='验证邮箱后即可注册，无需手机号。验证码 10 分钟内有效。';
    });
    emailTimer=setInterval(updateEmailButton,1000);updateEmailButton();
  }
  if(mode==='register'&&!registrationOpen){$('#authSubmit').disabled=true;message('当前暂不开放注册，你仍可登录已有账号。');}

}
function passwordPath(){return `/login.html?mode=password&next=${encodeURIComponent(safeNext)}`;}
function message(text,success=false){const node=$('#authMessage');if(!node)return;node.textContent=text;node.classList.toggle('success',success);}
function updateEmailButton(){
  const button=$('#sendEmailCode');if(!button)return;
  const wait=emailState.remaining($('#authForm [name="identifier"]')?.value);
  const unavailable=publicData?.email_verification_ready===false||publicData?.registration_open===false;
  button.disabled=emailState.pending||wait>0||unavailable;
  button.textContent=emailState.pending?'发送中…':wait?`${wait} 秒后重发`:'获取验证码';
  if(unavailable&&publicData?.registration_open!==false)$('#emailHint').textContent='邮箱验证服务暂不可用，请稍后再试。你仍可直接免费体验。';
}
async function sendEmailCode(){
  const form=$('#authForm'),input=form.querySelector('[name="identifier"]'),email=emailKey(input.value);
  if(!email||!input.checkValidity())return message('请输入有效的邮箱地址。');
  const sending=emailState.request(email,address=>api('/api/register/email-code',{email:address}));
  updateEmailButton();message('正在发送验证码…');
  try{
    const active=await sending;
    if(active&&form.isConnected){
      $('#emailHint').textContent='验证码已发送，10 分钟内有效；未收到请检查垃圾邮件。';message('请查收邮箱并填写 6 位验证码。',true);
      form.querySelector('[name="email_code"]').focus();
    }
  }catch(error){if(form.isConnected&&emailKey(input.value)===email)message(error.message||'发送失败，请稍后重试。');}
  finally{updateEmailButton();}
}
async function submitAuth(event){
  event.preventDefault();
  const form=event.currentTarget,button=$('#authSubmit'),data=new FormData(form);
  const identifier=String(data.get('identifier')||'').trim(),password=String(data.get('password')||'');
  if(!identifier)return message('请填写邮箱或账号 ID。');
  if(!password)return message('请输入密码。');
  const registering=mode==='register';
  const payload={password};
  if(registering){
    const email=emailKey(identifier),email_code=String(data.get('email_code')||'').trim();
    if(!form.querySelector('[name="identifier"]').checkValidity())return message('请输入有效的邮箱地址。');
    if(password.length<8)return message('密码至少 8 位。');
    if(!emailState.valid(email))return message('请先获取当前邮箱的验证码，过期后需重新发送。');
    if(!/^[0-9]{6}$/.test(email_code))return message('请填写 6 位邮箱验证码。');
    Object.assign(payload,{email,email_code,challenge_id:emailState.challenge.id});
  }
  let registrationAttempted=false,registrationConfirmed=false;
  button.disabled=true;message(registering?'正在创建账号…':'正在登录…');
  try{
    if(registering){
      if(publicData?.registration_open===false)throw new Error('当前暂不开放注册。');
      await referralPromise;
      registrationAttempted=true;
      const created=await api('/api/register',payload);
      if(created?.success!==true)throw new Error('未能确认注册结果');
      registrationConfirmed=true;
    }
    const login=await api('/api/login',{identifier,password});
    try{
      const {importGuestDrafts}=await import('/v6/draft-storage.mjs');
      importGuestDrafts(localStorage,login.guest_draft_scope,login.draft_scope);
      if(login.draft_scope)localStorage.setItem('clm-session-scope',login.draft_scope);
    }catch{/* Draft migration is optional; authentication remains authoritative. */}
    if(login.must_change_password){location.assign(passwordPath());return;}
    location.assign(safeNext);
  }catch(error){
    if(registrationConfirmed){
      // The account already exists. Retrying must log in, not register again.
      mode='login';authTouched=true;renderAuth();
      const identifierInput=$('#authForm [name="identifier"]');if(identifierInput)identifierInput.value=identifier;
      message(`注册已完成，请使用刚设置的密码登录继续。${error.message||'自动登录暂未完成。'}`);
    }else{
      const uncertain=registrationAttempted&&(!error.status||error.status>=500);
      message(uncertain?'注册结果尚未确认。请先切换到“登录账号”，使用刚填写的邮箱和密码尝试登录；确认账号不存在后再重新注册。':error.message||'操作失败，请稍后重试。');

    }
  }finally{if(button.isConnected)button.disabled=false;}
}
function renderPassword(host){
  $('#authTitle').textContent='修改密码';$('#authLead').textContent='管理员重置的临时密码需要先更换，保存后将退出登录。';
  host.innerHTML=`<form id="passwordForm" novalidate><label class="field">当前密码<input name="current_password" type="password" autocomplete="current-password" required></label><label class="field">新密码（8 至 128 位）<input name="new_password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label><label class="field">再次输入新密码<input name="confirm_password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label><p class="password-help">保存后当前会话会退出，请使用新密码重新登录。</p><div class="auth-message" id="authMessage" role="status" aria-live="polite"></div><div class="form-actions"><button class="button primary" type="submit">保存新密码</button><a class="button" href="${playPath}">返回免费体验</a></div></form>`;
  $('#passwordForm').addEventListener('submit',changePassword);
}
async function changePassword(event){
  event.preventDefault();const form=event.currentTarget,data=new FormData(form),button=form.querySelector('[type="submit"]');
  const current_password=String(data.get('current_password')||''),new_password=String(data.get('new_password')||''),confirm=String(data.get('confirm_password')||'');
  if(new_password.length<8||new_password.length>128)return message('新密码需为 8 至 128 位。');
  if(new_password!==confirm)return message('两次输入的新密码不一致。');
  button.disabled=true;message('正在保存…');
  try{await api('/api/password/change',{current_password,new_password});location.assign(`/login.html?next=${encodeURIComponent(safeNext)}`);}
  catch(error){message(error.message||'修改失败，请稍后重试。');}
  finally{if(button.isConnected)button.disabled=false;}
}
async function loadCurrentUser(){
  if(mode==='password'){
    try{const data=await api('/api/me');currentUser=data.user||null;if(!currentUser)throw new Error();if(!currentUser.must_change_password)$('#authLead').textContent='修改后，当前会话会退出。';}
    catch{message('请先登录，再修改密码。');return;}
    if(!authTouched)renderAuth();return;
  }
  try{const data=await api('/api/me');currentUser=data.user||null;if(currentUser?.must_change_password){location.replace(passwordPath());return;}}
  catch{return;/* A visitor without a session keeps the sign-in form already on screen. */}
  if(currentUser){if(!authTouched)renderAuth();else showSignedInNotice();}
}
function showSignedInNotice(){
  const host=$('#authArea');if(!host||host.querySelector('.auth-session-notice'))return;
  const note=document.createElement('div');note.className='notice auth-session-notice';
  const copy=document.createElement('span');copy.textContent=`当前已登录${currentUser?.custom_id?`：${currentUser.custom_id}`:''}。`;
  const link=document.createElement('a');link.href=safeNext;link.className='text-button';link.textContent='继续玩';
  note.append(copy,link);host.prepend(note);
}
async function signOut(){try{await api('/api/logout',{});currentUser=null;renderAuth();toast('已退出登录');}catch(error){toast(error.message||'退出失败');}}
function showIntro(fromHistory=false){
  showAuthDialog('intro','四种玩法，一样免费。',`<p id="introText">${escapeHTML(publicText('intro_text'))}</p><div class="intro-grid">${Object.entries(scenes).map(([key,scene])=>`<article class="intro-card"><div class="scene-glyph">${icon(scene.icon)}</div><h3>${scene.label}</h3><p id="sceneDescription-${key}">${escapeHTML(sceneDescription(key))}</p><a class="text-button" href="${playPath}?scene=${encodeURIComponent(key)}">免费试试看 ${icon('arrow')}</a></article>`).join('')}</div><p class="fineprint" style="margin:20px 0 0">玩法决定抽什么，机台决定怎么演出。皮肤改变外观，付费不改变结果。</p><div id="introFaq">${faqMarkup()}</div>`,{fromHistory});
}
function showPricing(fromHistory=false){
  const requestId=++productRequestId;
  productsPromise=null;
  showAuthDialog('pricing','免费尽兴，升级随心。',`<p>先免费玩，喜欢再升级。皮肤和功能会员分别购买，不自动续费。</p><div class="prices-grid"><article class="price-card"><span class="tag green">一直免费</span><h3>基础玩法</h3><strong>¥0</strong><p id="freeDescription">${escapeHTML(publicText('free_description'))}</p><a class="button" href="${playPath}">现在就玩 ${icon('arrow')}</a></article><article class="price-card featured"><span class="tag purple">给机台换个风格</span><h3 id="cosmicName">星空主题皮肤</h3><strong id="cosmicPrice">读取价格中…</strong><p id="cosmicDescription">${escapeHTML(publicText('skin_description'))}</p><p id="cosmicStatus" class="fineprint">正在读取商品状态…</p><a class="button primary" href="${playPath}?skin=cosmic">免费预览 ${icon('spark')}</a></article><article class="price-card"><span class="tag">适合课堂与年会</span><h3 id="proName">专业功能会员</h3><strong id="proPrice">读取价格中…</strong><p id="proDescription">${escapeHTML(publicText('pro_description'))}</p><p id="proStatus" class="fineprint">正在读取商品状态…</p><a class="button" href="${playPath}#shop">了解权益 ${icon('arrow')}</a></article></div><div id="pricingNotice" class="notice" style="margin-top:20px">${escapeHTML(publicText('notice','线上商品为 365 天固定期限，不自动续费。购买状态与实际价格以账号和服务端商品信息为准。'))}</div><div id="pricingFaq">${faqMarkup()}</div>`,{fromHistory});
  loadProducts(requestId);
}
async function loadProducts(requestId){
  let request;
  try{
    request=productsPromise||(productsPromise=api('/api/v6/shop'));
    const data=await request;
    if(requestId!==productRequestId)return;
    const list=Array.isArray(data.products)?data.products:[];
    for(const [slug,prefix] of [['cosmic','cosmic'],['pro','pro']]){
      const product=list.find(item=>item.slug===slug),price=$(`#${prefix}Price`),status=$(`#${prefix}Status`),name=$(`#${prefix}Name`);
      if(!price)continue;
      if(!product){price.textContent='商品信息暂不可用';status.textContent='请稍后再查看商品价格与状态。';continue;}
      name.textContent=product.name||name.textContent;
      price.textContent=product.price_cents==null?'价格暂不可用':`${money(product.price_cents)} / ${Number(product.days)||365} 天`;
      status.textContent=product.owned?'当前账号已拥有此权益。':product.sale_enabled?'可在线购买；不自动续费。':'当前未开放在线购买。';
    }
    const grid=$('.prices-grid');
    if(grid){for(const product of list.filter(p=>!['cosmic','pro'].includes(p.slug))){
      const card=document.createElement('article');card.className='price-card';
      const heading=document.createElement('h3');heading.textContent=product.name;
      const price=document.createElement('strong');price.textContent=`${money(product.price_cents)} / ${product.days} 天`;
      const description=document.createElement('p');description.textContent=product.description;
      const link=document.createElement('a');link.className='button';link.textContent='查看兼容机台与体验';link.href=playPath+'#shop';
      card.append(heading,price,description,link);grid.append(card);
    }}

  }catch{
    if(requestId!==productRequestId)return;
    for(const slug of ['cosmic','pro']){const price=$(`#${slug}Price`),status=$(`#${slug}Status`);if(price){price.textContent='价格暂不可用';status.textContent='商品状态暂不可用，请稍后重试。';}}
  }finally{
    if(request&&productsPromise===request)productsPromise=null;
  }
}
async function loadPublic(){
  try{
    publicData=await api('/api/v7/public');
    const content=publicData.content||{};
    if(typeof content.hero_machine==='string')setHeroMachine(content.hero_machine);
    if(typeof content.hero_title==='string'&&content.hero_title.trim()){
      heroTitleOverride=content.hero_title.trim();setHeroTitle(heroTitleOverride);
    }else heroTitleOverride='';
    if(typeof content.hero_text==='string'&&content.hero_text.trim())$('#heroText').textContent=content.hero_text;
    if(typeof content.cta==='string'&&content.cta.trim())$('#heroCta').firstChild.textContent=content.cta;
    const notice=$('#publicNotice');
    const notices=[publicData.maintenance?.enabled?publicData.maintenance.message:'',content.notice].filter(value=>typeof value==='string'&&value.trim());
    notice.textContent=notices.join(' ');notice.hidden=!notices.length;
    refreshOpenPublicCopy();
  }catch{/* Auth and play remain available while optional public copy is unavailable. */}
  updateEmailButton();
  if(mode!=='password'&&!currentUser&&publicData?.registration_open===false){
    const registerTab=$('[data-auth="register"]');if(registerTab)registerTab.hidden=true;
    if(mode==='register'){
      const button=$('#authSubmit');if(button)button.disabled=true;
      message('当前暂不开放注册，你仍可登录已有账号。');
    }
  }
}
async function recordReferral(){
  if(!inviteCode)return;
  try{
    const result=await api('/api/v7/referrals/visit',{code:inviteCode});
    referralData=result;
    const campaign=result.campaign,box=$('#inviteArrival');
    if(!box||!campaign||!result.attributed)return;
    const proDays=validDays(campaign.pro_days),skinDays=validDays(campaign.skin_days);
    const rewards=[];
    if(proDays)rewards.push(`专业功能 ${proDays} 天`);
    if(campaign.skin_feature&&skinDays)rewards.push(`指定皮肤 ${skinDays} 天`);
    const benefit=rewards.length?`${rewards.join('、')}`:'本次活动无可展示的权益';
    box.replaceChildren();
    const summary=document.createElement('span');
    summary.textContent=`好友邀请活动「${campaign.name||'好友邀请'}」：${campaign.reward_newcomer?'邀请人和新用户各可获得':'仅邀请人可获得'} ${benefit}。${campaign.require_experience?'新用户还需完成一次正式体验。':''}`;
    const rules=document.createElement('button');rules.type='button';rules.className='text-button';rules.textContent='查看本次活动规则';
    rules.addEventListener('click',()=>showReferralRules(campaign));
    box.append(summary,rules);
    box.hidden=false;
  }catch{/* Invalid or expired links do not change login behavior. */}
}
function validDays(value){const number=Number(value);return Number.isFinite(number)&&number>0?Math.floor(number):0;}
function campaignDate(value){return value==null?'未设定':new Date(Number(value)*1000).toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'short'});}
function showReferralRules(campaign,fromHistory=false){
  const proDays=validDays(campaign.pro_days),skinDays=validDays(campaign.skin_days);
  const rewards=[];
  if(proDays)rewards.push(`专业功能会员 ${proDays} 天`);
  if(campaign.skin_feature&&skinDays)rewards.push(`指定皮肤「${campaign.skin_feature}」${skinDays} 天`);
  const rewardText=rewards.length?rewards.join('，'):'当前活动没有配置可发放权益';
  const audience=campaign.reward_newcomer?'邀请人与新用户各自获得一份':'仅邀请人获得奖励';
  const experience=campaign.require_experience
    ?'新用户须在注册后完成一次正式抽取才符合发奖条件；预演不计入。'
    :'注册后无需先完成抽取即可符合发奖条件。';
  const attributionDays=validDays(campaign.attribution_days);
  const windowText=attributionDays
    ?`新账号须在首次有效访问后 ${attributionDays} 天内完成注册；若活动先结束，则以活动结束时间为准。实际到期时刻由服务端记录。`
    :'归因时限由服务端活动规则确定。';
  const start=campaign.starts_at==null?'立即生效':campaignDate(campaign.starts_at);
  const end=campaign.ends_at==null?'未设固定结束时间':campaignDate(campaign.ends_at);
  const cap=validDays(campaign.monthly_cap);
  const content=`<p><b>${escapeHTML(campaign.name||'好友邀请活动')}</b> · 规则版本 ${escapeHTML(campaign.version??'—')}</p>
    <div class="intro-card"><h3>奖励给谁、奖励什么</h3><p>${escapeHTML(audience)}：${escapeHTML(rewardText)}。邀请人每个自然月（中国时区）最多获得 ${cap||'—'} 次奖励。</p></div>
    <div class="intro-card" style="margin-top:12px"><h3>获得奖励的条件</h3><p>需通过此邀请归因注册新账号，邀请人与新账号均须保持正常状态。${escapeHTML(experience)}每月奖励达到上限后，当月后续邀请不再发奖。</p></div>
    <div class="intro-card" style="margin-top:12px"><h3>活动时间与归因</h3><p>活动时间：${escapeHTML(start)} 至 ${escapeHTML(end)}。${escapeHTML(windowText)}首次有效邀请归因优先，仍有效的归因不会被其他邀请链接替换。</p></div>
    <p class="fineprint" style="margin:16px 0 0">资格、归因和奖励发放由服务端按此活动版本核验。</p>`;
  showAuthDialog('invite-rules','好友邀请活动规则',content,{fromHistory});
}
const referralPromise=recordReferral();
function bindActions(){
  $$('[data-hero-machine]').forEach(button=>button.addEventListener('click',()=>setHeroMachine(button.dataset.heroMachine)));
  document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;if(button.dataset.action==='intro')showIntro();if(button.dataset.action==='pricing')showPricing();});
}
async function initStage(){
  try{
    const {createStage}=await import('/v6/stage.js?v=ui-polish-20261007');
    stage=createStage($('#sceneMount'),()=>{},()=>{},false);
    stage.quality('high');stage.configure(machineConfig());
    $('#sceneMount .stage-fallback')?.remove();
  }catch(error){
    const note=$('#sceneMount .stage-fallback p');if(note)note.textContent='3D 机台暂时无法显示。你仍可继续免费体验或查看产品介绍。';
    console.error('V7 login capsule scene failed to initialize',error);
  }
  window.addEventListener('pagehide',()=>stage?.dispose(),{once:true});
}

$('#app').innerHTML=loginMarkup();addOverlayShell();bindActions();setHeroTitle('让选择，值得期待。');renderAuth();
const feedback=createFeedback();const feedbackLink=document.createElement('button');feedbackLink.type='button';feedbackLink.className='feedback-link';feedbackLink.textContent='问题与建议';feedbackLink.onclick=()=>feedback.open();document.querySelector('.page-footer').append(feedbackLink);
$('#authArea').addEventListener('input',()=>{authTouched=true;});
initAuthDialogHistory();
loadCurrentUser();loadPublic();
initStage();
