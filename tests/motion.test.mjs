import test from 'node:test';
import assert from 'node:assert/strict';
import {damp,smooth,landingPlan,stepCapsules,brakeProgress,brakeSpeed,paletteIndex,nameSphereLayout} from '../static/v6/motion.mjs';
test('wheel landing preserves velocity and lands in the selected sector',()=>{
 for(const angle of [0,3,100,1000])for(const target of [-5,0,5])for(const speed of [4,8,12]){
  const p=landingPlan(angle,target,speed);assert.ok(p.distance>0);assert.ok(p.duration>=2.4-1e-10);assert.ok(Math.abs(2*p.distance/p.duration-speed)<1e-10);
  assert.ok(Math.abs(Math.sin((angle+p.distance-target)/2))<1e-10);
 }
});
test('damping is independent of frame rate and easing has stationary ends',()=>{
 let a=0,b=0;for(let i=0;i<30;i++)a=damp(a,3,2,1/30);for(let i=0;i<120;i++)b=damp(b,3,2,1/120);
 assert.ok(Math.abs(a-b)<1e-12);assert.equal(smooth(0),0);assert.equal(smooth(1),1);assert.ok(smooth(.001)<1e-7);
});
test('48 capsules stay finite and inside their globe while mixing and settling',()=>{
 const bodies=Array.from({length:48},(_,i)=>({position:{x:Math.cos(i*2.399)*(.45+i%3*.3),y:.05+Math.floor(i/9)*.36,z:Math.sin(i*2.399)*(.45+i%3*.3)},userData:{i,velocity:{x:0,y:0,z:0}}}));
 for(let frame=0;frame<1800;frame++){
  stepCapsules(bodies,1/120,frame<600?1:0,frame/120);
  for(const b of bodies){const p=b.position;assert.ok(Number.isFinite(p.x+p.y+p.z));assert.ok(Math.hypot(p.x,p.y-.78,p.z)<=1.460001);}
 }
 const energy=bodies.reduce((sum,b)=>sum+Object.values(b.userData.velocity).reduce((n,v)=>n+v*v,0),0)/48;
 assert.ok(energy<.1,`settled energy ${energy}`);
});
test('coincident capsules separate without NaN',()=>{
 const bodies=[0,1].map(i=>({position:{x:0,y:.78,z:0},userData:{i,velocity:{x:0,y:0,z:0}}}));stepCapsules(bodies,1/120,0,0);assert.ok(Math.abs(bodies[0].position.x-bodies[1].position.x)>.5);
});

test('braking progresses monotonically with no endpoint acceleration jump',()=>{
 let previous=0;for(let i=0;i<=1000;i++){const t=i/1000,p=brakeProgress(t);assert.ok(p>=previous-1e-12);assert.ok(brakeSpeed(t)>=-1e-12);previous=p;}
 assert.equal(brakeProgress(0),0);assert.equal(brakeProgress(1),1);assert.equal(brakeSpeed(0),2);assert.equal(brakeSpeed(1),0);
 assert.ok(Math.abs(brakeSpeed(.0001)-brakeSpeed(0))<1e-6);assert.ok(brakeSpeed(.9999)<1e-6);
});

test('candidate colors remain deterministic with all six tones represented',()=>{
 const indices=new Set();for(let i=0;i<100;i++){const key=`person-${i}`;assert.equal(paletteIndex(key),paletteIndex(key));indices.add(paletteIndex(key));}assert.equal(indices.size,6);
});
test('fixed pointer lands at the chosen rotating wedge center',()=>{
 for(const n of [2,8,12,48])for(let i=0;i<n;i++){
  const center=(i+.5)*Math.PI*2/n,angle=12.345,p=landingPlan(angle,-center,7);
  const final=center+angle+p.distance;assert.ok(Math.abs(Math.sin(final))<1e-10);assert.ok(Math.cos(final)>.999999);
 }
});

