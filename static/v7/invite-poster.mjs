const DAY_FORMAT = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const day = seconds => DAY_FORMAT.format(new Date(seconds * 1000));

export function localInviteHost(hostname) {
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'');
  return host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host==='::1'||host==='0.0.0.0'||
    /^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function invitationPosterModel({link,origin,campaign,products=[],now=Date.now()/1000}) {
  const url=new URL(link,origin);
  if(url.origin!==new URL(origin).origin||!['http:','https:'].includes(url.protocol)||url.username||url.password||
    url.pathname!=='/login.html'||url.hash||[...url.searchParams].length!==1||
    !/^[A-Za-z0-9_-]{8,80}$/.test(url.searchParams.get('invite')||''))throw new Error('邀请链接无效，请重新打开邀请面板。');
  const local=localInviteHost(url.hostname);
  const active=!!(campaign?.enabled&&(campaign.starts_at==null||now>=campaign.starts_at)&&(campaign.ends_at==null||now<=campaign.ends_at));
  const terms=[];
  if(active){
    const rewards=[];
    if(campaign.pro_days)rewards.push(`专业功能会员 ${campaign.pro_days} 天`);
    if(campaign.skin_feature&&campaign.skin_days){
      const skin=products.find(product=>product.kind==='skin'&&product.feature===campaign.skin_feature);
      rewards.push(`${skin?.name||(campaign.skin_feature==='cosmic'?'星空胶囊皮肤':'指定皮肤')} ${campaign.skin_days} 天`);
    }
    terms.push(`奖励对象：${campaign.reward_newcomer?'邀请人和新用户':'邀请人'}`);
    terms.push(...rewards);
    terms.push(campaign.require_experience?'好友有效新注册后，需再完成一次有效抽取。':'好友完成有效新账号注册后，核验发奖。');
    terms.push(`无需购买 · 每位邀请人每月最多奖励 ${campaign.monthly_cap} 次`);
    terms.push(`首个有效邀请链接归因，${campaign.attribution_days} 天内注册有效。`);
    if(campaign.ends_at)terms.push(`活动截止：${day(campaign.ends_at)}，以注册页完整规则为准。`);
  }else terms.push('当前没有开放中的邀请赠礼活动。','基础机台仍可免费体验，注册可保存个人配置。');
  return {link:url.href,host:url.host,local,active,
    title:'免费抽，尽兴玩',terms,
    campaignName:active?campaign.name:'一起体验 3D 抽取',
    ruleNote:active?`规则版本 ${campaign.version} · 生成于 ${day(now)}。打开链接时请确认当前活动规则。`:`生成于 ${day(now)}。活动与权益以页面说明为准。`,
    localNote:local?'本地／内网预览链接，仅供验收；公网部署后再分享给好友。':'扫码或识别二维码，打开你的免费机台。'};
}

export function wrapPosterText(context,text,width){
  const lines=[];let line='';
  for(const character of String(text)){
    if(character==='\n'){lines.push(line);line='';continue;}
    if(line&&context.measureText(line+character).width>width){lines.push(line);line=character;}
    else line+=character;
  }
  if(line)lines.push(line);
  return lines;
}

