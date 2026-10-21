export const feedbackStatuses={new:'待处理',reviewing:'跟进中',planned:'已采纳',resolved:'已解决',closed:'已关闭'};
export const feedbackCategories={bug:'遇到问题',suggestion:'优化建议',other:'其他反馈'};
export function feedbackContext(input={}){
  const choose=(value,allowed,fallback='')=>allowed.includes(value)?value:fallback;
  const size=value=>Number.isFinite(value)?Math.max(0,Math.min(10000,Math.round(value))):0;
  return {page:choose(input.page,['login','play'],'play'),app:choose(input.app,['food','play','prize','person']),machine:choose(input.machine,['wheel','capsule','sphere']),theme:choose(input.theme,['classic','cosmic']),width:size(input.width),height:size(input.height)};
}
// Retries keep the same ID. Editing content produces a new request, while an
// identity change discards the former viewer's unsent text and request token.
export class FeedbackDraft {
  constructor(makeId=()=>crypto.randomUUID()){this.makeId=makeId;this.reset();}
  reset(){this.value={category:'suggestion',content:'',contact_email:'',attach:true};this.fingerprint='';this.id='';}
  bind(scope){if(this.scope!==scope){this.reset();this.scope=scope;}}
  request(context){const {attach,...value}=this.value;const payload={...value,content:value.content.trim(),contact_email:value.contact_email.trim(),context:attach?feedbackContext(context):null};const fingerprint=JSON.stringify(payload);if(fingerprint!==this.fingerprint){this.fingerprint=fingerprint;this.id=this.makeId();}return {...payload,request_id:this.id};}
}
