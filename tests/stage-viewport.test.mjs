import test from 'node:test';
import assert from 'node:assert/strict';
import {stageViewport} from '../static/v6/stage-viewport.mjs';
import {fitCamera} from '../static/v6/camera-fit.mjs';

test('full-screen camera projection preserves safe framing on desktop, mobile and immersion', () => {
  const cases = [[1366,768,{top:.10,right:.11,bottom:.12,left:.11}],
    [390,844,{top:.20,right:.01,bottom:.20,left:.01}],
    [844,390,{top:.12,right:.18,bottom:.14,left:.18}],
    [1920,1080,{top:.03,right:.07,bottom:.04,left:.07}]];
  const bounds={min:[-2.4,-1.7,-1.2],max:[2.1,2.8,1.5]},pitch=.32;
  for(const [w,h,insets] of cases){
    const view=stageViewport(w,h,42,insets);
    const fit=fitCamera({bounds,aspect:view.aspect,fov:view.fov,pitch,fill:.86,padding:.08});
    const tan=Math.tan(42*Math.PI/360),sin=Math.sin(pitch),cos=Math.cos(pitch);
    for(let i=0;i<8;i++){
      const point=[0,1,2].map(axis=>(i&(1<<axis)?bounds.max[axis]:bounds.min[axis])-fit.position[axis]);
      const depth=-point[1]*sin-point[2]*cos;
      // Project through the actual full-viewport camera, including its view offset.
      const x=w/2+(point[0]/(depth*tan*w/h))*w/2-view.offsetX;
      const y=h/2-((point[1]*cos-point[2]*sin)/(depth*tan))*h/2-view.offsetY;
      assert.ok(x>=w*insets.left&&x<=w*(1-insets.right),`horizontal clipping at ${w}x${h}`);
      assert.ok(y>=h*insets.top&&y<=h*(1-insets.bottom),`vertical clipping at ${w}x${h}`);
    }
  }
});
test('legacy stages keep their original projection and invalid insets stay finite', () => {
  const v=stageViewport(800,600,42);assert.equal(v.aspect,800/600);assert.ok(Math.abs(v.fov-42)<1e-10);
  assert.equal(v.offsetX,0);assert.equal(v.offsetY,0);
  const invalid=stageViewport(0,0,42,{top:Infinity,bottom:.8,left:-2,right:NaN});
  assert.ok(invalid.safeHeight>0);assert.ok(Number.isFinite(invalid.aspect));
});
