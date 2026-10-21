/* V6 commerce controls. No mock counts or raw card codes are persisted in the page. */
(()=>{
  const $=id=>document.getElementById(id);
  const node=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
  async function request(path,body){const r=await fetch('/api/v6'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||data.detail||'操作失败');return data;}
  const money=cents=>'¥'+(cents/100).toFixed(2);
  let lastExport=null;
  async function products(){
    const area=$('v6Products');try{const data=await request('/admin/products');area.replaceChildren();for(const product of data.products){
      const row=node('div');row.className='commerce-product';const title=node('strong',product.name);title.append(node('small',` · ${product.days} 天 · 版本 ${product.price_version}`));
      const price=node('input');price.type='number';price.min='0.01';price.max='10000';price.step='0.01';price.value=(product.price_cents/100).toFixed(2);price.setAttribute('aria-label',product.name+'价格，元');
      const sale=node('label');const visible=node('input');visible.type='checkbox';visible.checked=product.sale_visible;visible.style.width='auto';sale.append(visible,node('span',' 展示销售'));
      const reason=node('input');reason.placeholder='本次调整原因';reason.maxLength=200;reason.setAttribute('aria-label',product.name+'调整原因');
      const save=node('button','保存');save.className='b-secondary';save.onclick=async()=>{const amount=Math.round(Number(price.value)*100);save.disabled=true;
        try{const result=await request('/admin/products/'+product.slug,{price_cents:amount,sale_visible:visible.checked,reason:reason.value});
          alert(`${product.name}已保存为版本 ${result.price_version}。支付通道是否开放仍由服务端决定。`);await products();await audit();
        }catch(error){alert(error.message);}finally{save.disabled=false;}};
      const actions=node('div');actions.style.cssText='display:flex;gap:6px;flex-wrap:wrap';
      const history=node('button','历史');history.className='b-secondary';history.onclick=async()=>{try{const data=await request('/admin/products/'+product.slug+'/history');
        const dialog=node('dialog');dialog.style.cssText='border:1px solid var(--b-line);border-radius:18px;background:var(--b-paper);padding:24px;width:min(94vw,560px)';dialog.append(node('h2',product.name+' · 价格版本'));
        for(const item of data.versions)dialog.append(node('p',`版本 ${item.version} · ${money(item.price_cents)} · ${item.sale_visible?'展示销售':'停止销售'} · ${item.reason} · ${new Date(item.created_at*1000).toLocaleString('zh-CN')}`));
        const close=node('button','关闭');close.className='b-secondary';close.onclick=()=>dialog.close();dialog.append(close);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
      }catch(error){alert(error.message);}};actions.append(save,history);
      row.append(title,price,sale,reason,actions);area.append(row);
    }}catch(error){area.textContent=error.message;}
  }
  const form=$('cardForm');form.elements.term.onchange=()=>{$('customDaysWrap').hidden=form.elements.term.value!=='custom';};
  form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;$('cardMessage').textContent='正在生成…';
    try{const term=form.elements.term.value;const date=form.elements.deadline.value;
      const deadline=date?Math.floor(new Date(date+'T23:59:59').getTime()/1000):null;
      const data=await request('/admin/card-batches',{feature:form.elements.feature.value,days:term==='custom'?Number(form.elements.days.value):Number(term),
        quantity:Number(form.elements.quantity.value),label:form.elements.label.value.trim(),purpose:form.elements.purpose.value.trim(),redeem_deadline:deadline});
      lastExport={id:data.batch_id,codes:data.codes,feature:data.feature,days:data.days};
      $('cardCodes').value=data.codes.join('\n');$('cardExport').hidden=false;
      $('cardMessage').textContent=`已生成 ${data.quantity} 张。完整卡密只在这里显示一次，关闭或刷新后不能重新导出。`;
      await batches();await overview();await audit();
    }catch(error){$('cardMessage').textContent=error.message;}finally{button.disabled=false;}
  };
  $('downloadCards').onclick=()=>{if(!lastExport)return;
    const csv='\ufeff批次,权益,使用天数,卡密\r\n'+lastExport.codes.map(code=>[lastExport.id,lastExport.feature,lastExport.days,code].join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),link=node('a');link.href=URL.createObjectURL(blob);link.download='choulema-cards-'+lastExport.id+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  };
  async function batches(){const area=$('cardBatches');try{const data=await request('/admin/card-batches');area.replaceChildren();
    if(!data.batches.length){area.textContent='暂无批次';return;}
    for(const batch of data.batches){const row=node('div');row.style.cssText='display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px;border-bottom:1px solid var(--b-line)';
      const text=node('span',`${batch.label} · ${batch.feature==='pro'?'专业功能会员':'星空胶囊皮肤'} · ${batch.days} 天 · 未用 ${batch.issued} / 已兑 ${batch.redeemed} / 过期 ${batch.expired} / 作废 ${batch.voided}`);
      const view=node('button','查看卡片');view.className='b-secondary';view.onclick=()=>cards(batch);row.append(text,view);area.append(row);
    }
  }catch(error){area.textContent=error.message;}}
  async function cards(batch){const area=$('cardDetails');area.replaceChildren(node('h3',batch.label+' · 卡片状态'));
    try{const data=await request('/admin/card-batches/'+batch.id+'/cards');for(const card of data.cards){const row=node('div');row.style.cssText='display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px;border-bottom:1px solid var(--b-line)';
      row.append(node('span',`尾号 ${card.suffix} · ${{issued:'未兑换',redeemed:'已兑换',expired:'已过期',void:'已作废'}[card.state]}${card.redeemed_owner?' · '+card.redeemed_owner:''}`));
      if(card.state==='issued'){const voidButton=node('button','作废');voidButton.className='act danger';voidButton.onclick=async()=>{const reason=prompt('请输入作废原因（至少 2 字）');if(reason===null)return;try{await request('/admin/cards/'+card.id+'/void',{reason});await batches();await cards(batch);await overview();await audit();}catch(error){alert(error.message);}};row.append(voidButton);}
      area.append(row);}
    }catch(error){area.append(node('p',error.message));}}
  async function overview(){const area=$('v6Overview');try{const data=await request('/admin/overview');area.replaceChildren();
    const metrics=[['注册账号',data.accounts],['正常账号',data.active_accounts],['停用／封禁',data.disabled_accounts],
      ['有效专业会员',data.pro_accounts],['有效星空皮肤',data.cosmic_accounts],['支付宝已付订单',data.alipay_paid_orders],
      ['已确认支付额',money(data.alipay_paid_cents)],['已记录退款',money(data.alipay_refund_cents)],
      ['扣除已记录退款',money(data.alipay_net_cents)],['退款待复核订单',data.refund_review_orders],
      ['已付未开通',data.order_issues.missing_grant],['已付权益被撤销',data.order_issues.revoked_grant],
      ['今日确认支付',money(data.alipay_paid_today_cents)],
      ['卡密未兑／已兑',`${data.cards_issued} / ${data.cards_redeemed}`]];
    for(const [label,value] of metrics){const card=node('div');card.className='kpi';const l=node('div',label);l.className='l';const n=node('div',value);n.className='n';card.append(l,n);area.append(card);}
  }catch(error){area.textContent=error.message;}}
  const orderFilters=$('orderFilters');let orderPage=1,orderLoad=0;
  orderFilters.onsubmit=event=>{event.preventDefault();orderPage=1;orders();};
  $('orderReset').onclick=()=>{orderFilters.reset();orderPage=1;orders();};
  async function orders(){const area=$('v6Orders'),pager=$('orderPager'),load=++orderLoad;
    const params=new URLSearchParams({page:String(orderPage),page_size:'20'});
    for(const key of ['q','slug','state','provider','channel','issue']){const value=orderFilters.elements.namedItem(key).value.trim();if(value)params.set(key,value);}
    for(const [field,param,suffix] of [['from','from_ts','T00:00:00'],['to','to_ts','T23:59:59']]){
      const value=orderFilters.elements.namedItem(field).value;if(value)params.set(param,String(Math.floor(new Date(value+suffix).getTime()/1000)));
    }
    area.textContent='正在读取订单…';pager.replaceChildren();
    try{const data=await request('/admin/orders?'+params.toString());if(load!==orderLoad)return;area.replaceChildren();orderPage=data.page;
      if(!data.orders.length){area.textContent='没有符合条件的订单';}
      else{const table=node('table');table.className='tbl';const head=node('thead');const titles=node('tr');
        for(const value of ['订单号','账号','商品','应付','状态','待处理','已记录退款','来源／方式','交易号','创建时间','付款时间','核对'])titles.append(node('th',value));head.append(titles);table.append(head);
        const body=node('tbody');for(const item of data.orders){const row=node('tr');const status=item.refund_state==='partial_review'?'部分退款待复核':({pending:'待支付',paid:'已支付',refunded:'已全额退款',closed:'已关闭',legacy_unavailable:'历史渠道待核对'}[item.state]||item.state);
          const issueNames={missing_grant:'已付未开通',revoked_grant:'已付权益被撤销',refund_review:'部分退款待复核'};
          [item.order_no,item.owner,item.name,money(item.amount),status,item.issues.map(key=>issueNames[key]||key).join('、')||'—',money(item.refund_cents),item.provider==='alipay'?'支付宝 · '+(item.channel==='mobile'?'手机网站':'电脑网站'):'历史渠道',item.trade_no||'—',new Date(item.created_at*1000).toLocaleString('zh-CN'),item.paid_at?new Date(item.paid_at*1000).toLocaleString('zh-CN'):'—'].forEach((value,index)=>{
            const cell=node('td',value);if(index===5&&item.issues.length)cell.className='order-review';row.append(cell);
          });
          const cell=node('td');if(item.provider==='alipay'){const button=node('button','查询支付宝');button.className='b-secondary';button.onclick=async()=>{button.disabled=true;try{await request('/admin/orders/'+encodeURIComponent(item.order_no)+'/reconcile',{});await orders();await overview();}catch(error){alert(error.message);}finally{button.disabled=false;}};cell.append(button);}row.append(cell);body.append(row);
        }table.append(body);area.append(table);}
      const count=node('span',`共 ${data.total} 笔 · 第 ${data.page} / ${data.pages} 页`);count.className='mut';pager.append(count);
      const prev=node('button','上一页'),next=node('button','下一页');for(const button of [prev,next])button.className='b-secondary';
      prev.disabled=data.page<=1;next.disabled=data.page>=data.pages;prev.onclick=()=>{orderPage--;orders();};next.onclick=()=>{orderPage++;orders();};pager.append(prev,next);
    }catch(error){if(load===orderLoad)area.textContent=error.message;}}
  async function audit(){const area=$('v6Audit');try{const data=await request('/admin/audit');area.replaceChildren();
    if(!data.events.length){area.textContent='暂无操作记录';return;}
    const table=node('table');table.className='tbl';const head=node('tr');for(const value of ['时间','操作者','操作','目标','详情'])head.append(node('th',value));table.append(head);
    for(const item of data.events){const row=node('tr');for(const value of [item.created_at,item.actor||String(item.actor_id),item.action,item.target,item.detail])row.append(node('td',value));table.append(row);}area.append(table);
  }catch(error){area.textContent=error.message;}}
  window.showAccountCommerce=async uid=>{try{const data=await request('/admin/users/'+uid+'/commerce');const dialog=node('dialog');dialog.style.cssText='border:1px solid var(--b-line);border-radius:18px;background:var(--b-paper);color:var(--b-ink);padding:25px;width:min(94vw,720px);max-height:85dvh;overflow:auto';
    dialog.append(node('h2',data.user.custom_id+' · 权益与订单'),node('p','账号状态：'+data.user.status));
    for(const [feature,label] of [['pro','专业功能会员'],['cosmic','星空胶囊皮肤']]){const current=data.entitlements.features[feature];
      dialog.append(node('h3',label+' · '+(current?(current.expires_at?new Date(current.expires_at*1000).toLocaleDateString('zh-CN')+' 到期':'长期有效'):'未开通')));
      for(const source of data.entitlements.sources.filter(item=>item.feature===feature)){dialog.append(node('p',`${source.source_kind} · ${source.source} · ${source.revoked?'已退款撤销':source.active?'有效':'已到期'} · ${source.expires_at?new Date(source.expires_at*1000).toLocaleDateString('zh-CN'):'长期'}`));}}
    dialog.append(node('h3','最近订单'));for(const order of data.orders.slice(0,20))dialog.append(node('p',`${order.order_no} · ${order.name} · ${money(order.amount)} · ${order.state}`));
    if(!data.orders.length)dialog.append(node('p','暂无订单'));
    const close=node('button','关闭');close.className='b-secondary';close.onclick=()=>dialog.close();dialog.append(close);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
  }catch(error){alert(error.message);}};
  overview();products();batches();orders();audit();
})();
