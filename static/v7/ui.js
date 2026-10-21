export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

const shapes = {
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  capsule:'<path d="m8 4-4 4a7 7 0 0 0 10 10l4-4A7 7 0 0 0 8 4Z"/><path d="m6 6 12 12M10 4c3-2 7 1 7 3"/>',
  spark:'<path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z"/>',
  food:'<path d="M4 11h16c0 5-3 8-8 8s-8-3-8-8Zm3 9h10M8 3v5m4-5v5m4-5v5"/>',
  play:'<path d="m8 7-4 3-1 6c-.6 4 2 5 4 2l2-2h6l2 2c2 3 4.6 2 4-2l-1-6-4-3Z"/><path d="M7 10v4m-2-2h4m7-1h.1M18 13h.1"/>',
  gift:'<path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13"/><path d="M12 8C4 8 5 1 9 3c2 1 3 5 3 5Zm0 0c8 0 7-7 3-5-2 1-3 5-3 5Z"/>',
  person:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  sphere:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6c4 3 10 3 14 0M5 18c4-3 10-3 14 0"/>',
  wheel:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7m7-5-6 6m8 1h-7m5 7-6-6m-1 8v-7m-7 5 6-6m-8-1h7M5 5l6 6"/>',
  fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  settings:'<path d="M3 6h5m4 0h9M3 12h11m4 0h3M3 18h2m4 0h12"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-5v6l4 3"/>',
  folder:'<path d="M3 7V4h7l2 3h9v13H3Z"/>',
  crown:'<path d="m3 6 4 5 5-7 5 7 4-5-2 14H5Z"/>',
  card:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
  chart:'<path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-8"/>',
  users:'<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5v1"/>',
  bag:'<path d="M4 7h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2"/>',
  order:'<path d="M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 7h8M8 11h8M8 15h4"/>',
  shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Zm-4 9 3 3 5-6"/>',
  link:'<path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M7 10l-2 2a5 5 0 0 0 7 7l2-2M8 16l8-8"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  check:'<path d="m5 12 5 5L20 7"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  bell:'<path d="M5 16V9a7 7 0 0 1 14 0v7l2 3H3ZM9 21h6"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  logout:'<path d="M10 3H3v18h7m-2-9h13m-5-5 5 5-5 5"/>',
  edit:'<path d="m14 4 6 6M4 20l5-1L21 7l-5-5L4 14ZM3 22h18"/>',
  sound:'<path d="M4 9h4l5-5v16l-5-5H4ZM17 8c3 2 3 6 0 8m3-11c4 4 4 10 0 14"/>',
};
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${shapes[name] || shapes.spark}</svg>`;
export const brand = (target='/login.html') => `<a class="brand" href="${target}" aria-label="抽了马"><span class="brand-mark">${icon('capsule')}</span><span>抽了马<small>让选择，值得期待</small></span></a>`;
export function footer(){return '<footer class="page-footer"><span>免费玩，把纠结交给好运。</span><span>基础机台永久免费 · 付费不改变抽取概率</span></footer>';}
export function addOverlayShell(){
  document.body.insertAdjacentHTML('beforeend',`<dialog id="dialog" aria-labelledby="dialogTitle"><div class="dialog-header"><h2 id="dialogTitle"></h2><button class="icon-button" id="dialogClose" aria-label="关闭面板">${icon('close')}</button></div><div id="dialogBody" class="dialog-body"></div></dialog><div id="toast" class="toast" role="status" hidden></div>`);
  $('#dialogClose').addEventListener('click',closeDialog);
  $('#dialog').addEventListener('click',event=>{if(event.target===event.currentTarget){const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeDialog();}});
}
export function closeDialog(){ $('#dialog')?.close(); }
export function openDialog(title,html,drawer=false){
  const dialog=$('#dialog');
  $('#dialogTitle').textContent=title;
  $('#dialogBody').innerHTML=html;
  dialog.classList.toggle('drawer',drawer);
  if(!dialog.open)dialog.showModal();
  dialog.scrollTop=0;
  $('#dialogClose').focus({preventScroll:true});
}
let toastTimer;
export function toast(message){
  const node=$('#toast');
  if(!node)return;
  // A modal's top layer would otherwise cover a body-level notification.
  const parent=$('#dialog')?.open?$('#dialog'):document.fullscreenElement||document.body;
  parent.appendChild(node);node.textContent=message;node.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{node.hidden=true;document.body.appendChild(node);},4000);
}

export async function api(path, body=undefined, method=body===undefined?'GET':'POST') {
  const response=await fetch(path,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const detail=Array.isArray(data.detail)?data.detail.map(item=>item.msg).join('；'):data.detail;const error=new Error(data.error||detail||'请求失败，请稍后重试');error.status=response.status;error.data=data;throw error;}
  return data;
}
export function guard(work){return Promise.resolve().then(work).catch(error=>toast(error.message||'操作失败'));}
export async function copyText(value){try{await navigator.clipboard.writeText(value);toast('已复制');}catch{toast('浏览器不允许自动复制，请选择内容手动复制。');}}
export const money=cents=>'¥'+(Number(cents)/100).toFixed(2);
export const dateTime=value=>value?new Date(typeof value==='number'?value*1000:value).toLocaleString('zh-CN'):'—';