export function renderInvitationPoster(model,qrImage,documentRef=document){
  const canvas=documentRef.createElement('canvas'),cx=canvas.getContext('2d');
  if(!cx)throw new Error('当前浏览器无法生成图片，请使用邀请链接。');
  const font=(size,weight=400)=>`${weight} ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
  cx.font=font(28,600);
  const titleLines=wrapPosterText(cx,model.campaignName,900);
  cx.font=font(27);
  const rules=model.terms.flatMap(term=>wrapPosterText(cx,term,860));
  cx.font=font(22);
  const notes=wrapPosterText(cx,model.ruleNote,880);
  cx.font=font(21);
  const footnotes=wrapPosterText(cx,model.localNote,875);
  const footerStart=1128+titleLines.length*40+10+rules.length*44+12+notes.length*32+60;
  canvas.width=1080;canvas.height=Math.max(1530,footerStart+footnotes.length*30+80);
  const background=cx.createLinearGradient(0,0,1080,canvas.height);background.addColorStop(0,'#101d3b');background.addColorStop(.5,'#20274c');background.addColorStop(1,'#0c172d');
  cx.fillStyle=background;cx.fillRect(0,0,canvas.width,canvas.height);
  const glow=(x,y,r,color)=>{const g=cx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,color);g.addColorStop(1,'#617bca00');cx.fillStyle=g;cx.fillRect(0,0,canvas.width,canvas.height);};
  glow(870,390,560,'#6357a16b');glow(180,710,450,'#2b8ca34a');
  for(let i=0;i<60;i++){cx.fillStyle=`rgba(212,224,255,${.12+(i%4)*.08})`;cx.beginPath();cx.arc((i*197.33)%1080,(i*i*31.7)%760,.9+(i%3)*.35,0,Math.PI*2);cx.fill();}
  const text=(value,x,y,size,color='#eff3ff',weight=400)=>{cx.font=font(size,weight);cx.fillStyle=color;cx.fillText(value,x,y);};
  text('抽了马',76,112,46,'#f3f4ff',700);text('免费抽，尽兴玩',76,164,25,'#b7c7e1');
  text('今天的选择，',76,276,76,'#f5f5ff',600);text('交给一点惊喜。',76,374,76,'#f5f5ff',600);
  text('吃什么 · 玩什么 · 抽奖品 · 抽点名',80,440,29,'#bbcae5');
  function capsule(x,y,angle,color,scale){
    cx.save();cx.translate(x,y);cx.rotate(angle);cx.scale(scale,scale);
    cx.shadowColor=color+'66';cx.shadowBlur=38;
    const gradient=cx.createLinearGradient(-110,-60,115,75);gradient.addColorStop(0,'#fcfcff');gradient.addColorStop(.15,color);gradient.addColorStop(.7,color);gradient.addColorStop(1,'#314060');
    cx.beginPath();cx.roundRect(-145,-74,290,148,74);cx.fillStyle=gradient;cx.fill();cx.shadowBlur=0;
    cx.save();cx.clip();cx.fillStyle='#eaf0ffbc';cx.fillRect(0,-85,150,170);cx.restore();
    cx.strokeStyle='#ffffffad';cx.lineWidth=3;cx.beginPath();cx.roundRect(-145,-74,290,148,74);cx.stroke();
    cx.strokeStyle='#f4f6ffad';cx.lineWidth=4;cx.beginPath();cx.moveTo(0,-70);cx.lineTo(0,70);cx.stroke();
    cx.fillStyle='#ffffff75';cx.beginPath();cx.ellipse(-64,-39,42,7,0,0,Math.PI*2);cx.fill();cx.restore();
  }
  capsule(225,594,-.4,'#60c7cb',.76);capsule(766,560,.38,'#b09bea',.86);capsule(522,632,-.55,'#edb675',1.12);
  const cardY=775;
  cx.fillStyle='#f2f4fb';cx.beginPath();cx.roundRect(60,cardY,960,canvas.height-cardY-60,34);cx.fill();
  text('扫码免费玩',100,866,43,'#17253c',700);
  text('三台基础机台，完整 3D 演出。',100,922,26,'#536780');
  text('注册后，保存你的专属配置。',100,966,26,'#536780');
  // Keep the complete quiet zone generated by the same-origin QR endpoint.
  cx.fillStyle='#fff';cx.fillRect(730,812,250,250);cx.imageSmoothingEnabled=false;cx.drawImage(qrImage,730,812,250,250);cx.imageSmoothingEnabled=true;
  text('识别二维码进入',757,1096,22,'#536780');
  let y=1128;
  for(const line of titleLines){text(line,100,y,28,'#17253c',600);y+=40;}
  y+=10;
  for(const line of rules){text(line,100,y,27,'#44556f');y+=44;}
  y+=12;
  for(const line of notes){text(line,100,y,22,'#6b7790');y+=32;}
  let footer=footerStart;
  cx.fillStyle=model.local?'#9d552a':'#576784';cx.font=font(21);
  for(const line of footnotes){cx.fillText(line,100,footer);footer+=30;}
  return canvas;
}

export async function invitationPosterBlob(model,{signal,fetcher=fetch}={}){
  const response=await fetcher('/api/qr?data='+encodeURIComponent(model.link),{credentials:'same-origin',signal});
  if(!response.ok)throw new Error('二维码暂时无法生成，请稍后再试。');
  const image=await createImageBitmap(await response.blob());
  try{
    if(signal?.aborted)throw new DOMException('Poster closed','AbortError');
    await document.fonts?.ready;
    const canvas=renderInvitationPoster(model,image);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('海报生成失败，请使用邀请链接。')),'image/png'));
  }finally{image.close();}
}
