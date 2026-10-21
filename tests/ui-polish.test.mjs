import test from 'node:test';
import assert from 'node:assert/strict';
import {resumePlay} from '../static/v7/resume-play.mjs';
import {framingFill,framingScale} from '../static/v6/stage-framing.mjs';
import {stageViewport} from '../static/v6/stage-viewport.mjs';
import {fitCamera} from '../static/v6/camera-fit.mjs';

test('resume uses only the authenticated account and never another account or guest draft',()=>{
 const data=new Map([
  ['clm-scope:user:2:clm-app','"food"'],['clm-scope:user:2:clm-drafts',JSON.stringify({food:{config:{app:'food',title:'午饭'}}})],
  ['clm-scope:user:3:clm-app','"person"'],['clm-scope:user:3:clm-drafts',JSON.stringify({person:{config:{app:'person',title:'我的班级'}}})],
 ]),raw={getItem:k=>data.get(k)};
 assert.equal(resumePlay(raw,2).title,'午饭');assert.equal(resumePlay(raw,3).href,'/play.html?app=person');
 assert.equal(resumePlay(raw,4),null);assert.equal(resumePlay(raw,null),null);assert.equal(resumePlay(raw,'2'),null);
});
test('corrupt, unavailable or mismatched resume data safely returns the generic play link',()=>{
 assert.equal(resumePlay({getItem:()=>'{broken'},2),null);
 assert.equal(resumePlay({getItem:()=>{throw new Error('storage disabled');}},2),null);
 assert.equal(resumePlay({getItem:k=>k.endsWith('clm-app')?'"https://external.example"':'{}'},2),null);
 assert.equal(resumePlay({getItem:k=>k.endsWith('clm-app')?'"food"':'{"food":{"config":{"app":"person"}}}'},2),null);
});
test('stage emphasis stays bounded and defaults leave legacy framing unchanged',()=>{
 for(const value of [null,undefined,'',NaN,Infinity,-10])assert.equal(framingScale(value),1);
 assert.equal(framingFill(.86),.86);assert.equal(framingFill(.86,99),.96);
 assert.ok(framingFill(.84,1.14)>.84);
});
test('enlarged camera fit retains safe margins at the new phone, tablet, desktop and landscape layouts',()=>{
 const cases=[[1280,800,{top:.055,right:.11,bottom:.115,left:.11}],
 [390,844,{top:.28,right:.01,bottom:.23,left:.01}],
 [320,568,{top:.36,right:.01,bottom:.27,left:.01}],
 [768,1024,{top:.18,right:.14,bottom:.13,left:.18}],
 [568,320,{top:.17,right:.20,bottom:.18,left:.20}]];
 const bounds={min:[-2.4,-1.7,-1.2],max:[2.1,2.8,1.5]},pitch=.32;
 for(const [w,h,insets] of cases){
  const view=stageViewport(w,h,42,insets),fit=fitCamera({bounds,aspect:view.aspect,fov:view.fov,pitch,fill:framingFill(.86,1.14),padding:.08});
  const tan=Math.tan(42*Math.PI/360),sin=Math.sin(pitch),cos=Math.cos(pitch);
  for(let i=0;i<8;i++){
   const point=[0,1,2].map(axis=>(i&(1<<axis)?bounds.max[axis]:bounds.min[axis])-fit.position[axis]);
   const depth=-point[1]*sin-point[2]*cos;
   const x=w/2+(point[0]/(depth*tan*w/h))*w/2-view.offsetX;
   const y=h/2-((point[1]*cos-point[2]*sin)/(depth*tan))*h/2-view.offsetY;
   assert.ok(x>=w*insets.left&&x<=w*(1-insets.right),`${w}x${h} horizontal clip`);
   assert.ok(y>=h*insets.top&&y<=h*(1-insets.bottom),`${w}x${h} vertical clip`);
  }
 }
});
