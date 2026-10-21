import {api,escapeHTML,dateTime} from './ui.js';
import {feedbackStatuses,feedbackCategories} from './feedback-state.mjs';
import {feedbackBadge,feedbackReplies,feedbackContextText} from './feedback.mjs';

const esc=value=>escapeHTML(String(value??''));
let dialogRevision=0;
export async function openAdminFeedback(id,onSaved=()=>{}){
  let dialog=document.querySelector('#feedbackAdminDialog');
  if(dialog?.open)return;
  const revision=++dialogRevision;let loadRevision=0;
  if(!dialog){dialog=document.createElement('dialog');dialog.id='feedbackAdminDialog';dialog.className='feedback-dialog';dialog.setAttribute('aria-labelledby','feedbackAdminTitle');document.body.append(dialog);}
  let pending=false,changed=false;
  dialog.innerHTML='<header class="feedback-header"><div><span class="feedback-eyebrow">倾听用户 · 持续改进</span><h2 id="feedbackAdminTitle">处理用户反馈</h2></div><button type="button" data-close aria-label="关闭反馈详情">×</button></header><p class="feedback-error" role="status" hidden></p><div class="feedback-body"><p>正在读取反馈…</p></div>';
  const body=dialog.querySelector('.feedback-body'),error=dialog.querySelector('[role=status]'),close=dialog.querySelector('[data-close]');
  const canClose=()=>!pending&&(!changed||confirm('还有未保存的回复，确定放弃吗？'));
  close.onclick=()=>{if(canClose())dialog.close();};dialog.oncancel=event=>{if(!canClose())event.preventDefault();};
  dialog.showModal();
  function message(text){error.textContent=text;error.hidden=!text;}
  async function load(){
    const token=++loadRevision;
    try{
      const {feedback:t}=await api(`/api/v7/admin/feedback/${encodeURIComponent(id)}`);if(!dialog.open||revision!==dialogRevision||token!==loadRevision)return;
      body.innerHTML=`<p>${feedbackBadge(t.status)} · ${esc(feedbackCategories[t.category])}</p><p class="feedback-copy">${esc(t.content)}</p><p class="feedback-meta">${esc(t.account)} · ${esc(dateTime(t.created_at))}<br>编号 ${esc(t.id)}<br>联系邮箱：${esc(t.contact_email||'未填写')}<br>${esc(feedbackContextText(t.context||{}))}</p>${feedbackReplies(t,true)}<form><fieldset><label>处理状态<select name="status">${Object.entries(feedbackStatuses).map(([key,label])=>`<option value="${key}" ${key===t.status?'selected':''}>${label}</option>`).join('')}</select></label><label>给用户的回复<textarea name="reply" maxlength="2000" rows="3" placeholder="说明处理进度、改进计划或解决方法。"></textarea><small>解决或关闭时必填；回复会显示在用户的「我的反馈」中。</small></label><label>内部备注 <small>仅超管可见</small><textarea name="internal_note" maxlength="1000" rows="2" placeholder="复现步骤、优先级、计划版本…"></textarea></label><div class="feedback-actions"><small>保存后保留处理记录。已采纳仅代表进入规划，尚未发布。</small><button type="submit" class="feedback-primary">保存处理</button></div></fieldset></form>`;
      const form=body.querySelector('form'),select=form.querySelector('select'),reply=form.querySelector('[name=reply]');
      const sync=()=>{reply.required=['resolved','closed'].includes(select.value);};sync();form.oninput=()=>{changed=true;sync();};form.onchange=()=>{changed=true;sync();};
      form.onsubmit=async event=>{event.preventDefault();if(pending)return;const data=Object.fromEntries(new FormData(form));pending=true;close.disabled=true;form.querySelector('fieldset').disabled=true;message('');
        try{await api(`/api/v7/admin/feedback/${encodeURIComponent(id)}`,{...data,revision:t.revision},'PUT');changed=false;pending=false;close.disabled=false;await load();message('处理结果已保存。');onSaved();}
        catch(e){pending=false;close.disabled=false;form.querySelector('fieldset').disabled=false;message(e.status===409?e.message+'；请保留草稿后重新读取。':e.message+'。如果请求结果未知，请先重新读取确认。');if(!body.querySelector('[data-reload]')){const button=document.createElement('button');button.type='button';button.dataset.reload='';button.textContent='重新读取最新记录';button.onclick=()=>{if(changed&&!confirm('重新读取会清空未保存的回复，是否继续？'))return;changed=false;message('');load();};body.append(button);}}
      };
    }catch(e){if(!dialog.open||revision!==dialogRevision||token!==loadRevision)return;message(e.message);body.innerHTML='<button type="button" data-reload>重新读取</button>';body.querySelector('button').onclick=load;}
  }
  await load();
}
