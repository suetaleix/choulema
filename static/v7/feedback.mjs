import {api,escapeHTML,dateTime} from './ui.js';
import {FeedbackDraft,feedbackStatuses,feedbackCategories} from './feedback-state.mjs';

const esc=value=>escapeHTML(String(value??''));
export const feedbackBadge=status=>`<span class="feedback-badge feedback-${esc(status)}">${esc(feedbackStatuses[status]||status)}</span>`;
export function feedbackReplies(ticket,admin=false){return (ticket.replies||[]).map(item=>`<div class="feedback-reply">${feedbackBadge(item.status)} <small>${esc(dateTime(item.created_at))}</small>${item.reply?`<p class="feedback-copy">${esc(item.reply)}</p>`:''}${admin&&item.internal_note?`<p class="feedback-internal">内部备注：${esc(item.internal_note)}</p>`:''}</div>`).join('');}
export function feedbackContextText(context){const names={food:'抽吃什么',play:'抽玩什么',prize:'抽奖品',person:'抽点名',wheel:'转盘',capsule:'胶囊机',sphere:'姓名星球',classic:'默认主题',cosmic:'星空主题'};return [context.page==='login'?'登录介绍页':context.page==='play'?'玩法页':'',names[context.app],names[context.machine],names[context.theme],context.width&&context.height?`${context.width} × ${context.height}`:''].filter(Boolean).join(' · ');}