test('every capsule travels, rises and tumbles during a full mixing cycle',()=>{
 for(const n of [6,12,48]){
  const bodies=Array.from({length:n},(_,i)=>({position:{x:Math.cos(i*2.399)*(.45+i%3*.3),y:.05+Math.floor(i/9)*.36,z:Math.sin(i*2.399)*(.45+i%3*.3)},userData:{i,velocity:{x:0,y:0,z:0}}}));
  for(let f=0;f<240;f++)stepCapsules(bodies,1/120,0,f/120);
  const peaks=bodies.map(b=>b.position.y),travel=bodies.map(()=>0);
  for(let f=0;f<624;f++){
   const previous=bodies.map(b=>({...b.position}));stepCapsules(bodies,1/120,1,f/120);
   bodies.forEach((b,i)=>{const p=b.position,q=previous[i];peaks[i]=Math.max(peaks[i],p.y);travel[i]+=Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);});
  }
  assert.ok(Math.min(...travel)>8,`${n}: a capsule remained trapped`);
  assert.ok(Math.min(...peaks)>.78,`${n}: a capsule never reached the upper half`);
  for(const b of bodies)assert.ok(Math.hypot(...Object.values(b.userData.angular))>1);
 }
});
test('sphere includes every candidate in distinct surface slots, including large lists',()=>{
 for(const n of [0,1,12,48,100,500,1000]){
  const slots=nameSphereLayout(n);assert.equal(slots.length,n);
  assert.equal(new Set(slots.map(p=>[p.x,p.y,p.z].join(','))).size,n);
  for(const p of slots){assert.ok(Math.abs(Math.hypot(p.x,p.y,p.z)-2.3)<1e-10);assert.ok(p.size>0&&p.size<=1);}
 }
});

test('capsules lift and settle with damped startup energy at 30 and 60 fps',()=>{
 const fpsCases=[30,60],counts=[6,12,48],substepMax=1/120;
 for(const fps of fpsCases)for(const n of counts){
  const bodies=Array.from({length:n},(_,i)=>({position:{x:Math.cos(i*2.399)*(.45+i%3*.3),y:.05+Math.floor(i/9)*.36,z:Math.sin(i*2.399)*(.45+i%3*.3)},userData:{i,velocity:{x:0,y:0,z:0}}}));
  const frameDt=1/fps;let energy=0,physicsTime=0;
  const stepFrame=(dt,active=false,metrics=null)=>{
   const steps=Math.ceil(dt/substepMax),subDt=dt/steps;
   for(let step=0;step<steps;step++){
    physicsTime+=energy*subDt;stepCapsules(bodies,subDt,energy,physicsTime);
    for(let i=0;i<bodies.length;i++){
     const body=bodies[i],p=body.position,v=body.userData.velocity,a=body.userData.angular;
     assert.ok([...Object.values(p),...Object.values(v),...Object.values(a||{})].every(Number.isFinite),`${fps}fps/${n}: non-finite state`);
     assert.ok(Math.hypot(p.x,p.y-.78,p.z)<=1.460001,`${fps}fps/${n}: escaped bowl`);
     if(active){
      const sample=metrics[i],previous=sample.previous;
      sample.travel+=Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z);
      sample.minY=Math.min(sample.minY,p.y);sample.maxY=Math.max(sample.maxY,p.y);
      if(v.y>.3)sample.rising+=subDt;
      if(v.y<-.3)sample.falling+=subDt;
      sample.previous={...p};
     }
    }
   }
  };
  for(let t=0;t<2-1e-9;t+=frameDt)stepFrame(frameDt);
  const metrics=bodies.map(body=>({previous:{...body.position},minY:body.position.y,maxY:body.position.y,travel:0,rising:0,falling:0}));
  for(let frame=0;frame<Math.round(5.2*fps);frame++){
   energy=damp(energy,1,2,frameDt);stepFrame(frameDt,true,metrics);
  }
  for(const [i,sample] of metrics.entries()){
   assert.ok(sample.maxY-sample.minY>.52,`${fps}fps/${n}/${i}: height span ${sample.maxY-sample.minY}`);
   assert.ok(sample.travel>8,`${fps}fps/${n}/${i}: travel ${sample.travel}`);
   assert.ok(sample.rising>.25,`${fps}fps/${n}/${i}: rising ${sample.rising}s`);
   assert.ok(sample.falling>.25,`${fps}fps/${n}/${i}: falling ${sample.falling}s`);
  }
  for(let frame=0;frame<Math.round(6*fps);frame++){
   energy=damp(energy,0,2.7,frameDt);stepFrame(frameDt);
  }
  const meanSquaredSpeed=bodies.reduce((sum,body)=>{
   const v=body.userData.velocity;return sum+v.x*v.x+v.y*v.y+v.z*v.z;
  },0)/n;
  assert.ok(meanSquaredSpeed<.1,`${fps}fps/${n}: stopped mean squared speed ${meanSquaredSpeed}`);
 }
});
