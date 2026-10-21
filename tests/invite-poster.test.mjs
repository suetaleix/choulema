import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationPosterModel,localInviteHost,wrapPosterText,renderInvitationPoster} from '../static/v7/invite-poster.mjs';

const campaign={enabled:true,name:'好友同行，好运加时',version:4,pro_days:30,skin_feature:'cosmic',skin_days:30,monthly_cap:3,attribution_days:30,reward_newcomer:false,require_experience:false};
const base={origin:'https://lottery.example.test',link:'/login.html?invite=Abcdefgh_12345',campaign,now:1790588000};

test('poster uses independent current reward terms and does not promise a gift to the newcomer by default',()=>{
 const model=invitationPosterModel(base);
 assert.equal(model.link,'https://lottery.example.test/login.html?invite=Abcdefgh_12345');
 assert.equal(model.terms[0],'奖励对象：邀请人');
 assert.ok(model.terms.includes('专业功能会员 30 天'));
 assert.ok(model.terms.includes('星空胶囊皮肤 30 天'));
 assert.ok(model.terms.some(line=>line.includes('每月最多奖励 3 次')));
 assert.equal(model.local,false);
});

test('custom skin, dual rewards and experience condition come from the selected campaign',()=>{
 const model=invitationPosterModel({...base,campaign:{...campaign,skin_feature:'future',pro_days:7,skin_days:14,reward_newcomer:true,require_experience:true,monthly_cap:2},products:[{kind:'skin',feature:'future',name:'未来皮肤'}]});
 assert.equal(model.terms[0],'奖励对象：邀请人和新用户');
 assert.ok(model.terms.includes('专业功能会员 7 天'));
 assert.ok(model.terms.includes('未来皮肤 14 天'));
 assert.ok(model.terms.some(line=>line.includes('一次有效抽取')));
});

test('closed, expired, scheduled and absent campaigns do not advertise rewards',()=>{
 for(const config of [null,{...campaign,enabled:false},{...campaign,ends_at:base.now-1},{...campaign,starts_at:base.now+1}]){
  const model=invitationPosterModel({...base,campaign:config});
  assert.equal(model.active,false);assert.match(model.terms.join(''),/当前没有开放/);
  assert.doesNotMatch(model.terms.join(''),/30 天/);
 }
});

test('QR destination must be the current site and its canonical invitation path',()=>{
 for(const link of ['https://other.test/login.html?invite=Abcdefgh_12345','javascript:alert(1)','//other.test/login.html?invite=abcdefgh',
  '/admin.html?invite=abcdefgh','/login.html?invite=short','/login.html?invite=abcdefgh&next=/admin.html','/login.html?invite=abcdefgh#private']){
  assert.throws(()=>invitationPosterModel({...base,link}),/邀请链接无效/);
 }
});

test('development links carry a clear reachability notice',()=>{
 for(const host of ['localhost','127.0.0.1','[::1]','192.168.1.2','10.0.0.2','172.16.1.2'])assert.equal(localInviteHost(host),true);
 assert.equal(localInviteHost('172.32.1.2'),false);
 const model=invitationPosterModel({...base,origin:'http://127.0.0.1:8901'});
 assert.equal(model.local,true);assert.match(model.localNote,/仅供验收/);
});

test('wrapping preserves Unicode text and explicit line breaks',()=>{
 const cx={measureText:text=>({width:[...text].length*10})};
 const lines=wrapPosterText(cx,'姓名✨你好\n再试一次',30);
 assert.deepEqual(lines,['姓名✨','你好','再试一','次']);
});

test('maximum-length campaign and skin names grow the poster instead of clipping the terms',()=>{
 const drawn=[];
 const noop=()=>{};
 const cx={font:'',measureText(text){return {width:[...text].length*parseFloat(this.font.replace(/^\d+ /,''))};},
  createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),fillText:(text,x,y)=>drawn.push({text,x,y}),
  fillRect:noop,beginPath:noop,arc:noop,ellipse:noop,roundRect:noop,fill:noop,stroke:noop,save:noop,restore:noop,clip:noop,translate:noop,rotate:noop,scale:noop,moveTo:noop,lineTo:noop,drawImage:noop};
 const canvas={width:0,height:0,getContext:()=>cx};
 const model=invitationPosterModel({...base,campaign:{...campaign,name:'活动名称'.repeat(20),skin_feature:'long'},products:[{kind:'skin',feature:'long',name:'特别的皮肤'.repeat(20)}]});
 renderInvitationPoster(model,{}, {createElement:()=>canvas});
 assert.ok(canvas.height>1530);
 assert.ok(drawn.every(line=>line.y<canvas.height-40));
 const footer=drawn.at(-1);assert.ok(footer.y>drawn.at(-2).y+20);
 assert.ok(drawn.some(line=>line.text.includes('奖励对象')));
});