export function createFeedback({context=()=>({page:'login',width:innerWidth,height:innerHeight})}={}){
  let dialog,body,nav,error,view='write',page=1,loaded=null,pending=false,revision=0;
  const draft=new FeedbackDraft();
  const note=message=>{error.textContent=message;error.hidden=!message;};
  function shell(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.id='feedbackDialog';dialog.className='feedback-dialog';
    dialog.setAttribute('aria-labelledby','feedbackTitle');
    dialog.innerHTML='<header class="feedback-header"><div><span class="feedback-eyebrow">一起把体验变得更好</span><h2 id="feedbackTitle">问题与建议</h2></div><button type="button" data-close aria-label="关闭反馈">×</button></header><nav class="feedback-tabs" aria-label="反馈内容"><button type="button" data-view="write">写反馈</button><button type="button" data-view="mine">我的反馈</button></nav><p class="feedback-error" role="status" hidden></p><div class="feedback-body"></div>';
    document.body.append(dialog);body=dialog.querySelector('.feedback-body');nav=dialog.querySelector('nav');error=dialog.querySelector('[role=status]');
    dialog.querySelector('[data-close]').onclick=()=>{if(!pending)dialog.close();};
    dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
    dialog.addEventListener('close',()=>{revision++;});
    nav.onclick=event=>{const button=event.target.closest('[data-view]');if(!button||pending)return;view=button.dataset.view;note('');if(view==='mine')load();else render();};
  }
  function lock(value){pending=value;dialog.querySelector('[data-close]').disabled=value;nav.querySelectorAll('button').forEach(button=>button.disabled=value);const fields=body.querySelector('fieldset');if(fields)fields.disabled=value;}
  async function load(){
    const token=++revision;body.innerHTML='<p class="feedback-empty" role="status">正在读取你的反馈…</p>';note('');
    try{const result=await api(`/api/v7/feedback?page=${page}`);if(token!==revision||!dialog.open)return;draft.bind(result.scope);loaded=result;page=result.page;render();}
    catch(e){if(token!==revision||!dialog.open)return;loaded=null;body.innerHTML='<p class="feedback-empty">暂时无法读取反馈。</p><button type="button" class="feedback-primary" data-retry>重新读取</button>';body.querySelector('[data-retry]').onclick=load;note(e.message);}
  }
  function render(){
    nav.querySelectorAll('[data-view]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.view===view));});
    if(!loaded)return load();
    if(view==='write'){
      body.innerHTML=`<p class="feedback-lead">哪里不顺手，或者你想要什么新玩法？告诉我们。</p><form><fieldset><label>反馈类型<select name="category">${Object.entries(feedbackCategories).map(([key,label])=>`<option value="${key}" ${draft.value.category===key?'selected':''}>${label}</option>`).join('')}</select></label><label>反馈内容<textarea name="content" rows="5" minlength="5" maxlength="2000" required placeholder="例如：手机横屏时，候选设置的保存按钮被挡住了。">${esc(draft.value.content)}</textarea><small>5–2000 字。请不要填写密码、验证码或抽取名单。</small></label><label>联系邮箱 <small>选填</small><input name="contact_email" type="email" maxlength="254" autocomplete="email" value="${esc(draft.value.contact_email)}" placeholder="方便必要时进一步了解问题"></label><label class="feedback-check"><input name="attach" type="checkbox" ${draft.value.attach?'checked':''}><span>附上当前玩法、机台、主题和屏幕尺寸<small>不包含候选名单、中奖结果或完整网址。</small></span></label><div class="feedback-actions"><small>${loaded.guest?'游客可直接反馈；请保留此浏览器的数据，登录后可归入账号。':'提交后可在「我的反馈」查看处理进度和回复。'}<br>回复展示在这里，不会自动发送邮件。</small><button type="submit" class="feedback-primary">提交反馈 ↗</button></div></fieldset></form>`;
      const form=body.querySelector('form');const remember=()=>{const data=new FormData(form);draft.value={category:String(data.get('category')||'suggestion'),content:String(data.get('content')||''),contact_email:String(data.get('contact_email')||''),attach:data.has('attach')};};
      form.addEventListener('input',remember);form.addEventListener('change',remember);
      form.onsubmit=async event=>{event.preventDefault();if(pending)return;remember();const payload={...draft.request(context()),scope:loaded.scope};note('');lock(true);const button=form.querySelector('[type=submit]');button.textContent='正在提交…';
        try{const result=await api('/api/v7/feedback',payload);draft.reset();view='mine';page=1;lock(false);await load();if(dialog.open)note(`反馈已收到，编号 ${result.feedback.id}。可在这里查看回复。`);}
        catch(e){note(`${e.message}。填写的内容已保留，可按原内容重试。`);lock(false);button.textContent='重试提交 ↗';}
      };
    }else{
      body.innerHTML=`<div class="feedback-list-top"><p>${loaded.guest?'当前浏览器提交的反馈':'你的反馈与处理进度'} · 共 ${loaded.total} 条</p><button type="button" data-refresh>刷新</button></div>${loaded.items.length?loaded.items.map(ticket=>`<details class="feedback-ticket"><summary><span>${feedbackBadge(ticket.status)} <small>${esc(feedbackCategories[ticket.category])}</small><b>${esc(ticket.content.slice(0,80))}${ticket.content.length>80?'…':''}</b><small>${esc(dateTime(ticket.created_at))} · 查看详情与回复</small></span><span aria-hidden="true">＋</span></summary><div class="feedback-ticket-body"><p class="feedback-copy">${esc(ticket.content)}</p><small>编号 ${esc(ticket.id)}</small>${ticket.context?.page?`<p class="feedback-meta">${esc(feedbackContextText(ticket.context))}</p>`:''}${ticket.replies.length?feedbackReplies(ticket):'<p class="feedback-meta">已进入反馈收件箱，处理后会在这里显示。</p>'}</div></details>`).join(''):'<div class="feedback-empty"><b>还没有反馈</b><p>遇到问题或想到好点子，都可以告诉我们。</p><button type="button" data-write class="feedback-primary">写第一条反馈</button></div>'}<div class="feedback-pager"><button type="button" data-prev ${page<=1?'disabled':''}>上一页</button><span>${page} / ${loaded.pages}</span><button type="button" data-next ${page>=loaded.pages?'disabled':''}>下一页</button></div>`;
      body.querySelector('[data-refresh]').onclick=load;
      body.querySelector('[data-prev]').onclick=()=>{page--;load();};body.querySelector('[data-next]').onclick=()=>{page++;load();};
      const write=body.querySelector('[data-write]');if(write)write.onclick=()=>{view='write';render();};
    }
  }
  return {open(){shell();if(dialog.open)return;loaded=null;dialog.showModal();load();}};
}
