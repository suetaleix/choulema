// Approved cosmic renderer. Business rules and entitlements remain server-owned.
// Adapted from the original v4 Three.js machines; rendering only.
import * as THREE from '/vendor/three.module.js';
import { RoomEnvironment } from '/vendor/addons/environments/RoomEnvironment.js';
import { EffectComposer } from '/vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/addons/postprocessing/OutputPass.js';
import { createEffects } from '/v6/effects.js';
import { effectBudget } from '/v6/effect-budget.mjs';
import { damp, smooth, stepCapsules, paletteIndex, nameSphereLayout } from '/v6/motion.mjs?v=machine-motion-2';
import { SHARED_PROFILE, MACHINE_PROFILES } from './stellar-profiles.mjs?v=aurora-glass-r2-20261001';
import { createAuroraWheel } from './aurora-wheel.mjs?v=aurora-glass-r2-20261001';
import { fitCamera, fitSphereCamera } from '/v6/camera-fit.mjs';
import { fitCameraPoints } from '/v6/camera-points.mjs';
import { stageViewport } from '/v6/stage-viewport.mjs';
import { framingFill, framingScale } from '/v6/stage-framing.mjs';
import { STAGE_BACKGROUNDS, coverTexture, createBackgroundController } from '/v6/stage-background.mjs';
import { capsuleOutSample, capsuleReturnSample } from '/v6/capsule-presentation.mjs';
import { capsuleRouteSegments } from '/v6/capsule-route.mjs';
import { sampleSphereLanding, sphereLandingPlan } from '/v6/sphere-presentation.mjs';
import { paginateResults, resultPageSize } from '/v6/result-pages.mjs';
import { createWheelCandidateKey } from '/v6/wheel-candidate-key.mjs';
import { advanceWheelSpin, sampleWheelLanding, wheelLandingPlan, wheelSettleProgress, wheelTick } from '/v6/wheel-presentation.mjs';
export function createStage(mount, onActivate, onSound=()=>{}, reducedMotion=false, motionFeedback=false) {
let CURRENT={items:[]}, STATE='idle', reduced=Boolean(reducedMotion),revealSoundPlayed=false;
let revealStart=0,celebrateAt=0,decorationUntil=0;
let groupAnimation=null,quality='high', cosmic=false, stopped=false, drag=null, dragAngle=0,dragElevation=0,dragVelocity=0,hovered=false,press=0,spinStart=0,transitionId=0;
const PALETTE=SHARED_PROFILE.palette;
const scene=new THREE.Scene();
const backdropTextures=new Map();
function themeTexture(theme){
 if(backdropTextures.has(theme))return backdropTextures.get(theme);
 const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=768;
 const cx=canvas.getContext('2d'),colors=theme==='cosmic'?{center:'#302344',mid:'#17172f',edge:'#070b1a',accent:'#a177dc'}:STAGE_BACKGROUNDS[theme];
 const gradient=cx.createRadialGradient(512,340,24,512,350,650);
 gradient.addColorStop(0,colors.center);gradient.addColorStop(.5,colors.mid);gradient.addColorStop(1,colors.edge);
 cx.fillStyle=gradient;cx.fillRect(0,0,1024,768);
 // Broad, quiet light at the edges adds depth without adding a pedestal or frame.
 const wash=cx.createRadialGradient(80,90,0,80,90,520);
 wash.addColorStop(0,colors.accent+'38');wash.addColorStop(1,colors.accent+'00');
 cx.fillStyle=wash;cx.fillRect(0,0,1024,768);
 if(theme==='cosmic')for(let i=0;i<210;i++){
  const x=((i*137.508)%1024),y=((i*i*29.37+71)%768);
  cx.fillStyle=`rgba(219,211,255,${.12+(i%4)*.07})`;cx.beginPath();cx.arc(x,y,.45+(i%3)*.25,0,Math.PI*2);cx.fill();
 }
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
 backdropTextures.set(theme,texture);return texture;
}
function fitBackdrop(){
 const texture=scene.background;if(!texture?.isTexture)return;
 const fit=coverTexture(texture.image.width,texture.image.height,Math.max(1,mount.clientWidth),Math.max(1,mount.clientHeight));
 texture.repeat.set(fit.x,fit.y);texture.offset.set(fit.offsetX,fit.offsetY);
}
const background=createBackgroundController({themeTexture,
 loadTexture:value=>new THREE.TextureLoader().loadAsync(value).then(texture=>{texture.colorSpace=THREE.SRGBColorSpace;return texture;}),
 apply:texture=>{scene.background=texture;fitBackdrop();},dispose:texture=>texture.dispose(),
});
let stageFraming=1;
let viewport=stageViewport(1,1,SHARED_PROFILE.camera.fov);
const camera=new THREE.PerspectiveCamera(SHARED_PROFILE.camera.fov,1,SHARED_PROFILE.camera.near,SHARED_PROFILE.camera.far);
camera.position.fromArray(SHARED_PROFILE.camera.initialPosition);camera.lookAt(...SHARED_PROFILE.camera.initialAim);
const cameraAim=new THREE.Vector3(...SHARED_PROFILE.camera.initialAim);
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,SHARED_PROFILE.rendering.initialPixelRatio));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=SHARED_PROFILE.rendering.toneMappingExposure;
mount.appendChild(renderer.domElement);
const pmrem=new THREE.PMREMGenerator(renderer), env=pmrem.fromScene(new RoomEnvironment(),.03);
scene.environment=env.texture;
scene.add(new THREE.HemisphereLight(0xe9f3ff,0x25332a,2.3));
const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(4,7,5);scene.add(light);
const rim=new THREE.PointLight(0xb8ff83,12,20);rim.position.set(-4,2,-2);scene.add(rim);
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
const bloomProfile=SHARED_PROFILE.rendering.bloom;
const bloom=new UnrealBloomPass(new THREE.Vector2(bloomProfile.width,bloomProfile.height),bloomProfile.strength,bloomProfile.radius,bloomProfile.threshold);composer.addPass(bloom);composer.addPass(new OutputPass());
const starsGeo=new THREE.BufferGeometry(),starsArray=new Float32Array(220*3);
for(let i=0;i<220;i++){starsArray[i*3]=(Math.random()-.5)*18;starsArray[i*3+1]=(Math.random()-.5)*14;starsArray[i*3+2]=-4-Math.random()*4;}
starsGeo.setAttribute('position',new THREE.BufferAttribute(starsArray,3));starsGeo.setDrawRange(0,0);const cosmicStars=new THREE.Points(starsGeo,new THREE.PointsMaterial({color:0xc9b2ff,size:.045,transparent:true,opacity:.75,depthWrite:false}));cosmicStars.visible=false;scene.add(cosmicStars);
const effects=createEffects(scene);
function roundRect(cx,x,y,w,h,r){cx.beginPath();cx.moveTo(x+r,y);cx.arcTo(x+w,y,x+w,y+h,r);
  cx.arcTo(x+w,y+h,x,y+h,r);cx.arcTo(x,y+h,x,y,r);cx.arcTo(x,y,x+w,y,r);cx.closePath();}
/* 圆角形状（苹果风筹码卡） */
function roundedShape(w,h,r){
  const sh=new THREE.Shape();
  sh.moveTo(-w/2+r,-h/2);
  sh.lineTo(w/2-r,-h/2);sh.absarc(w/2-r,-h/2+r,r,-Math.PI/2,0,false);
  sh.lineTo(w/2,h/2-r);sh.absarc(w/2-r,h/2-r,r,0,Math.PI/2,false);
  sh.lineTo(-w/2+r,h/2);sh.absarc(-w/2+r,h/2-r,r,Math.PI/2,Math.PI,false);
  sh.lineTo(-w/2,-h/2+r);sh.absarc(-w/2+r,-h/2+r,r,Math.PI,Math.PI*1.5,false);
  return sh;
}
/* 彩色哑光牌身、窄边与不发光的浅色文字面。 */
const CHIP_BODY=[0xc0392b,0x1e8e6e,0x2e6db4,0x7d4fb2,0xd07a1f,0x2a9aa8];
function cardAppearance(key){
 if(cosmic){
  const colors=['#aa92eb','#79c5e1','#d99dbb','#8bade8','#c6a2ec','#7acdc4'];
  const tint=new THREE.Color(colors[paletteIndex(key)%colors.length]);
  const profile={...SHARED_PROFILE.cards,edgeWidth:5,topHighlightWidth:3};
  const body=tint.clone().multiplyScalar(.4),face=tint.clone().multiplyScalar(.36);
  return {profile,bodyColor:body,faceColor:face,gradient:[tint.clone().multiplyScalar(.58).getStyle(),tint.clone().multiplyScalar(.15).getStyle()],textColor:'#faf5ff',edgeColor:tint.getStyle(),highlightColor:'#f0deff'};
 }

  const profile=SHARED_PROFILE.cards,bodyColor=new THREE.Color(PALETTE[paletteIndex(key)]);
  const faceColor=bodyColor.clone().lerp(new THREE.Color(profile.faceNeutral),profile.faceMix);
  const faceTop=faceColor.clone().lerp(new THREE.Color(0xffffff),profile.faceHighlight);
  const faceBottom=faceColor.clone().lerp(new THREE.Color(0x26333a),profile.faceHighlight*.5);
  return {
    profile,bodyColor:bodyColor.clone().multiplyScalar(profile.bodyShade),faceColor,
    gradient:[faceTop.getStyle(),faceBottom.getStyle()],
    textColor:'#'+profile.textColor.toString(16).padStart(6,'0'),
    edgeColor:faceColor.clone().lerp(bodyColor,.35).getStyle(),
    highlightColor:faceTop.clone().lerp(new THREE.Color(0xffffff),.35).getStyle(),
  };
}
function makeChip(name,w=.95,h=.62,key=name){
  const g=new THREE.Group();
  const appearance=cardAppearance(key),profile=appearance.profile;
  const bodyMaterial=new THREE.MeshStandardMaterial({color:appearance.bodyColor,roughness:profile.roughness,metalness:profile.metalness,envMapIntensity:profile.envMapIntensity});
  bodyMaterial.userData.noWinnerGlow=true;
  const body=new THREE.Mesh(new THREE.ExtrudeGeometry(roundedShape(w,h,.09),{depth:profile.depth,bevelEnabled:true,bevelThickness:.01,bevelSize:.01,bevelSegments:1}),bodyMaterial);
  body.position.z=-.03;g.add(body);
  // 中央名牌底（双面）
  const inlayGeo=new THREE.PlaneGeometry(w*.94,h*.84);
  const inlayMat=new THREE.MeshStandardMaterial({color:appearance.faceColor,roughness:profile.roughness,metalness:profile.metalness,envMapIntensity:profile.envMapIntensity,side:THREE.DoubleSide});
  inlayMat.userData.noWinnerGlow=true;
  const inlay=new THREE.Mesh(inlayGeo,inlayMat);inlay.position.z=.035;g.add(inlay);
  const inlayB=new THREE.Mesh(inlayGeo,inlayMat);inlayB.rotation.y=Math.PI;inlayB.position.z=-.035;g.add(inlayB);
  // 文字贴合在同色浅面上；仅保留窄边和上沿细高光。
  const normalStyle={
    edgeColor:appearance.edgeColor,edgeWidth:profile.edgeWidth,
    highlightColor:appearance.highlightColor,highlightWidth:profile.topHighlightWidth,
  };
  const tex=texLabel(name,appearance.gradient,appearance.textColor,normalStyle);
  const labMat=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthTest:true,depthWrite:false});
  labMat.toneMapped=false;
  const labGeo=new THREE.PlaneGeometry(w*.92,h*.80);
  const labF=new THREE.Mesh(labGeo,labMat);labF.position.z=.05;labF.renderOrder=10;g.add(labF);
  const labB=new THREE.Mesh(labGeo,labMat);labB.position.z=-.05;labB.rotation.y=Math.PI;labB.renderOrder=10;g.add(labB);
  return g;
}
function texLabel(text,bg='#0d1622',fg='#eaf6f4',cardStyle=null){
  const cv=document.createElement('canvas');cv.width=512;cv.height=256;
  const cx=cv.getContext('2d');
  if(Array.isArray(bg)){const gradient=cx.createLinearGradient(0,0,512,256);gradient.addColorStop(0,bg[0]);gradient.addColorStop(1,bg[1]);cx.fillStyle=gradient;}else cx.fillStyle=bg;cx.fillRect(0,0,512,256);
  if(String(bg).toLowerCase()==='#ffffff'){cx.strokeStyle='rgba(0,0,0,.18)';cx.lineWidth=4;cx.strokeRect(8,8,496,240);}
  if(cardStyle){
    cx.strokeStyle=cardStyle.edgeColor;cx.lineWidth=cardStyle.edgeWidth;roundRect(cx,cardStyle.edgeWidth,cardStyle.edgeWidth,512-cardStyle.edgeWidth*2,256-cardStyle.edgeWidth*2,20);cx.stroke();
    cx.strokeStyle=cardStyle.highlightColor;cx.lineWidth=cardStyle.highlightWidth;cx.beginPath();cx.moveTo(28,cardStyle.highlightWidth*1.5);cx.lineTo(484,cardStyle.highlightWidth*1.5);cx.stroke();
  }
  if(cosmic){
   for(let i=0;i<24;i++){cx.fillStyle=`rgba(235,222,255,${.12+(i%4)*.06})`;cx.beginPath();cx.arc(12+(i*81.71)%489,14+(i*i*17.31)%229,i%4===0?1.5:.8,0,Math.PI*2);cx.fill();}
  }
  cx.fillStyle=fg;
  cx.textAlign='center';cx.textBaseline='middle';
  // Fit complete names by measured width, keeping emoji/combining characters intact.
  const label=String(text||'');
  const letters=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(label)].map(x=>x.segment):Array.from(label);
  let size=96,lines=[];
  for(;size>=16;size-=2){
    cx.font=`bold ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
    lines=[];let line='';
    for(const letter of letters){if(line&&cx.measureText(line+letter).width>448){lines.push(line);line=letter;}else line+=letter;}
    if(line)lines.push(line);
    if(lines.length*size*1.18<=200)break;
  }
  const lineHeight=size*1.18;
  lines.forEach((line,i)=>cx.fillText(line,256,128+(i-(lines.length-1)/2)*lineHeight));
  const tex=new THREE.CanvasTexture(cv);
  tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=4;tex.needsUpdate=true;
  tex.userData._cv=cv;
  return tex;
}

/* 星空粒子背景 */
/* 星点粒子已按需求移除 */


/* 爆发粒子使用固定池，重置和配额变化只调整drawRange。 */
const burstCapacity=SHARED_PROFILE.effects.burstParticles;
const burstPositions=new Float32Array(burstCapacity*3),burstVelocities=new Float32Array(burstCapacity*3);
const burstGeometry=new THREE.BufferGeometry();burstGeometry.setAttribute('position',new THREE.BufferAttribute(burstPositions,3));burstGeometry.setDrawRange(0,0);
const burstMaterial=new THREE.PointsMaterial({color:0xffffff,size:.09,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending});
const burst=new THREE.Points(burstGeometry,burstMaterial);burst.frustumCulled=false;burst.visible=false;scene.add(burst);
let burstCount=0,burstLife=0,burstDuration=1,burstActive=false,effectBudgetState={ambient:0,stars:0,burst:0,trail:0,total:0};
function clearBurst(){burstActive=false;burstCount=0;burstLife=0;burstDuration=1;burstGeometry.setDrawRange(0,0);burstMaterial.opacity=0;burstMaterial.size=.09;burst.visible=false;}
function spawnBurst(hex,options=null){
  clearBurst();
  const n=Math.min(effectBudgetState.burst,burstCapacity);if(reduced||n<=0)return;
  const starCapsule=options?.cosmicCapsule&&cosmic&&machineKey==='capsule'&&machine?.winner;
  const reveal=starCapsule?MACHINE_PROFILES.capsule.materials.cosmic.reveal:null;
  burstMaterial.color.setHex(reveal?.burstColor??hex);burstMaterial.opacity=1;
  burstMaterial.size=reveal?.burstSize??.09;
  burstDuration=reveal?.burstDuration??1;
  if(starCapsule){machine.winner.getWorldPosition(burst.position);burst.position.z+=.2;}else resultEffectAnchor(burst.position);
  for(let i=0;i<n;i++){
    const j=i*3;
    if(reveal){
      const angle=Math.random()*Math.PI*2,radius=reveal.burstRadiusMin+Math.random()*(reveal.burstRadiusMax-reveal.burstRadiusMin),outward=.014+Math.random()*.022;
      burstPositions[j]=Math.cos(angle)*radius;burstPositions[j+1]=(Math.random()-.5)*.1;burstPositions[j+2]=Math.sin(angle)*radius;
      burstVelocities[j]=Math.cos(angle)*outward;burstVelocities[j+1]=.018+Math.random()*.032;burstVelocities[j+2]=Math.sin(angle)*outward;
    }else{
      const th=Math.random()*Math.PI*2,ph=Math.acos(2*Math.random()-1),sp=.025+Math.random()*.04;
      burstPositions[j]=burstPositions[j+1]=burstPositions[j+2]=0;
      burstVelocities[j]=Math.sin(ph)*Math.cos(th)*sp;burstVelocities[j+1]=Math.sin(ph)*Math.sin(th)*sp;burstVelocities[j+2]=Math.cos(ph)*sp;
    }
  }
  burstGeometry.attributes.position.needsUpdate=true;burstCount=n;burstLife=0;burstActive=true;
  burstGeometry.setDrawRange(0,n);burst.visible=true;
}

/* ============ Machine 基类 ============ */
class Machine{
  constructor(group){this.group=group;this.items=[];this.spin=0;this.theme=MACHINE_PROFILES.capsule.themes.classic;}
  build(){}
  update(dt,t,spinning){}
  highlight(id){}            // 中奖收束：把 id 对应的物件呈递到中央
  reset(){}
  /* ---- 中奖物脱队悬停 / 归位引擎 ---- */
  _glowMesh(mesh,on){
    if(!mesh||!mesh.traverse)return;
    mesh.traverse(o=>{
      const mats=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
      mats.forEach(mt=>{
        if(!mt||mt.userData?.noWinnerGlow||mt.emissive===undefined)return;
        if(on){
          if(mt.userData._em===undefined){mt.userData._em=mt.emissiveIntensity||0;mt.userData._ec=mt.emissive.getHex();}
          if(mt.emissive.getHex()===0)mt.emissive.copy(mt.color||new THREE.Color(0xffffff)).multiplyScalar(.5);
          mt.emissiveIntensity=Math.max(.12,(mt.userData._em||0)*1.3+.08);
        }else if(mt.userData._em!==undefined){
          mt.emissiveIntensity=mt.userData._em;
          mt.emissive.setHex(mt.userData._ec);
          delete mt.userData._em;delete mt.userData._ec;
        }
      });
    });
  }
  _spotlight(mesh,on){
    if(on){
      if(!this._spot){this._spot=new THREE.PointLight(0xd7efff,.4,9);scene.add(this._spot);}
      this._spot.visible=true;
    }else if(this._spot){
      this._spot.visible=false;
    }
  }
  detachToHover(mesh,opts={}){
    if(this.flying)return;
    this.home={parent:mesh.parent,pos:mesh.position.clone(),quat:mesh.quaternion.clone(),scale:mesh.scale.clone()};
    scene.attach(mesh); // 脱离机台层级，不受转盘旋转影响
    let qTarget=null;
    if(opts.face==='top')qTarget=new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI/2,-(this.home.parent.rotation.y||0),0));
    else if(opts.face==='camera')qTarget=camera.quaternion.clone();
    this.flying={mesh,phase:'out',opts,from:mesh.position.clone(),fromQuat:mesh.quaternion.clone(),fromScale:mesh.scale.x,
      baseScale:opts.capsule?mesh.scale.x:undefined,pathProgress:opts.capsule?0:undefined,
      target:opts.target||new THREE.Vector3(0,1.6,3.0),
      qTarget,scale:opts.scale||2.0,wall0:performance.now()};
    // 中奖聚光：自发光增强 + 跟随点光
    this._glowMesh(mesh,true);
    this._spotlight(null,true);
  }
  clearHoverFx(){}
  beginReturn(){if(this.flying&&this.flying.phase==='out'){
    const f=this.flying;
    if(f.opts.capsule){
      const timing=MACHINE_PROFILES.capsule.timing;
      const sample=f.capsuleSample||capsuleOutSample(performance.now()-f.wall0,{...timing,exitProgress:f.opts.exitProgress});
      f.phase='back';f.returnStartProgress=sample.pathProgress;f.returnStartOpen=sample.open;
      f.returnOffset=f.mesh.position.clone().sub(f.opts.path.getPoint(sample.pathProgress));
      f.returnFromQuat=f.mesh.quaternion.clone();
      this.home.parent.updateWorldMatrix(true,false);
      f.returnTargetQuat=this.home.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(this.home.quat);
      f.capsuleSample=sample;
    }else{
      f.phase='back';f.from=f.mesh.position.clone();f.fromQuat=f.mesh.quaternion.clone();f.fromScale=f.mesh.scale.x;
      f.open=this.winner?.userData.slip?.scale.x||0;
    }
    this._glowMesh(f.mesh,false);this._spotlight(null,false);f.wall0=performance.now();
  }}
  // 立即强制归位（切机台/销毁前调用）
  forceHome(){
    if(!this.flying)return;
    const m=this.flying.mesh;
    this.home.parent.add(m);
    m.position.copy(this.home.pos);m.quaternion.copy(this.home.quat);m.scale.copy(this.home.scale);
    this._glowMesh(m,false);this._spotlight(null,false);
    this.flying=null;this.clearHoverFx();
  }
  updateFly(dt,t){
    const f=this.flying;if(!f)return;const m=f.mesh;
    if(f.opts.capsule){
      const timing=MACHINE_PROFILES.capsule.timing,elapsed=performance.now()-f.wall0;
      if(f.phase==='out'){
        const sample=capsuleOutSample(reduced?timing.openDelayMs+timing.openMs:elapsed,{...timing,exitProgress:f.opts.exitProgress});
        const wasOpen=(f.capsuleSample?.open??0)>0,wasExited=(f.capsuleSample?.pathProgress??0)>=f.opts.exitProgress;
        if(sample.open>0&&!wasOpen){f.capsuleOpenSoundPlayed=true;f.capsuleExitSoundPlayed=true;onSound('capsule-open',1);}
        else if(sample.pathProgress>=f.opts.exitProgress&&!wasExited&&!f.capsuleExitSoundPlayed){f.capsuleExitSoundPlayed=true;onSound('capsule-exit',1);}
        f.capsuleSample=sample;f.pathProgress=sample.pathProgress;
        m.position.copy(f.opts.path.getPoint(sample.pathProgress));m.position.y+=sample.settleY;
        m.scale.setScalar(f.baseScale+(f.scale-f.baseScale)*sample.scaleProgress);
        m.quaternion.copy(f.fromQuat);
        if(f.qTarget)m.quaternion.slerp(f.qTarget,sample.scaleProgress);
        if(f.opts.roll)m.rotateX(-Math.PI*4*smooth(Math.min(1,sample.pathProgress/f.opts.exitProgress)));
        if(this._spot&&this._spot.visible)this._spot.position.copy(m.position).add(new THREE.Vector3(0,.9,.6));
      }else{
        const sample=capsuleReturnSample(elapsed,{
          closeMs:timing.returnCloseMs,travelMs:timing.returnTravelMs,exitProgress:f.opts.exitProgress,
          startProgress:f.returnStartProgress,startOpen:f.returnStartOpen,
        });
        f.capsuleSample=sample;f.pathProgress=sample.pathProgress;
        m.position.copy(f.opts.path.getPoint(sample.pathProgress)).addScaledVector(f.returnOffset,1-sample.returnProgress);
        m.scale.setScalar(f.baseScale+(f.scale-f.baseScale)*sample.scaleProgress);
        m.quaternion.copy(f.returnFromQuat).slerp(f.returnTargetQuat,sample.returnProgress);
        if(sample.done)this.forceHome();
      }
      return;
    }
    // 墙钟确定性进度: 低帧率设备上飞行耗时恒定,不随dt限幅拉长
    const timing=SHARED_PROFILE.timing;
    const wall=Math.max(0,Math.min(1,(performance.now()-f.wall0)/(reduced?timing.reducedFlightMs:f.phase==='out'?(f.opts.duration||timing.winnerFlightMs):timing.returnFlightMs)));
    const ease=smooth(wall);
    if(f.phase==='out'){
      if(f.opts.path){m.position.copy(f.opts.path.getPointAt(ease));}
      else {m.position.lerpVectors(f.from,f.target,ease);m.position.y+=Math.sin(Math.PI*ease)*.48;}
      m.scale.setScalar(f.fromScale+(f.scale-f.fromScale)*smooth(Math.max(0,(wall-(f.opts.scaleStart??.25))/(1-(f.opts.scaleStart??.25)))));
      if(this._spot&&this._spot.visible)this._spot.position.copy(m.position).add(new THREE.Vector3(0,.9,.6));
      if(f.qTarget)m.quaternion.slerpQuaternions(f.fromQuat,f.qTarget,f.opts.roll?smooth(Math.max(0,(wall-.72)/.28)):ease);if(f.opts.roll)m.rotateX(-smooth(Math.min(1,wall/.72))*Math.PI*4);
    }else{
      this.home.parent.updateWorldMatrix(true,false);
      const target=this.home.parent.localToWorld(this.home.pos.clone());
      const targetQuat=this.home.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(this.home.quat);
      m.position.lerpVectors(f.from,target,ease);m.position.y+=Math.sin(Math.PI*ease)*.25;
      m.quaternion.slerpQuaternions(f.fromQuat,targetQuat,ease);
      const targetScale=this.home.parent.getWorldScale(new THREE.Vector3()).x*this.home.scale.x;
      m.scale.setScalar(f.fromScale+(targetScale-f.fromScale)*ease);
      if(wall>=1)this.forceHome();
    }
  }
  dispose(){
    if(this._spot){scene.remove(this._spot);this._spot=null;}
    this.group.traverse(o=>{
      if(o.geometry)o.geometry.dispose();
      if(o.material){const m=Array.isArray(o.material)?o.material:[o.material];
        m.forEach(x=>{x.map&&x.map.dispose&&x.map.dispose();x.dispose&&x.dispose();});}
    });
  }
  setTheme(mk){this.theme=MACHINE_PROFILES[mk]?.themes?.classic||MACHINE_PROFILES.capsule.themes.classic;}
  // 工具：建内容牌/球/签
  makeCardMesh(name){}
}

/* ---- 命运胶囊星球 (capsule | 通用 orbiter) ---- */
class OrbiterMachine extends Machine{
  build(){
    this.setTheme(this.machineKey);
    const th=this.theme;
    this.latMat=new THREE.LineBasicMaterial({color:th.halo,transparent:true,opacity:.22});
    this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.2,3)),this.latMat));
    this.haloMat=new THREE.MeshBasicMaterial({color:th.halo,transparent:true,opacity:.35,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
    const halo=new THREE.Mesh(new THREE.TorusGeometry(2.45,.012,10,140),this.haloMat);
    halo.rotation.x=Math.PI/2.6;halo.rotation.y=.4;this.group.add(halo);
    this.group.scale.setScalar(.85);
    this.rebuild();
  }
  rebuild(){
    (this.items||[]).forEach(c=>{this.group.remove(c);c.geometry.dispose();c.material.dispose();});
    this.items=[];
    const entries=(CURRENT.items||[]).map(i=>({name:i.name,id:i.id})).filter(x=>x.name);
    const n=Math.max(3,entries.length); // 数量与后台选项一致
    for(let i=0;i<n;i++){
      const col=PALETTE[i%PALETTE.length];
      const mat=new THREE.MeshPhysicalMaterial({color:col,roughness:.4,metalness:.15,clearcoat:.3,
        transmission:.35,thickness:.7,ior:1.4,emissive:col,emissiveIntensity:.12,transparent:true,opacity:.96});
      const m=new THREE.Mesh(new THREE.CapsuleGeometry(.16,.42,10,20),mat);
      // 名字标签：浅白底黑字贴在胶囊身（双面，随胶囊转）
      if(entries[i]&&texLabel){
        const tex=texLabel(entries[i].name,'#ededed','#111111');
        const lm=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthTest:true,depthWrite:false});lm.toneMapped=false;
        const lp=new THREE.PlaneGeometry(.34,.13);
        const lf=new THREE.Mesh(lp,lm);lf.position.set(.18,0,0);lf.rotation.y=Math.PI/2;lf.renderOrder=10;m.add(lf);
        const lb=new THREE.Mesh(lp,lm);lb.position.set(-.18,0,0);lb.rotation.y=-Math.PI/2;lb.renderOrder=10;m.add(lb);
      }
      m.userData={a:(i/n)*Math.PI*2,r:1.8+(i%3)*.24,y:(i%5-2)*.3,speed:.3+(i%4)*.1,
        spin:new THREE.Vector3(.02+(i%3)*.01,.013,.008+(i%2)*.005),idx:i,
        name:entries[i]?entries[i].name:'',id:entries[i]?entries[i].id:null};
      this.group.add(m);this.items.push(m);
    }
  }
  update(dt,t,spinning){
    const paused=!!this.flying;
    // 整体缓慢公转（抽取时加速）
    this.group.rotation.y+=spinning?dt*(5+this.spin*8):(paused?dt*.02:dt*.12);
    if(spinning)this.group.rotation.x+=dt*.9; else if(!paused)this.group.rotation.x*=.95;
    if(this.flying){this.updateFly(dt,t);return;}
    // 每个胶囊独立自然漂浮：多样相位/振幅/频率
    this.items.forEach((c,i)=>{
      const u=c.userData;
      u.a+=u.speed*dt*(spinning?5:1);
      const floatY=Math.sin(t*(.8+u.idx*.13)+u.idx)*.28;
      const floatX=Math.cos(t*(.6+u.idx*.11)+u.idx*1.7)*.22;
      const floatZ=Math.sin(t*(.7+u.idx*.09)+u.idx*2.3)*.22;
      const breathe=1+Math.sin(t*1.6+u.idx)*.05;
      c.position.set(Math.cos(u.a)*u.r+floatX,(u.y+floatY)*breathe,Math.sin(u.a)*u.r+floatZ);
      // 多样自转（每轴不同速，带轻微摆动）
      c.rotation.x+=u.spin.x+Math.sin(t+u.idx)*.01;
      c.rotation.y+=u.spin.y;
      c.rotation.z+=u.spin.z||.004;
      c.scale.setScalar(breathe);
    });
    if(this.haloMat)this.haloMat.opacity=(.26+Math.sin(t*1.5)*.14)*(STATE==='reveal'?1.8:1);
    if(this.latMat)this.latMat.opacity=.18+(.26+Math.sin(t*1.5)*.14)*.5;
  }
  highlight(id){
    // 中奖胶囊脱队飞到镜头前悬停（名字标签随行）
    const w=this.items.find(c=>c.userData.id===id)||this.items[0]||null;
    if(!w)return;
    this.winner=w;
    this.detachToHover(w,{target:new THREE.Vector3(0,.8,2.6),scale:2.4}); // spin 默认自转展示玻璃胶囊
  }
  reset(){this.winner=null;}
}

/* ---- 旋转餐桌 / 命运卡牌 / 幸运转盘 (均用卡片环形) ---- */
/* Fixed pointer with a rotating wheel; server-chosen wedge lands at the pointer. */
const WHEEL_CASINO=MACHINE_PROFILES.wheel.materials.sectorPalette;
class WheelMachine extends Machine{
  /* Fixed pointer, rotating enamel sectors and labels. */
  constructor(group){super(group);this.theta=0;this.velocity=0;this.landing=false;this.spin=0;this.ballAngle=0;this.plan=null;this.landDuration=0;this.revealMs=0;this.landT0=0;this.settleProgress=0;this.clickAge=99;this.tickState={sector:null,lastTick:null};this.suppressTickOnce=false;}
  build(){this.rebuild();}
  rebuild(){
    if(this.disk){this.dispose();this.group.remove(this.disk);this.aurora=null;}
    this.disk=new THREE.Group();this.group.add(this.disk);this.rotor=new THREE.Group();this.disk.add(this.rotor);this.items=[];this.flying=null;
    const entries=(CURRENT.items||[]).map(i=>({name:i.name,id:i.id})).filter(x=>x.name);
    const n=Math.max(entries.length,2);this.n=n;
    const radius=2.4;
    // 赌场罗盘配色：深绿/酒红/黑金交替(定义在类外 WHEEL_CASINO, reset也要用)
    const materials=MACHINE_PROFILES.wheel.materials;
    const base=new THREE.Mesh(cosmic?new THREE.CylinderGeometry(2.58,2.58,.13,128):new THREE.CylinderGeometry(radius+.25,radius+.42,.22,64),
      cosmic?new THREE.MeshPhysicalMaterial({color:0x7e9cb9,roughness:.08,metalness:.02,clearcoat:.25,transparent:true,opacity:.025,depthWrite:false,envMapIntensity:.15}):new THREE.MeshStandardMaterial({color:materials.supportColor,roughness:materials.supportRoughness,metalness:materials.supportMetalness}));
    base.position.y=0;base.visible=!cosmic;this.disk.add(base);
    entries.forEach((it,i)=>{
      const a0=(i/n)*Math.PI*2,a1=((i+1)/n)*Math.PI*2;
      const col=WHEEL_CASINO[i%WHEEL_CASINO.length];
      const dense=n>=MACHINE_PROFILES.wheel.denseLabelThreshold;
      const seg=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.06,40,1,false,a0,a1-a0),
      new THREE.MeshPhysicalMaterial({color:col,roughness:materials.sectorRoughness,metalness:materials.sectorMetalness,
          transparent:cosmic,opacity:cosmic?.025:1,depthWrite:!cosmic,
          clearcoat:materials.sectorClearcoat,clearcoatRoughness:materials.sectorClearcoatRoughness,
          envMapIntensity:materials.sectorEnvMapIntensity,specularIntensity:materials.sectorSpecularIntensity,
          emissive:col,emissiveIntensity:materials.sectorEmissiveIntensity,side:THREE.DoubleSide}));
      seg.position.y=.14;seg.material.visible=!cosmic;
      seg.userData={name:it.name,id:it.id,idx:i,aC:(i+.5)/n*Math.PI*2};
      this.rotor.add(seg);this.items.push(seg);
      let labelTexture;
      if(dense){
        const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
        const context=canvas.getContext('2d');
        context.fillStyle=materials.labelBackground;context.fillRect(0,0,256,256);
        context.fillStyle=materials.labelText;context.font='bold 176px system-ui, sans-serif';
        context.textAlign='center';context.textBaseline='middle';context.fillText(String(i+1).padStart(2,'0'),128,128,224);
        labelTexture=new THREE.CanvasTexture(canvas);labelTexture.colorSpace=THREE.SRGBColorSpace;
        labelTexture.anisotropy=4;labelTexture.needsUpdate=true;labelTexture.userData._cv=canvas;
      }else labelTexture=texLabel(it.name,materials.labelBackground,materials.labelText);
      const labelSide=dense?Math.min(MACHINE_PROFILES.wheel.denseLabelMaxSize,MACHINE_PROFILES.wheel.denseLabelScale/n):Math.min(1.1,7/n);
      const label=new THREE.Mesh(new THREE.PlaneGeometry(labelSide,dense?labelSide:.47),new THREE.MeshBasicMaterial({map:labelTexture,transparent:true,depthWrite:false}));
      label.material.toneMapped=false;label.renderOrder=6;label.rotation.x=-Math.PI/2;label.rotation.z=cosmic?seg.userData.aC+Math.PI:-seg.userData.aC;
      const labelRadius=dense?MACHINE_PROFILES.wheel.denseLabelRadius:1.5;
      label.position.set(Math.sin(seg.userData.aC)*labelRadius,.19,Math.cos(seg.userData.aC)*labelRadius);this.rotor.add(label);seg.userData.label=label;
      seg.userData.labelBaseY=label.position.y;
      // 金色分隔钉（赌场罗盘的 metal pins）— 哑光金
      for(const aa of (cosmic?[]:[a0])){
        const pin=new THREE.Mesh(new THREE.SphereGeometry(.07,12,10),
          new THREE.MeshStandardMaterial({color:materials.pinColor,metalness:0,roughness:materials.pinRoughness,emissive:0,emissiveIntensity:0,envMapIntensity:0}));
        pin.position.set(Math.sin(aa)*radius*.96,.2,Math.cos(aa)*radius*.96);this.rotor.add(pin);}
    });
    const rim=new THREE.Mesh(new THREE.TorusGeometry(cosmic?2.51:radius+.08,cosmic?.022:.06,16,160),
      cosmic?new THREE.MeshPhysicalMaterial({color:0xa2c3dd,metalness:.04,roughness:.11,clearcoat:1,transparent:true,opacity:.25,depthWrite:false,envMapIntensity:.45}):new THREE.MeshStandardMaterial({color:materials.rimColor,metalness:materials.rimMetalness,roughness:materials.rimRoughness,envMapIntensity:materials.rimEnvMapIntensity}));
    rim.rotation.x=Math.PI/2;rim.position.y=.16;rim.visible=!cosmic;this.disk.add(rim);
    const hub=new THREE.Mesh(new THREE.CylinderGeometry(.22,.28,.24,32),
    new THREE.MeshStandardMaterial({color:materials.rimColor,metalness:materials.rimMetalness,roughness:materials.rimRoughness,envMapIntensity:materials.rimEnvMapIntensity}));
    hub.position.y=.17;if(!cosmic)this.disk.add(hub);else{hub.geometry.dispose();hub.material.dispose();}
    const pointerShape=cosmic?new THREE.LatheGeometry([new THREE.Vector2(0,-.2),new THREE.Vector2(.035,-.15),new THREE.Vector2(.075,-.05),new THREE.Vector2(.09,.06),new THREE.Vector2(.065,.13),new THREE.Vector2(0,.16)],32):new THREE.ConeGeometry(.16,.42,3);
    this.pointer=new THREE.Mesh(pointerShape,cosmic?new THREE.MeshPhysicalMaterial({color:0xc0e2ed,metalness:0,roughness:.04,transmission:.82,thickness:.18,ior:1.35,clearcoat:.4,transparent:true,opacity:1,depthWrite:false,envMapIntensity:.4,emissive:0x344e73,emissiveIntensity:.06}):new THREE.MeshStandardMaterial({color:materials.pointerColor,metalness:materials.pointerMetalness,roughness:materials.pointerRoughness}));
    this.pointer.position.set(0,cosmic?.25:.4,2.52);this.pointer.rotation.x=cosmic?Math.PI/2:-Math.PI/2;this.disk.add(this.pointer);
    this.trail=[];
    for(let i=0;i<(cosmic?0:MACHINE_PROFILES.wheel.effects.trailCount);i++){const dot=new THREE.Mesh(new THREE.SphereGeometry(.055,8,6),new THREE.MeshBasicMaterial({color:0x89edff,transparent:true,opacity:0,depthWrite:false}));this.disk.add(dot);this.trail.push(dot);}
    // ★ 人眼视角：盘面立起倾斜面向相机（像站在赌桌前看罗盘）
    this.disk.rotation.x=Math.PI/2-1.02;
    this.disk.rotation.y=cosmic?Math.PI:0;
    this.aurora=cosmic?createAuroraWheel(this.disk,this.items):null;
    this.group.position.y=.55;
    this.disk.position.y=0;
  }
  update(dt,t,spinning){
    if(!this.disk)return;
    const timing=MACHINE_PROFILES.wheel.timing;
    const now=performance.now();
    if(spinning){
      const pose=advanceWheelSpin(this.theta,this.velocity,dt,reduced?timing.reducedSpinSpeed:timing.spinSpeed,timing.spinRate);
      this.theta=pose.angle;this.velocity=pose.velocity;this.ballAngle=this.theta;
      this.plan=null;this.landDuration=0;this.revealMs=0;this.landing=false;this.settleProgress=0;
    }else if(this.plan){
      const elapsed=(now-this.landT0)/1000;
      const pose=sampleWheelLanding(elapsed,this.plan);
      this.theta=pose.angle;this.velocity=pose.velocity;this.ballAngle=this.theta;
      this.landing=!pose.done;
      if(pose.done&&this.landedPlan!==this.plan){this.landedPlan=this.plan;onSound('wheel-land',1);}
      this.settleProgress=wheelSettleProgress(elapsed,this.plan.duration,reduced?0:timing.settleSeconds);
    }
    const br=2.49;this.rotor.rotation.y=this.theta;this.pointer.position.y=(cosmic?.25:.4)-(this.press||0)*.06;
    const tick=wheelTick(this.theta,this.n,now/1000,this.tickState,timing.tickIntervalSeconds);
    this.tickState={sector:tick.sector,lastTick:tick.lastTick};
    const suppressTick=this.suppressTickOnce;this.suppressTickOnce=false;
    if(tick.tick&&this.velocity>.05&&!reduced&&!suppressTick){this.clickAge=0;onSound('wheel',this.velocity);}
    else this.clickAge+=dt;
    this.pointer.rotation.z=reduced?0:Math.sin(this.clickAge*40)*Math.exp(-this.clickAge*18)*.1;
    this.trail.forEach((dot,i)=>{const a=this.ballAngle-(i+1)*.045;dot.position.set(Math.cos(a)*br,.3,Math.sin(a)*br);dot.material.opacity=reduced?0:Math.min(1,this.velocity/8)*(1-i/28)*.65;dot.scale.setScalar(1-i/40);});
    for(const sector of this.items){
      const isWinner=sector===this.winner,progress=isWinner?this.settleProgress:0;
      sector.userData.light=isWinner?1:1-.34*this.settleProgress;
      sector.material.color.setHex(WHEEL_CASINO[sector.userData.idx%WHEEL_CASINO.length]).multiplyScalar(sector.userData.light);
      sector.material.emissiveIntensity=MACHINE_PROFILES.wheel.materials.sectorEmissiveIntensity+
        (isWinner?MACHINE_PROFILES.wheel.materials.winnerEmissiveIntensity-MACHINE_PROFILES.wheel.materials.sectorEmissiveIntensity:0)*progress;
      if(isWinner){
        sector.position.y=.14+(.22-.14)*progress;
        sector.userData.label.position.y=sector.userData.labelBaseY+(.22-.14+.015)*progress;
      }
    }
    this.aurora?.update(dt,{velocity:this.velocity,winner:this.winner?.userData.idx??-1,settle:this.settleProgress,reduced});
    if(this.flying)this.updateFly(dt,t);
  }
  highlight(id){
    const w=this.items.find(c=>c.userData.id===id)||this.items[0]||null;
    if(!w)return;
    this.winner=w;
    const timing=MACHINE_PROFILES.wheel.timing;
    this.plan=wheelLandingPlan(this.theta,-w.userData.aC,this.velocity,reduced);
    this.landedPlan=null;
    this.landDuration=this.plan.duration*timing.landingSecondsToMilliseconds;
    this.revealMs=this.landDuration+(reduced?0:timing.settleSeconds*1000);
    this.landT0=performance.now();this.landing=this.plan.duration>0;this.settleProgress=0;
    this.ballAngle=this.theta;
    if(reduced)this.finishPresentation();
  }
  finishPresentation(){
    if(!this.plan)return;
    this.landT0=performance.now()-this.revealMs;this.suppressTickOnce=true;this.clickAge=99;
    this.update(0,performance.now()/1000,false);
  }
  reset(){this.winner=null;this.plan=null;this.landing=false;this.velocity=0;this.ballAngle=this.theta;
    this.landDuration=0;this.revealMs=0;this.landT0=0;this.settleProgress=0;this.clickAge=99;
    this.tickState={sector:null,lastTick:null};this.suppressTickOnce=false;this.pointer.rotation.z=0;this.pointer.position.y=.4;this.rotor.rotation.y=this.theta;
    this.items.forEach(m=>{m.position.y=.14;m.userData.label.position.y=m.userData.labelBaseY;m.userData.light=1;m.material.emissiveIntensity=MACHINE_PROFILES.wheel.materials.sectorEmissiveIntensity;m.material.color.set(WHEEL_CASINO[m.userData.idx%WHEEL_CASINO.length]);m.scale.setScalar(1);});}

}
class RingMachine extends Machine{
  // kind: 'table' UFO筹码桌 | 'card' 筹码卡牌环
  constructor(group,kind){super(group);this.kind=kind;}
  build(){this.rebuild();}
  rebuild(){
    if(this.turn){this.group.remove(this.turn);this.dispose();}
    this.turn=new THREE.Group();this.group.add(this.turn);this.items=[];
    const entries=(CURRENT.items||[]).map(i=>({name:i.name,id:i.id})).filter(x=>x.name);
    const n=Math.max(entries.length,4);
    const radius=this.kind==='table'?Math.min(3.4,1.5+entries.length*.14):2.4;
    entries.forEach((it,i)=>{
      // 苹果风赌场筹码卡（圆角奶白，无描边）
      const chip=makeChip(it.name,this.kind==='table'?.98:.92,this.kind==='table'?.64:.58);
      const a=(i/n)*Math.PI*2;
      if(this.kind==='table'){
        chip.position.set(Math.cos(a)*radius,0,Math.sin(a)*radius);
        // 平躺+朝相机方向倾角约28°
        chip.rotation.y=-a+Math.PI/2;
        chip.rotation.x=.5;
        chip.userData={a,idx:i,name:it.name,id:it.id};
      }else{
        chip.position.set(Math.cos(a)*radius,0,Math.sin(a)*radius);
        chip.rotation.y=-a+Math.PI/2;
        chip.userData={a,idx:i,name:it.name,id:it.id};
      }
      chip.scale.setScalar(1.5);
      this.turn.add(chip);this.items.push(chip);
    });
    const halo=(r,c,y)=>{const h=new THREE.Mesh(new THREE.TorusGeometry(r,.03,8,80),
      new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false}));
      h.rotation.x=Math.PI/2;h.position.y=y;this.group.add(h);};
    if(this.kind==='table'){
      // ★ UFO 半透明底盘（卡片下方）
      const ufo=new THREE.Group();
      const domeMat=new THREE.MeshPhysicalMaterial({color:0xbfeaff,roughness:.2,metalness:0,clearcoat:.3,
        transmission:.9,thickness:.3,ior:1.42,transparent:true,opacity:.3});
      const dome=new THREE.Mesh(new THREE.SphereGeometry(1.5,40,24,0,Math.PI*2,0,Math.PI*.5),domeMat);
      dome.scale.y=.55;dome.position.y=.45;
      const saucer=new THREE.Mesh(new THREE.CylinderGeometry(3.3,2.2,.5,56),
        new THREE.MeshPhysicalMaterial({color:0x8fd8ff,roughness:.2,metalness:.05,clearcoat:.3,
          transmission:.82,thickness:.5,ior:1.4,transparent:true,opacity:.34}));
      const rimL=new THREE.Mesh(new THREE.TorusGeometry(3.3,.05,10,90),
        new THREE.MeshStandardMaterial({color:0x67e8f9,emissive:0x22d3ee,emissiveIntensity:.8,metalness:.5,roughness:.3}));
      rimL.rotation.x=Math.PI/2;
      ufo.add(dome,saucer,rimL);
      ufo.position.y=-1.55;
      this.group.add(ufo);this.ufo=ufo;
      // 底部投影光圈
      halo(2.4,0xa78bfa,-2.9);
      halo(2.8,0x22d3ee,-2.96);
      this.group.position.y=.35;
    }else{
      // 卡牌环：中央悬浮光核 + 线框环（保留）
      // 内核金色发光球（脉冲）
      const gem=new THREE.Mesh(new THREE.SphereGeometry(.34,24,24),
        new THREE.MeshStandardMaterial({color:0xffe9a8,emissive:0xfcd34d,emissiveIntensity:.7}));
      this.group.add(gem);this.gem=gem;
      // 外层线框八面体旋转壳
      const shell=new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.OctahedronGeometry(.58,0)),
        new THREE.LineBasicMaterial({color:0xfcd34d,transparent:true,opacity:.8}));
      this.group.add(shell);this.gemShell=shell;
      const wireMat=new THREE.LineBasicMaterial({color:0x67e8f9,transparent:true,opacity:.7});
      const ringIn=new THREE.LineLoop(wireCircle(1.15),wireMat);ringIn.rotation.x=Math.PI/2;this.group.add(ringIn);
      const ringOut=new THREE.LineLoop(wireCircle(radius+.35),wireMat);ringOut.rotation.x=Math.PI/2;this.group.add(ringOut);
      halo(1.5,0x22d3ee,-2.3);halo(radius*.8,0xa78bfa,-2.36);
      this.group.position.y=.4;
    }
  }
  update(dt,t,spinning){
    if(!this.turn)return;
    const paused=!!this.flying;
    if(this.kind==='card')this.turn.rotation.y+=(spinning?dt*(7+this.spin*11):(paused?.0:dt*.25));
    else this.turn.rotation.y+=(spinning?dt*(7+this.spin*11):(paused?.0:dt*.25));
    if(this.ufo){
      const lift=(STATE==='reveal'&&this.winner)?.9:0;
      this.ufoLift=(this.ufoLift||0)+(lift-(this.ufoLift||0))*.06;
      this.ufo.position.y=-1.55+this.ufoLift+Math.sin(t*1.2)*.1;
      this.ufo.rotation.y+=dt*(spinning?2.2:(this.ufoLift>.05?3.5:.25));
    }
    if(this.gem){this.gem.rotation.y+=dt*.9;
      this.gem.material.emissiveIntensity=.6+.35*Math.sin(t*3);
      this.gem.position.y=Math.sin(t*1.4)*.12;}
    if(this.gemShell){this.gemShell.rotation.y-=dt*.7;this.gemShell.rotation.x+=dt*.4;
      this.gemShell.position.copy(this.gem.position);}
    if(this.flying){this.updateFly(dt,t);return;}
    this.turn.children.forEach((card,i)=>{
      if(this.winner&&card.userData.id===this.winner.userData.id)return;
      if(spinning)card.position.y=(this.kind==='card'?.1:.42)+Math.abs(Math.sin(t*14+i))*.12;
    });
  }
  highlight(id){
    const w=this.turn.children.find(c=>c.userData.id===id)||this.turn.children[0]||null;
    if(!w)return;
    this.winner=w;
    this.detachToHover(w,{target:new THREE.Vector3(0,.9,2.6),scale:2.2,face:'camera'});
  }
  reset(){this.winner=null;}
}

class SticksMachine extends Machine{
  // kind: 'tubes' 全息签筒 | 'egg' 全息扭蛋舱
  constructor(group,kind){super(group);this.kind=kind||'tubes';}
  build(){this.rebuild();}
  rebuild(){
    if(this.sticks){this.group.remove(this.sticks);this.dispose();}
    this.sticks=new THREE.Group();this.group.add(this.sticks);this.items=[];
    const halo=(r,c,y)=>{const h=new THREE.Mesh(new THREE.TorusGeometry(r,.03,8,80),
      new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false}));
      h.rotation.x=Math.PI/2;h.position.y=y;this.group.add(h);};
    if(this.kind==='tubes'){
      // ★ 命运签筒：纯科技线条搭建（无灰底座），签长=筒高*1.3
      const stickLen=2.1;            // 竹签总长
      const tubeH=stickLen/1.3;     // 筒高=签长/1.3 => 签长=筒高*1.3
      const tubeR=1.0;
      const lineMat=new THREE.LineBasicMaterial({color:0x67e8f9,transparent:true,opacity:.7});
      const ringN=4,colN=14;
      for(let r=0;r<=ringN;r++){const yy=-tubeH/2+tubeH*r/ringN;
        const ring=new THREE.LineLoop(wireCircle(tubeR),lineMat);
        ring.rotation.x=Math.PI/2;ring.position.y=yy;this.group.add(ring);}
      for(let cI=0;cI<colN;cI++){const a=cI/colN*Math.PI*2;
        const v=new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(Math.cos(a)*tubeR,-tubeH/2,Math.sin(a)*tubeR),
          new THREE.Vector3(Math.cos(a)*tubeR, tubeH/2,Math.sin(a)*tubeR)]),lineMat);
        this.group.add(v);}
      for(const yy of [-tubeH/2,tubeH/2]){
        const hi=new THREE.Mesh(new THREE.TorusGeometry(tubeR,.04,10,80),
          new THREE.MeshStandardMaterial({color:0x67e8f9,emissive:0x22d3ee,emissiveIntensity:.9,metalness:.3,roughness:.5}));
        hi.rotation.x=Math.PI/2;hi.position.y=yy;this.group.add(hi);}
      const shell=new THREE.Mesh(new THREE.CylinderGeometry(tubeR,tubeR,tubeH,colN,1,true),
        new THREE.MeshPhysicalMaterial({color:0x67e8f9,roughness:.03,metalness:0,transmission:1.0,thickness:.1,ior:1.44,transparent:true,opacity:.05,side:THREE.DoubleSide}));
      this.group.add(shell);
      this.shards=[];
      const inLight=new THREE.PointLight(0x67e8f9,.4,3);inLight.position.set(0,0,0);this.group.add(inLight);
      this.group.scale.setScalar(.82);
      this.group.position.y=-.1;
    } else {
      // ★ 经典彩色扭蛋机：红白机身 + 透明球罩（罩内彩色扭蛋滚动），无文字
      const redMat=new THREE.MeshStandardMaterial({color:0xe23b3b,roughness:.32,metalness:.12,emissive:0x5a0f0f,emissiveIntensity:.28});
      const creamMat=new THREE.MeshStandardMaterial({color:0xffe9d2,roughness:.35,metalness:.05,emissive:0x8a5a30,emissiveIntensity:.22});
      const blueMat=new THREE.MeshStandardMaterial({color:0x2f6fd0,roughness:.35,metalness:.15});
      const base=new THREE.Mesh(new THREE.CylinderGeometry(1.25,1.4,.5,40),redMat);
      base.position.y=-1.55;this.group.add(base);
      const bodyC=new THREE.Mesh(new THREE.CylinderGeometry(1.05,.95,1.7,40),creamMat);
      bodyC.position.y=-.55;this.group.add(bodyC);
      const belt=new THREE.Mesh(new THREE.CylinderGeometry(1.08,1.08,.3,40),redMat);
      belt.position.y=-.55;this.group.add(belt);
      const dome=new THREE.Mesh(new THREE.SphereGeometry(1.5,48,32,0,Math.PI*2,0,Math.PI*.55),
        new THREE.MeshPhysicalMaterial({color:0xffffff,roughness:.25,metalness:0,clearcoat:.3,
          transparent:true,opacity:.16,side:THREE.DoubleSide}));
      dome.position.y=.8;this.group.add(dome);
      const collar=new THREE.Mesh(new THREE.TorusGeometry(1.5,.08,12,64),blueMat);
      collar.rotation.x=Math.PI/2;collar.position.y=.15;this.group.add(collar);
      const knob=new THREE.Mesh(new THREE.SphereGeometry(.26,24,24),
        new THREE.MeshStandardMaterial({color:0xfcd34d,emissive:0xb8860b,emissiveIntensity:.4,metalness:.35,roughness:.5}));
      knob.position.y=2.28;this.group.add(knob);
      // 出蛋口（带黑色翻盖挡片）
      const slot=new THREE.Mesh(new THREE.BoxGeometry(.62,.55,.16),
        new THREE.MeshStandardMaterial({color:0x14161c,roughness:.5,metalness:.2}));
      slot.position.set(0,-1.42,1.02);this.group.add(slot);
      const flap=new THREE.Mesh(new THREE.BoxGeometry(.52,.42,.05),
        new THREE.MeshStandardMaterial({color:0x2a2e38,roughness:.35,metalness:.4}));
      flap.position.set(0,-1.42,1.13);flap.rotation.x=-.18;this.group.add(flap);
      // 出蛋口托盘
      const tray=new THREE.Mesh(new THREE.BoxGeometry(.8,.1,.34),
        new THREE.MeshStandardMaterial({color:0xd64541,roughness:.4}));
      tray.position.set(0,-1.78,1.14);this.group.add(tray);
      // 投币口（机身正面右侧金色小圆）
      const coin=new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.06,20),
        new THREE.MeshStandardMaterial({color:0xfcd34d,metalness:.4,roughness:.5,emissive:0xb8860b,emissiveIntensity:.2}));
      coin.rotation.x=Math.PI/2;coin.position.set(.55,-.75,.98);this.group.add(coin);
      // 底座脚垫
      const footMat=new THREE.MeshStandardMaterial({color:0x14161c,roughness:.6});
      for(const [fx,fz] of [[.95,.95],[-.95,.95],[.95,-.95],[-.95,-.95]]){
        const ft=new THREE.Mesh(new THREE.SphereGeometry(.14,14,10),footMat);
        ft.position.set(fx,-1.82,fz);ft.scale.y=.6;this.group.add(ft);}
      const inLight=new THREE.PointLight(0xffdca8,.35,5);inLight.position.set(0,.9,0);this.group.add(inLight);
      this.group.scale.setScalar(.82);
      this.group.position.y=-.1;
    }
    const names=(CURRENT.items||[]).map(i=>({name:i.name,id:i.id})).filter(x=>x.name).slice(0,16);
    const isEgg=this.kind==='egg';
    names.forEach((it,i)=>{
      const stick=new THREE.Group();
      if(isEgg){
        const col=PALETTE[i%PALETTE.length];
        const capTop=new THREE.Mesh(new THREE.SphereGeometry(.23,20,20,0,Math.PI*2,0,Math.PI/2),
          new THREE.MeshPhysicalMaterial({color:col,roughness:.1,clearcoat:1,transparent:true,opacity:.88,
            emissive:col,emissiveIntensity:.35}));
        capTop.position.y=.05;stick.add(capTop);
        const capBot=new THREE.Mesh(new THREE.SphereGeometry(.23,20,20,0,Math.PI*2,Math.PI/2,Math.PI/2),
          new THREE.MeshPhysicalMaterial({color:0xfff6ea,roughness:.2,clearcoat:.8,transparent:true,opacity:.75}));
        capBot.position.y=.05;stick.add(capBot);
        // 扭蛋无文字，纯彩色跳动
      }else{
        // ★ 3D 竹签：细长圆柱 + 色彩丰富 + 文字贴签身
        const col=PALETTE[i%PALETTE.length];
        const stickLen=2.1;
        const bamboo=new THREE.Group();
        // 签身（细长，略带竹节感）
        const bodyMat=new THREE.MeshStandardMaterial({color:col,roughness:.45,metalness:.05});
        const body=new THREE.Mesh(new THREE.CylinderGeometry(.045,.05,stickLen*.82,12),bodyMat);
        bamboo.add(body);
        // 竹节（两段细环）
        for(const yy of [-stickLen*.2,stickLen*.18]){
          const node=new THREE.Mesh(new THREE.TorusGeometry(.052,.012,8,16),
            new THREE.MeshStandardMaterial({color:0xfff6ea,roughness:.5}));
          node.rotation.x=Math.PI/2;node.position.y=yy;bamboo.add(node);}
        // 顶端红色签头
        const head=new THREE.Mesh(new THREE.CylinderGeometry(.05,.045,.12,12),
          new THREE.MeshStandardMaterial({color:0xd64541,roughness:.4}));
        head.position.y=stickLen*.41;head.scale.y=1.4;bamboo.add(head);
        // 签身不带文字(纯竹签)
        stick.add(bamboo);
      }
      if(isEgg){
        const a=(i/Math.max(names.length,1))*Math.PI*2;
        const rr=.35+(i%4)*.28;
        stick.userData={egg:true,a,r:rr,y:-.45+((i*2)%5)*.34,speed:.4+(i%3)*.18,
          name:it.name,id:it.id,idx:i};
      }else{
        const a=(i/Math.max(names.length,1))*Math.PI*2;
        stick.position.set(Math.cos(a)*.5,(i%3)*.06,Math.sin(a)*.5);
        stick.rotation.z=(Math.random()-.5)*.24;stick.rotation.x=(Math.random()-.5)*.2;
        stick.userData={name:it.name,id:it.id,homeY:stick.position.y,idx:i};
      }
      this.sticks.add(stick);this.items.push(stick);
    });
  }
  update(dt,t,spinning){
    if(!this.sticks)return;
    if(this.kind==='egg'){
      this.sticks.children.forEach(s=>{
        if(this.flying&&this.flying.mesh===s)return;
        const u=s.userData;
        const sp=spinning?7:1;
        u.a+=u.speed*dt*sp;
        const rr=u.r+(spinning?Math.sin(t*6+u.idx*1.7)*.12:0);
        const bounce=spinning?Math.abs(Math.sin(t*9+u.idx*2.1))*.38
                             :Math.sin(t*2+u.idx)*.1;
        s.position.set(Math.cos(u.a)*rr,u.y+bounce,Math.sin(u.a)*rr);
        s.rotation.x+=u.speed*dt*(spinning?22:2.2);
        s.rotation.z+=dt*(spinning?6:.8);
      });
      if(this.flying){this.updateFly(dt,t);return;}
      return;
    }
    this.group.rotation.z=spinning?Math.sin(t*8)*.05:this.group.rotation.z*.9;
    if(this.shards)this.shards.forEach((sh,k)=>{const a=t*.5+k/10*Math.PI*2;
      sh.position.set(Math.cos(a)*1.5,Math.sin(t*1.1+k)*.9-.2,Math.sin(a)*1.5);
      sh.rotation.y+=dt*2;sh.rotation.x+=dt;});
    if(this.flying){this.updateFly(dt,t);return;}
    this.sticks.children.forEach((s,i)=>{
      const target=this.winner&&s.userData.id===this.winner.userData.id?s.userData.homeY+1.6:s.userData.homeY;
      if(STATE==='reveal'&&this.winner&&s.userData.id===this.winner.userData.id){
        s.position.y+=dt*1.6; s.rotation.z*=.9;
      } else {
        if(spinning){
          s.position.y=s.userData.homeY+Math.abs(Math.sin(t*16+i*2))*.22;
          s.rotation.z=Math.sin(t*17+i*1.7)*.14;
        }
        else {s.position.y+=(target-s.position.y)*.1;s.rotation.z*=.92;}
        s.rotation.z+=(Math.sin(t+i)*.002);
      }
    });
  }
  highlight(id){
    const w=this.sticks.children.find(s=>s.userData.id===id)||this.sticks.children[0]||null;
    if(!w)return;this.winner=w;
    this.detachToHover(w,{target:new THREE.Vector3(0,1.1,2.6),scale:this.kind==='egg'?2.2:2.0});
  }
  reset(){this.winner=null;}
}

class SlotMachine extends Machine{
  /* ★ 三列瀑布流：无外壳，纯筹码卡滚动 */
  constructor(group){super(group);}
  build(){this.rebuild();}
  rebuild(){
    if(this.reels){this.group.remove(this.reels);this.dispose();}
    this.reels=new THREE.Group();this.group.add(this.reels);this.items=[];this.cols=[];
    const names=(CURRENT.items||[]).map(i=>({name:i.name,id:i.id})).filter(x=>x.name);
    const ncol=3, perCol=8;
    for(let c=0;c<ncol;c++){
      const col=new THREE.Group();
      const colNames=[];for(let k=0;k<perCol;k++){const it=names[(c*3+k)%Math.max(names.length,1)];colNames.push(it);}
      colNames.forEach((it,k)=>{
        const chip=makeChip(it.name,.95,.95);
        chip.position.set(0,(perCol/2-k)*1.0,0);
        chip.userData={name:it.name,id:it.id,k};
        col.add(chip);this.items.push(chip);
      });
      col.position.x=(c-1)*1.1;
      this.reels.add(col);this.cols.push(col);
    }
    this.anims=this.cols.map(()=>0);
    this.group.position.y=.8;
  }
  update(dt,t,spinning){
    if(!this.reels)return;
    const now=performance.now();
    this.cols.forEach((col,ci)=>{
      // 刹车：spinning 结束后各列延迟 ci*0.4s 停，带回弹
      let speed=0,bounce=0;
      if(spinning){speed=this.spin*(ci+1);}
      else{
        const since=this.stopT0?now-this.stopT0-ci*400:9999;
        if(since<0){speed=this.spin*(ci+1);}          // 还没轮到：继续转
        else if(since<450){const k=since/450;         // 回弹缓停
          bounce=Math.sin(k*Math.PI*2)*(1-k)*.18;
        }else{bounce=0;}
      }
      this.anims[ci]=(this.anims[ci]+speed*dt)%1;
      col.children.forEach(card=>{
        if(card.userData.k===undefined)return;
        card.position.y=((card.userData.k)-this.anims[ci]*8 + 40)%8 - 4 + 1.5+bounce;});
      // 中奖行金框：reveal 且该列已停
      col.children.forEach(card=>{
        if(card.userData.k===undefined)return;
        card.scale.setScalar(1);
        if(!spinning&&this.winner&&card.userData.id===this.winner.userData.id)
          card.scale.setScalar(1.12+.04*Math.sin(t*6));
      });
    });
    if(!spinning&&!this.stopT0)this.stopT0=performance.now();
    if(spinning)this.stopT0=null;
  }
  highlight(id){
    this.winner=this.items.find(c=>c.userData.id===id)||null;
  }
  reset(){this.winner=null;this.stopT0=null;}
  reset2(){this.stopT0=null;}
}

/* 工具：水平圆环点集 */
function wireCircle(r,segs=96){
  const pts=[];
  for(let i=0;i<=segs;i++){const a=i/segs*Math.PI*2;pts.push(new THREE.Vector3(Math.cos(a)*r,Math.sin(a)*r,0));}
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/* ============ 机台工厂 ============ */
let machineGroup=new THREE.Group();scene.add(machineGroup);
let resultDeck=null;
let machine=null,machineKey='capsule',machineBounds=null,machineFitPoints=null,resultBounds=null,cameraFitCache=null;
let resultSnapshot=null,resultKind=null,resultPage=0,resultPageMeta=null,resultOriginsSnapshot=new Map();
let lastEffectInputs=null;
const effectAnchor=new THREE.Vector3();
function resultEffectAnchor(target){
 const source=groupAnimation?null:machineKey==='wheel'?machine?.winner?.userData.label:machine?.winner;
 return source?.parent?source.getWorldPosition(target):target.set(0,.55,2.8);
}
function currentRevealDuration(){
 return reduced?0:groupAnimation?SHARED_PROFILE.timing.groupRevealDelayMs:machineKey==='wheel'?machine?.revealMs||0:machineKey==='capsule'?MACHINE_PROFILES.capsule.timing.revealDelayMs:machine?.revealMs||2000;
}
function decorationPhase(){return STATE==='reveal'&&performance.now()>=decorationUntil?'idle':STATE;}
function syncEffectBudget(){
 const inputs={width:mount.clientWidth,quality,cosmic,machine:machineKey,phase:decorationPhase(),reduced};
 if(lastEffectInputs&&Object.keys(inputs).every(key=>Object.is(inputs[key],lastEffectInputs[key])))return;
 lastEffectInputs=inputs;
 effectBudgetState=effectBudget(inputs);
 if(cosmic&&!reduced&&machineKey!=='capsule'){effectBudgetState.stars=mount.clientWidth<600?80:160;effectBudgetState.total+=effectBudgetState.stars;}
 effects.budget(effectBudgetState);
 starsGeo.setDrawRange(0,effectBudgetState.stars);
 cosmicStars.visible=effectBudgetState.stars>0;
 const activeBurstCount=burstActive?Math.min(effectBudgetState.burst,burstCount):0;
 burstGeometry.setDrawRange(0,activeBurstCount);
 burst.visible=activeBurstCount>0&&!reduced;
}
const hiddenSphereIds=new Set();
function resultOrigins(){const origins=new Map();machine?.items.forEach(item=>origins.set(item.userData.id,item.getWorldPosition(new THREE.Vector3())));return origins;}
function restoreResultSources(){
 if(machineKey==='sphere'&&machine)for(const item of machine.items){if(hiddenSphereIds.has(item.userData.id))item.visible=true;}
 hiddenSphereIds.clear();
}
function clearResultDeck(){restoreResultSources();if(resultDeck){disposeGroup(resultDeck);scene.remove(resultDeck);resultDeck=null;}}
function dispatchResultPage(info){mount.dispatchEvent(new CustomEvent('resultpagechange',{detail:info?{...info}:null}));}
function clearResultSnapshot(){
 const hadSnapshot=!!resultSnapshot;clearResultDeck();groupAnimation=null;resultBounds=null;
 resultSnapshot=null;resultKind=null;resultPage=0;resultPageMeta=null;resultOriginsSnapshot.clear();
 if(hadSnapshot)dispatchResultPage(null);
}
function saveResultSnapshot(kind,items,origins=new Map()){
 resultKind=kind;
 resultSnapshot=kind==='groups'
  ?items.map(group=>group.map(item=>({...item})))
  :items.map(item=>({...item}));
 resultOriginsSnapshot=new Map([...origins].map(([id,point])=>[id,point.clone()]));
 resultPage=0;resultPageMeta=null;
}
function disposeMachine(){clearResultDeck();wheelCandidateKey?.destroy();wheelCandidateKey=null;if(machine){machine.forceHome();machine.dispose();}disposeGroup(machineGroup);scene.remove(machineGroup);machineGroup=new THREE.Group();scene.add(machineGroup);machine=null;}
function disposeGroup(g){g.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material){const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(x=>{x.map&&x.map.dispose&&x.map.dispose();x.dispose&&x.dispose();});}});}

function boxRecord(box){
 if(box.isEmpty())return null;
 const min=box.min.toArray(),max=box.max.toArray();
 return min.concat(max).every(Number.isFinite)?{min,max}:null;
}
function unionBounds(a,b){
 if(!a)return b?{min:[...b.min],max:[...b.max]}:null;
 if(!b)return {min:[...a.min],max:[...a.max]};
 return {min:a.min.map((v,i)=>Math.min(v,b.min[i])),max:a.max.map((v,i)=>Math.max(v,b.max[i]))};
}
function measureMachineBounds(){
 machineFitPoints=null;
 const scale=machineGroup.scale.x;
 if(machineKey==='sphere'){
  const layout=nameSphereLayout(CURRENT.items.length),profile=SHARED_PROFILE.camera;
  const positionRadius=Math.max(profile.sphereLayoutRadius,...layout.map(slot=>Math.hypot(slot.x,slot.y,slot.z)));
  const maxCardScale=Math.max(0,...layout.map(slot=>slot.size));
  const cardRadius=Math.hypot(MACHINE_PROFILES.sphere.camera.nameCard.width/2,MACHINE_PROFILES.sphere.camera.nameCard.height/2)*maxCardScale;
  const radius=(positionRadius+cardRadius)*scale;
  machineBounds={min:[-radius,-radius,-radius],max:[radius,radius,radius]};
  return;
 }
 machineGroup.updateMatrixWorld(true);
 const measured=boxRecord(new THREE.Box3().setFromObject(machineGroup));
 machineBounds=measured||{min:[-1,-1,-1],max:[1,1,1]};
 if(machineKey==='wheel'){
  // Cache actual disk vertices once. An axis-aligned box contains large empty
  // corners around this tilted, shallow shape and makes the disk look tiny.
  const points=[],point=new THREE.Vector3();
  machineGroup.traverse(object=>{
   const positions=object.geometry?.attributes?.position;
   if(!positions||!object.visible)return;
   for(let i=0;i<positions.count;i++){
    point.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld);
    points.push(point.toArray());
   }
  });
  machineFitPoints=points.length?points:null;
 }
}
function fitWithFill(bounds,aspect,fill){
 if(!bounds||!Number.isFinite(aspect)||aspect<=0)return null;
 const profile=SHARED_PROFILE.camera;
 const padding=profile.fitPadding;
 return fitCamera({bounds,aspect,fov:viewport.fov,pitch:profile.pitch,fill,padding});
}
function setFitDistance(fit,distance){
 const direction=fit.position.map((v,i)=>(v-fit.target[i])/fit.distance);
 return {...fit,distance,position:fit.target.map((v,i)=>v+direction[i]*distance)};
}
function shiftedMachineBounds(){
 if(!machineBounds||!machine||machineKey!=='sphere'||!groupAnimation)return null;
 const scale=.68/MACHINE_PROFILES.sphere.camera.scale,z=-2;
 return {min:machineBounds.min.map((v,i)=>v*scale+(i===2?z:0)),max:machineBounds.max.map((v,i)=>v*scale+(i===2?z:0))};
}
function refreshCameraFits(immediate=false){
 if(!machineBounds)return;
 const aspect=viewport.aspect,profile=SHARED_PROFILE.camera;
 const options={aspect,fov:viewport.fov,pitch:profile.pitch,fill:profile.surfaceFill,padding:profile.fitPadding};
 const idle=machineKey==='sphere'
  ?fitSphereCamera({...options,fill:framingFill(MACHINE_PROFILES.sphere.camera.sphereFill,stageFraming),radius:machineBounds.max[0]})
  :machineFitPoints?fitCameraPoints({...options,fill:framingFill(MACHINE_PROFILES.wheel.camera.diskFill,stageFraming),bounds:machineBounds,points:machineFitPoints})
  :fitWithFill(machineBounds,aspect,framingFill(profile.idleFill,stageFraming));
 let results=null;
 if(resultBounds){
  const bounds=unionBounds(machineBounds,resultBounds);
  const shifted=shiftedMachineBounds();
  results=fitWithFill(shifted?unionBounds(bounds,shifted):bounds,aspect,profile.resultFill);
  if(results&&idle&&results.distance<idle.distance)results=setFitDistance(results,idle.distance);
 }
 cameraFitCache={aspect,idle,results};
 if(immediate)applyCameraFitNow();
}
function currentCameraPose(now=performance.now()){
 const cache=cameraFitCache;
 if(!cache)return null;
 const fit=resultBounds?cache.results:cache.idle;
 if(!fit)return null;
 const profile=SHARED_PROFILE.camera,revealFocus=STATE==='reveal'?Math.max(0,1-(now-revealStart)/4500):0;
 const simplified=reduced;
 const reserve=simplified?profile.maxPushDistance:profile.maxPushDistance-(STATE==='spin'?profile.spinPushDistance:STATE==='reveal'?profile.maxPushDistance*revealFocus:0);
 const orbit=!simplified&&STATE==='spin'?Math.sin((now-spinStart)/1500)*.55:0;
 const clamp=(v,max)=>Math.max(-max,Math.min(max,v));
 const distance=Math.max(.1,fit.distance+reserve+(simplified?0:press*profile.pressOffset));
 const direction=fit.position.map((v,i)=>(v-fit.target[i])/fit.distance);
 return {
  target:fit.target,
  position:[fit.target[0]+direction[0]*distance+clamp(dragAngle*3+orbit,profile.maxSideOffset),
   fit.target[1]+direction[1]*distance+clamp(dragElevation*3,profile.maxVerticalOffset),
   fit.target[2]+direction[2]*distance],
 };
}
function applyCameraFitNow(){
 const pose=currentCameraPose();
 if(!pose)return;
 camera.position.fromArray(pose.position);cameraAim.fromArray(pose.target);camera.lookAt(cameraAim);
}
function cardRadius(mesh){
 mesh.updateWorldMatrix(true,true);
 const bounds=new THREE.Box3().setFromObject(mesh);
 if(bounds.isEmpty())return 0;
 const sphere=bounds.getBoundingSphere(new THREE.Sphere());
 return {radius:sphere.radius,center:sphere.center,origin:mesh.getWorldPosition(new THREE.Vector3())};
}
function resultDeckBounds(cards=[]){
 if(!resultDeck)return null;
 resultDeck.updateWorldMatrix(true,true);
 const box=new THREE.Box3().setFromObject(resultDeck);
 for(const card of cards){
  const shape=cardRadius(card.mesh);if(!shape)continue;
  const target=card.to.clone().add(shape.center.clone().sub(shape.origin));
  const radius=shape.radius;
  box.expandByPoint(new THREE.Vector3(target.x-radius,target.y-radius,target.z-radius));
  box.expandByPoint(new THREE.Vector3(target.x+radius,target.y+radius+.35,target.z+radius));
 }
 return boxRecord(box);
}
function resultPageInfo(){return resultPageMeta?{...resultPageMeta}:null;}
function hideSphereSource(id){
 if(machineKey!=='sphere'||!machine)return;
 const source=machine.items.find(item=>item.userData.id===id);
 if(source){source.visible=false;hiddenSphereIds.add(id);}
}
function layoutResultPage(page,{animate=false,animationStart=null,notify=true}={}){
 if(!resultSnapshot)return null;
 const pageData=paginateResults(resultSnapshot,page,resultPageSize(Math.max(0,mount.clientWidth)));
 if(resultPageMeta&&pageData.page===resultPageMeta.page&&pageData.pageSize===resultPageMeta.pageSize){return resultPageInfo();}
 resultPage=pageData.page;
 resultPageMeta={kind:resultKind,page:pageData.page,pageSize:pageData.pageSize,pageCount:pageData.pageCount,
  total:pageData.total,start:pageData.start,end:pageData.end};
 if(resultKind==='results'&&resultSnapshot.length===1){
  if(notify)dispatchResultPage(resultPageInfo());
  return resultPageInfo();
 }
 if(pageData.total===0){clearResultDeck();groupAnimation=null;resultBounds=null;if(notify)dispatchResultPage(resultPageInfo());return resultPageInfo();}

 clearResultDeck();groupAnimation=null;resultBounds=null;resultDeck=new THREE.Group();scene.add(resultDeck);
 const cards=[];
 if(resultKind==='results'){
  const shown=pageData.items,narrow=pageData.pageSize===6,cols=Math.min(narrow?2:4,shown.length),rows=Math.ceil(shown.length/Math.max(1,cols));
  shown.forEach((item,index)=>{
   const mesh=makeChip(item.name,1.1,.68,item.id);resultDeck.add(mesh);hideSphereSource(item.id);
   const from=resultOriginsSnapshot.get(item.id)?.clone()||new THREE.Vector3(0,0,-.5);
   const to=new THREE.Vector3((index%cols-(cols-1)/2)*1.3,(rows-1)/2-Math.floor(index/cols),1);
   if(!animate){mesh.position.copy(to);mesh.quaternion.copy(camera.quaternion);}
   else mesh.position.copy(from);
   cards.push({mesh,from:animate?from:to.clone(),to});
  });
 }else{
  const visible=pageData.items,narrow=pageData.pageSize===6,cols=Math.min(narrow?2:4,visible.length);
  visible.forEach((members,index)=>{
   const groupNumber=pageData.start+index+1;
   const x=(index%cols-(cols-1)/2)*1.8,y=1.4-Math.floor(index/cols)*2.45;
   const tray=new THREE.Mesh(new THREE.BoxGeometry(1.35,.08,.8),new THREE.MeshStandardMaterial({color:PALETTE[(groupNumber-1)%PALETTE.length],metalness:.4,roughness:.35}));
   tray.position.set(x,y-1.03,0);resultDeck.add(tray);
   const previewCount=Math.min(6,members.length);
   const labelText=`第 ${groupNumber} 组 · ${members.length} 人 · 预览 ${previewCount}/${members.length}`;
   const label=new THREE.Sprite(new THREE.SpriteMaterial({map:texLabel(labelText,'#172019','#d0ffad'),depthTest:false}));
   label.position.set(x,y-1.32,0);label.scale.set(1.6,.52,1);resultDeck.add(label);
   members.slice(0,6).forEach((entry,memberIndex)=>{
    const mesh=makeChip(entry.name,.62,.32,entry.id);resultDeck.add(mesh);hideSphereSource(entry.id);
    const from=resultOriginsSnapshot.get(entry.id)?.clone()||new THREE.Vector3(0,0,-.5);
    const to=new THREE.Vector3(x+(memberIndex%2-.5)*.68,y-Math.floor(memberIndex/2)*.4,.4);
    if(!animate){mesh.position.copy(to);mesh.quaternion.copy(camera.quaternion);}
    else mesh.position.copy(from);
    cards.push({mesh,from:animate?from:to.clone(),to});
   });
  });
  visible.forEach((members,index)=>{
   const x=(index%cols-(cols-1)/2)*1.8,y=1.4-Math.floor(index/cols)*2.45;
   resultBounds=unionBounds(resultBounds,{min:[x-.8,y-1.58,-.02],max:[x+.8,y-1.06,.02]});
  });
 }
 groupAnimation={start:animate?(animationStart??performance.now()):performance.now()-10000,cards};
 resultBounds=unionBounds(resultBounds,resultDeckBounds(cards));
 refreshCameraFits(false);
 if(notify)dispatchResultPage(resultPageInfo());
 return resultPageInfo();
}
function reflowResultPage(){
 if(!resultSnapshot||!resultPageMeta)return null;
 const nextSize=resultPageSize(Math.max(0,mount.clientWidth));
 if(nextSize===resultPageMeta.pageSize)return null;
 const firstVisible=resultPageMeta.start;
 const nextPage=Math.floor(firstVisible/nextSize),now=performance.now();
 const animationStart=groupAnimation?.start??null;
 const stillAnimating=!!groupAnimation&&!reduced&&now-animationStart<2500;
 return layoutResultPage(nextPage,{animate:stillAnimating,animationStart,notify:false});
}
function singleResultBounds(key){
 const profile=MACHINE_PROFILES[key]?.camera?.singleResult;
 if(!profile)return null;
 const target=profile.target,scale=profile.scale;
 if(key==='capsule'){
  const radius=Math.max(profile.depthRadius,Math.hypot(profile.halfWidth,profile.halfHeight))*scale;
  return {min:[target[0]-radius,target[1]-radius-profile.openBottom*scale,target[2]-radius],
   max:[target[0]+radius,target[1]+radius+profile.openTop*scale,target[2]+radius]};
 }
 const card=MACHINE_PROFILES.sphere.camera.nameCard;
 const radius=Math.hypot(card.width,card.height)*scale/2;
 return {min:[target[0]-radius,target[1]-radius,target[2]-radius],
  max:[target[0]+radius,target[1]+radius+profile.flightArch,target[2]+radius]};
}

function makeMachine(key){
  machineKey=key||'capsule';
  // 类型 → 默认机台
  let cls;
  switch(machineKey){
    case 'slot': cls=SlotMachine;break;
    case 'egg': cls=SticksMachine;break;   // egg 用签筒变体
    case 'card': cls=RingMachine;break;
    case 'wheel': cls=WheelMachine;break;  // 真·指针转盘
    case 'tubes': cls=SticksMachine;break;
    case 'table': cls=RingMachine;break;
    default: cls=OrbiterMachine;
  }
  const inst=new cls(machineGroup,machineKey==='egg'?'egg':(machineKey==='card'||machineKey==='wheel'?'card':(machineKey==='tubes'?'tubes':undefined)));
  inst.machineKey=machineKey;
  if(inst instanceof RingMachine)inst.kind=(machineKey==='wheel'?'wheel':(machineKey==='card'?'card':'table'));
  if(inst instanceof SticksMachine)inst.kind=(machineKey==='egg'?'egg':'tubes');
  inst.build();
  return inst;
}

class NameSphere extends Machine {
 build(){this.velocity=0;this.batches=[];this.items=[];
  const layout=nameSphereLayout(CURRENT.items.length);
  // Atlas + instancing keeps all names visible without thousands of draw calls.
  for(let start=0;start<CURRENT.items.length;start+=128){
   const entries=CURRENT.items.slice(start,start+128),canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1280;
   const cx=canvas.getContext('2d'),offsets=new Float32Array(entries.length*2);
   entries.forEach((entry,j)=>{
    const x=j%8*128,y=Math.floor(j/8)*80,appearance=cardAppearance(entry.id);
    cx.save();roundRect(cx,x+3,y+3,122,74,10);cx.clip();
    cx.fillStyle=appearance.bodyColor.getStyle();cx.fillRect(x,y,128,80);
    const label=texLabel(entry.name,appearance.gradient,appearance.textColor,{
     edgeColor:appearance.edgeColor,edgeWidth:appearance.profile.edgeWidth,
     highlightColor:appearance.highlightColor,highlightWidth:appearance.profile.topHighlightWidth,
    });cx.drawImage(label.image,x+5,y+8,118,64);label.dispose();
    const rim=MACHINE_PROFILES.sphere.materials.atlasRim;cx.save();cx.globalAlpha=rim.alpha;
    const gradient=cx.createLinearGradient(x+rim.inset,y+rim.inset,x+rim.inset+rim.width,y+rim.inset+rim.height);
    rim.colors.forEach((color,index)=>gradient.addColorStop(rim.stops[index],color));
    cx.strokeStyle=gradient;cx.lineWidth=rim.lineWidth;roundRect(cx,x+rim.inset,y+rim.inset,rim.width,rim.height,rim.radius);cx.stroke();cx.restore();
    cx.restore();
    offsets[j*2]=j%8;offsets[j*2+1]=15-Math.floor(j/8);
    const card=new THREE.Group(),slot=layout[start+j];card.position.set(slot.x,slot.y,slot.z);card.scale.setScalar(slot.size);
    card.userData={id:entry.id,name:entry.name,batch:this.batches.length,index:j};this.items.push(card);this.group.add(card);
   });
   const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
   const geometry=new THREE.PlaneGeometry(.95,.56);geometry.setAttribute('nameUv',new THREE.InstancedBufferAttribute(offsets,2));
   const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.1,side:THREE.DoubleSide,toneMapped:false});
   material.onBeforeCompile=shader=>{shader.vertexShader='attribute vec2 nameUv;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\n vMapUv=(vMapUv+nameUv)/vec2(8.0,16.0);');};
   const batch=new THREE.InstancedMesh(geometry,material,entries.length);batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);batch.frustumCulled=false;this.batches.push(batch);this.group.add(batch);
  }
  this.dummy=new THREE.Object3D();this.tint=new THREE.Color();
  this.cameraWorldPosition=new THREE.Vector3();this.cameraDirection=new THREE.Vector3();this.cardDirection=new THREE.Vector3();
  this.update(0,0,false);
 }
 update(dt,t,spinning){
 if(this.align){const a=this.align,elapsed=reduced?a.plan.duration:(performance.now()-a.start)/1000,sample=sampleSphereLanding(elapsed,a.plan);this.group.rotation.y=sample.angle;this.velocity=sample.velocity;
  if(sample.done){this.align=null;this.detachToHover(this.winner,{target:new THREE.Vector3(0,.55,2.8),scale:2,face:'camera',duration:MACHINE_PROFILES.sphere.timing.revealFlightMs});onSound('sphere-land',1);}
 }else{
  if(reduced)this.velocity=0;
  else{const motion=MACHINE_PROFILES.sphere.motion,target=spinning?motion.spinSpeed:this.flying?motion.resultSpeed:motion.idleSpeed;this.velocity=damp(this.velocity,target,spinning?motion.spinDamping:motion.idleDamping,dt);}
  this.group.rotation.y+=dt*this.velocity;
 }

 this.group.updateWorldMatrix(true,false);camera.getWorldPosition(this.cameraWorldPosition);
 this.cameraDirection.copy(this.group.worldToLocal(this.cameraWorldPosition)).normalize();
 const facing=this.group.quaternion.clone().invert().multiply(camera.quaternion);
 const sphereMaterials=MACHINE_PROFILES.sphere.materials;
 for(const card of this.items){
  const detached=card===this.winner&&this.flying;
  if(!detached)card.quaternion.copy(facing);
  if(!detached){
   this.cardDirection.copy(card.position).normalize();
   const front=Math.max(0,Math.min(1,(this.cardDirection.dot(this.cameraDirection)+1)/2));
   const depth=front*front*(3-2*front);
   const brightness=(sphereMaterials.frontBrightnessFloor+(1-sphereMaterials.frontBrightnessFloor)*depth)*(this.winner&&card!==this.winner?sphereMaterials.winnerOtherBrightness:1);
   card.userData.light=damp(card.userData.light??1,brightness,3,dt);
  }
  const batch=this.batches[card.userData.batch];
  this.dummy.position.copy(card.position);this.dummy.quaternion.copy(card.quaternion);
  this.dummy.scale.copy(card.scale);if(!card.visible||card.children.length||detached)this.dummy.scale.setScalar(0);
  this.dummy.updateMatrix();batch.setMatrixAt(card.userData.index,this.dummy.matrix);
  if(!detached)batch.setColorAt(card.userData.index,this.tint.setScalar(card.userData.light));
 }
 for(const batch of this.batches){batch.instanceMatrix.needsUpdate=true;if(batch.instanceColor)batch.instanceColor.needsUpdate=true;}
 if(spinning&&Math.floor(t*2)!==this.noteBeat){this.noteBeat=Math.floor(t*2);onSound('sphere',this.velocity);}
 if(this.flying)this.updateFly(dt,t);
 }
 highlight(id){const card=this.items.find(i=>i.userData.id===id);if(!card)return;this.winner=card;card.add(makeChip(card.userData.name,.95,.56,card.userData.id));
 const motion=MACHINE_PROFILES.sphere.motion,plan=sphereLandingPlan(this.group.rotation.y,-Math.atan2(card.position.x,card.position.z),this.velocity,{reduced,minCoastSeconds:motion.minCoastSeconds,slowThreshold:motion.slowThreshold,slowDuration:motion.slowDuration});
 this.align={plan,start:performance.now()};this.revealMs=plan.duration*1000+MACHINE_PROFILES.sphere.timing.revealDelayTailMs;
 }
 dispose(){for(const batch of this.batches)batch.dispose();super.dispose();}
 reset(){this.winner=null;this.align=null;for(const card of this.items){for(const child of [...card.children]){disposeGroup(child);card.remove(child);}card.visible=true;}}

}
class CapsuleMachine extends Machine {
 build(){
  const profile=MACHINE_PROFILES.capsule.materials,theme=profile[cosmic?'cosmic':'classic'];
  this.seamArcBinding=null;this.seamArcMats=[];
  if(cosmic){
   const reveal=theme.reveal;this.seamArcs=new THREE.Group();this.seamArcs.name='cosmic-capsule-seam-arcs';
   for(let i=0;i<3;i++){
    const material=new THREE.MeshBasicMaterial({color:reveal.seamArcColor,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide});
    const arc=new THREE.Mesh(new THREE.TorusGeometry(reveal.seamArcRadius,reveal.seamArcTube,4,20,reveal.seamArcLength),material);
    arc.rotation.x=Math.PI/2;arc.rotation.y=i*Math.PI*2/3;arc.visible=false;this.seamArcs.add(arc);this.seamArcMats.push(material);
   }
   this.group.add(this.seamArcs);
  }
  const accent=theme.accent,metal=cosmic?new THREE.MeshPhysicalMaterial({color:theme.shell,metalness:theme.shellMetalness,roughness:theme.shellRoughness,clearcoat:theme.shellClearcoat,clearcoatRoughness:theme.shellClearcoatRoughness}):new THREE.MeshStandardMaterial({color:theme.shell,metalness:profile.classicShellMetalness,roughness:profile.classicShellRoughness});
  const structure=cosmic?new THREE.MeshPhysicalMaterial({color:theme.structureColor,metalness:theme.structureMetalness,roughness:theme.structureRoughness,clearcoat:theme.structureClearcoat,iridescence:theme.structureIridescence,iridescenceIOR:1.3,iridescenceThicknessRange:[100,260]}):new THREE.MeshStandardMaterial({color:profile.structureColor,metalness:profile.structureMetalness,roughness:profile.structureRoughness});
  const accentMaterial=cosmic?new THREE.MeshPhysicalMaterial({color:accent,metalness:theme.accentMetalness,roughness:theme.accentRoughness,clearcoat:theme.accentClearcoat}):null;
  const add=(geometry,material,x,y,z)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);this.group.add(mesh);return mesh;};
  add(new THREE.CylinderGeometry(1.25,1.45,1.45,64),metal,0,-1.38,0);
  for(const y of [-2.08,-.72]){const ring=add(new THREE.TorusGeometry(1.26,.045,10,96),cosmic?accentMaterial:structure,0,y,0);ring.rotation.x=Math.PI/2;}
  add(new THREE.SphereGeometry(1.75,48,32),new THREE.MeshPhysicalMaterial({color:profile.glassColor,transparent:true,opacity:cosmic?profile.glassOpacity:theme.glassOpacity,roughness:profile.glassRoughness,metalness:profile.glassMetalness,envMapIntensity:profile.glassEnvMapIntensity,specularIntensity:profile.glassSpecularIntensity,side:THREE.FrontSide,depthWrite:false}),0,.78,0);
  const rim=add(new THREE.TorusGeometry(1.45,.09,12,96),structure,0,-.14,0);rim.rotation.x=Math.PI/2;
  add(new THREE.CylinderGeometry(.4,.48,.18,40),structure,0,2.49,0);
  // Paired structural rails and small lamps give the body a crafted silhouette.
  for(const side of [-1,1]){
   const rail=add(new THREE.CylinderGeometry(.035,.035,2.05,12),structure,side*1.18,-1.33,.6);rail.rotation.z=-side*.07;
   for(let i=0;i<5;i++)add(new THREE.BoxGeometry(.16,.025,.04),cosmic?new THREE.MeshPhysicalMaterial({color:accent,metalness:theme.accentMetalness,roughness:theme.accentRoughness,clearcoat:theme.accentClearcoat,transparent:true,opacity:.35+i*.1}):new THREE.MeshBasicMaterial({color:accent,transparent:true,opacity:.35+i*.1}),side*.78,-1.05-i*.13,1.13);
  }
  const glassRim=cosmic?new THREE.MeshPhysicalMaterial({color:theme.glassRim,metalness:.24,roughness:.3,clearcoat:.38,transparent:true,opacity:theme.glassRimOpacity,depthWrite:false}):new THREE.MeshBasicMaterial({color:theme.glassRim,transparent:true,opacity:theme.glassRimOpacity,depthWrite:false});
  for(const side of [-1,1]){
   const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(side*.85,-.08,1.15),new THREE.Vector3(side*1.35,.65,.8),new THREE.Vector3(side*.98,1.8,.7),new THREE.Vector3(side*.35,2.38,.35)]);
   this.group.add(new THREE.Mesh(new THREE.TubeGeometry(curve,40,cosmic ? .009 : theme.glassRimTube,6,false),glassRim));
  }
  const bezel=add(new THREE.TorusGeometry(.34,.028,10,48),structure,0,-.98,1.38);
  const slot=add(new THREE.BoxGeometry(1,.65,.14),new THREE.MeshStandardMaterial({color:0x071710,roughness:.3}),0,-1.7,1.32);
  this.knob=add(new THREE.CylinderGeometry(.25,.25,.12,32),cosmic?accentMaterial:structure,0,-.98,1.29);this.knob.rotation.x=Math.PI/2;
  const bar=add(new THREE.BoxGeometry(.08,.36,.15),structure,0,-.98,1.4);this.knobBar=bar;
  this.paddle=new THREE.Group();this.paddle.position.y=-.2;this.group.add(this.paddle);
  const paddleMat=new THREE.MeshStandardMaterial({color:0xa8bac7,metalness:.8,roughness:.24});
  const axle=new THREE.Mesh(new THREE.CylinderGeometry(.09,.12,.45,20),paddleMat);axle.position.y=-.12;this.paddle.add(axle);
  const blade=new THREE.Mesh(new THREE.BoxGeometry(1.7,.12,.22),paddleMat);this.paddle.add(blade);
  for(const x of [-.72,.72]){const scoop=new THREE.Mesh(new THREE.BoxGeometry(.28,.22,.25),paddleMat);scoop.position.set(x,.06,0);scoop.rotation.z=x>0?.4:-.4;this.paddle.add(scoop);}
  this.energy=0;this.physicsTime=0;
  const seamMaterial=cosmic?new THREE.MeshPhysicalMaterial({color:theme.seamColor,metalness:theme.seamMetalness,roughness:theme.seamRoughness,clearcoat:.28}):new THREE.MeshStandardMaterial({color:profile.seamColor,metalness:profile.seamMetalness,roughness:profile.seamRoughness});
  const claspMaterial=cosmic?new THREE.MeshPhysicalMaterial({color:theme.claspColor,metalness:theme.claspMetalness,roughness:theme.claspRoughness,clearcoat:.32}):new THREE.MeshStandardMaterial({color:profile.claspColor,metalness:profile.claspMetalness,roughness:profile.claspRoughness});
  seamMaterial.userData.noWinnerGlow=true;claspMaterial.userData.noWinnerGlow=true;
  const claspGeometry=new THREE.SphereGeometry(profile.claspSize/2,12,8);
  this.items=CURRENT.items.map((entry,i)=>{
   const ball=new THREE.Group(),color=PALETTE[paletteIndex(entry.id)],radius=.26;
   const classicShell=!cosmic;
   const capsuleColor=cosmic?new THREE.Color(color).lerp(new THREE.Color(theme.capsuleTint),theme.capsuleTintMix):color;
   const top=new THREE.Mesh(new THREE.SphereGeometry(radius,24,16,0,Math.PI*2,0,Math.PI/2),new THREE.MeshPhysicalMaterial({color:classicShell?color:capsuleColor,roughness:classicShell?profile.classicCapsuleRoughness:theme.capsuleRoughness,metalness:classicShell?profile.classicCapsuleMetalness:theme.capsuleMetalness,clearcoat:classicShell?profile.classicCapsuleClearcoat:theme.capsuleClearcoat,envMapIntensity:classicShell?1:theme.capsuleEnvMapIntensity,specularIntensity:classicShell?1:theme.capsuleSpecularIntensity}));
   const bottom=new THREE.Mesh(top.geometry.clone(),new THREE.MeshPhysicalMaterial({color:classicShell?profile.classicBottomColor:theme.capsuleBottomColor,roughness:classicShell?profile.classicBottomRoughness:theme.capsuleBottomRoughness,metalness:classicShell?profile.classicBottomMetalness:theme.capsuleBottomMetalness,transparent:true,opacity:classicShell?profile.classicBottomOpacity:theme.capsuleBottomOpacity,depthWrite:classicShell?true:false,envMapIntensity:classicShell?1:theme.capsuleEnvMapIntensity,specularIntensity:classicShell?1:theme.capsuleSpecularIntensity}));bottom.rotation.z=Math.PI;
   if(cosmic){top.material.userData.noWinnerGlow=true;bottom.material.userData.noWinnerGlow=true;}
   const clasp=new THREE.Mesh(claspGeometry,claspMaterial);clasp.position.set(radius*.8,0,radius*.6);bottom.add(clasp);
   ball.add(top,bottom);const band=new THREE.Mesh(new THREE.TorusGeometry(radius,profile.seamTubeRadius,6,32),seamMaterial);band.rotation.x=Math.PI/2;bottom.add(band);
   const slip=makeChip(entry.name,.9,.43,entry.id);slip.position.z=.3;slip.scale.setScalar(0);ball.add(slip);
   ball.userData={id:entry.id,name:entry.name,i,top,bottom,slip,velocity:{x:0,y:0,z:0}};const a=i*2.399,r=.45+(i%3)*.3;ball.position.set(Math.cos(a)*r,.05+Math.floor(i/9)*.36,Math.sin(a)*r);this.group.add(ball);return ball;
  });
  this.update(0,0,false);
 }
 update(dt,t,spinning){
  this.energy=damp(this.energy,spinning&&!reduced?1:0,spinning?2:2.7,dt);
  this.knob.position.z=1.29-(this.press||0)*.05;this.knobBar.position.z=1.4-(this.press||0)*.05;this.knobBar.rotation.z+=dt*this.energy*6;this.paddle.rotation.y=this.physicsTime*3.5;
  const bodies=this.items.filter(ball=>ball!==this.winner);
  // Small substeps keep collision response stable at both 30 and 120 Hz.
  const count=Math.max(1,Math.ceil(dt/(1/120)));
  const impact=motionFeedback?{strength:0,pan:0}:null;
  for(let j=0;j<count;j++){this.physicsTime+=dt/count*this.energy;stepCapsules(bodies,dt/count,this.energy,this.physicsTime,impact);}
  if(impact?.strength>.20&&this.energy>.04)onSound('capsule-impact',impact);
  for(const ball of bodies){const w=ball.userData.angular;if(w){const speed=Math.hypot(w.x,w.y,w.z);if(speed>.001)ball.rotateOnWorldAxis(new THREE.Vector3(w.x,w.y,w.z).normalize(),speed*dt);}}if(spinning&&this.energy>.3&&Math.floor(t*6)!==this.soundBeat){this.soundBeat=Math.floor(t*6);onSound('capsule',this.energy);}
  if(this.flying){const f=this.flying;this.updateFly(dt,t);if(this.winner){const u=this.winner.userData,k=f.capsuleSample?.open??0;u.top.position.y=k*.48;u.top.rotation.z=-k*.3;u.bottom.position.y=-k*.18;u.slip.scale.setScalar(k);this.updateSeamArcs(k);}}
  else this.updateSeamArcs(0);
 }
 updateSeamArcs(open){
  if(!this.seamArcs)return;
  if(reduced){this.seamArcs.scale.setScalar(1);this.seamArcMats.forEach((material,index)=>{material.opacity=0;this.seamArcs.children[index].visible=false;});return;}
  const reveal=MACHINE_PROFILES.capsule.materials.cosmic.reveal;
  this.seamArcs.scale.setScalar(1+open*.5);
  this.seamArcMats.forEach((material,index)=>{
   const progress=THREE.MathUtils.clamp((open-reveal.seamArcStarts[index])/reveal.seamArcSpan,0,1);
   const fade=progress<.52?smooth(progress/.52):1-smooth((progress-.52)/.48);
   material.opacity=reveal.seamArcPeakOpacity*Math.max(0,fade);
   this.seamArcs.children[index].visible=material.opacity>.005;
  });
 }
 clearSeamArcBinding(){
  if(this.seamArcBinding){this.group.add(this.seamArcs);this.seamArcBinding=null;}
  this.updateSeamArcs(0);
 }
 bindSeamArcs(ball){
  this.clearSeamArcBinding();
  if(cosmic&&this.seamArcs&&ball){ball.userData.bottom.add(this.seamArcs);this.seamArcBinding=ball.userData.bottom;}
 }
 enhanceCosmicWinnerCard(ball){
  if(!cosmic||ball.userData.cosmicEdgeEnhanced)return;
  const edge=ball.userData.slip.children[0],old=edge.material,reveal=MACHINE_PROFILES.capsule.materials.cosmic.reveal;
  edge.material=new THREE.MeshPhysicalMaterial({color:old.color,metalness:old.metalness,roughness:old.roughness,envMapIntensity:old.envMapIntensity,clearcoat:reveal.cardClearcoat,clearcoatRoughness:.22,iridescence:reveal.cardIridescence,iridescenceIOR:1.3,iridescenceThicknessRange:[120,260]});
  edge.material.userData.noWinnerGlow=old.userData.noWinnerGlow;
  old.dispose();ball.userData.cosmicEdgeEnhanced=true;
 }
 highlight(id){const ball=this.items.find(item=>item.userData.id===id);if(!ball)return;this.winner=ball;this.bindSeamArcs(ball);this.enhanceCosmicWinnerCard(ball);
  this.group.updateWorldMatrix(true,false);
  const startLocal=this.group.worldToLocal(ball.getWorldPosition(new THREE.Vector3()));
  const targetWorld=new THREE.Vector3(0,.65,3),targetLocal=this.group.worldToLocal(targetWorld.clone());
  const route=capsuleRouteSegments(startLocal.toArray(),targetLocal.toArray()),path=new THREE.CurvePath();
  const curves=route.segments.map(segment=>{
   const points=segment.points.map(point=>this.group.localToWorld(new THREE.Vector3(...point)));
   const curve=segment.type==='line'?new THREE.LineCurve3(points[0],points[1]):new THREE.CubicBezierCurve3(...points);
   path.add(curve);return curve;
  });
  const lengths=curves.map(curve=>curve.getLength()),total=lengths.reduce((sum,length)=>sum+length,0);
  const exitLength=lengths.slice(0,route.exitAfterSegment+1).reduce((sum,length)=>sum+length,0),exitProgress=exitLength/total;
  const timing=MACHINE_PROFILES.capsule.timing;
  this.detachToHover(ball,{capsule:true,target:targetWorld,path,exitProgress,duration:timing.flightMs,settleLift:timing.settleLift,roll:true,scale:2.3,face:'camera',spin:false});
 }

 reset(){this.clearSeamArcBinding();this.winner=null;for(const ball of this.items){ball.userData.mixPhase=Math.random()*Math.PI*2;ball.userData.top.position.y=0;ball.userData.top.rotation.z=0;ball.userData.bottom.position.y=0;ball.userData.slip.scale.setScalar(0);}}
}
let buildKey='',wheelCandidateKey=null;
function build(config){
 background.update(config);CURRENT.backdrop=config.backdrop;
 const key=JSON.stringify([config.machine,config.theme,config.items.filter(i=>!i.excluded).slice(0,config.machine==='sphere'?undefined:48)]);
 if(key===buildKey&&machine&&!groupAnimation)return;buildKey=key;
 clearResultSnapshot();transitionId++;celebrateAt=0;decorationUntil=0;clearBurst();groupAnimation=null;machineBounds=null;machineFitPoints=null;resultBounds=null;cameraFitCache=null;disposeMachine();CURRENT={...config,items:config.items.filter(i=>!i.excluded).slice(0,config.machine==='sphere'?undefined:48)};
 effects.lines(false);
 cosmic=config.theme==='cosmic';
 effects.theme(cosmic);effects.reset();STATE='idle';
 machineKey=config.machine;effects.machine(machineKey);effects.anchor(effectAnchor,false);syncEffectBudget();
 if(config.machine==='sphere'){machine=new NameSphere(machineGroup);machine.build();}
 else if(config.machine==='capsule'){machine=new CapsuleMachine(machineGroup);machine.build();}
 else machine=makeMachine('wheel');
 if(machineKey==='wheel'&&CURRENT.items.length>=MACHINE_PROFILES.wheel.denseLabelThreshold){
  wheelCandidateKey=createWheelCandidateKey(mount,CURRENT.items,MACHINE_PROFILES.wheel.denseLabelThreshold);
 }
 const profile=MACHINE_PROFILES[config.machine]||MACHINE_PROFILES.capsule;
 const theme=cosmic?MACHINE_PROFILES.capsule.materials.cosmic:profile.materials.classic;
 bloom.strength=cosmic?MACHINE_PROFILES.capsule.effects.cosmicBloomStrength:profile.effects.bloomStrength;
 rim.color.set(cosmic?MACHINE_PROFILES.capsule.effects.cosmicRim:theme?.rimLight??MACHINE_PROFILES.capsule.effects.classicRim);
 machineGroup.scale.setScalar(profile.camera.scale);
 measureMachineBounds();refreshCameraFits(true);
}
function size(){
 const w=Math.max(1,mount.clientWidth),h=Math.max(1,mount.clientHeight),style=getComputedStyle(mount);
 const next=stageViewport(w,h,SHARED_PROFILE.camera.fov,Object.fromEntries(['top','right','bottom','left'].map(side=>[side,parseFloat(style.getPropertyValue(`--stage-safe-${side}`))||0])));
 const nextFraming=framingScale(parseFloat(style.getPropertyValue('--stage-framing')));
 const changed=nextFraming!==stageFraming||JSON.stringify(next)!==JSON.stringify(viewport);viewport=next;stageFraming=nextFraming;
 camera.setViewOffset(w,h,viewport.offsetX,viewport.offsetY,w,h);
 renderer.setSize(w,h);composer.setSize(w,h);fitBackdrop();
 const pageInfo=reflowResultPage();
 if(machineBounds&&(!cameraFitCache||changed||pageInfo))refreshCameraFits(true);
 if(pageInfo)dispatchResultPage(pageInfo);
 syncEffectBudget();
}
let diagnostics=null,diagnosticSamples=[],diagnosticAt=performance.now();
if(new URLSearchParams(location.search).has('diagnostics')){
 diagnostics=document.createElement('output');diagnostics.id='stageDiagnostics';diagnostics.setAttribute('aria-label','本地画面诊断');
 diagnostics.style.cssText='position:fixed;bottom:8px;left:8px;z-index:9999;max-width:380px;white-space:pre-wrap;background:#08110fee;color:#cfffac;padding:12px;border:1px solid #526b46;border-radius:8px;font:12px/1.5 monospace;pointer-events:none';document.body.append(diagnostics);
}
const observer=new ResizeObserver(size);observer.observe(mount);size();
// Immersion changes the composition, not the dimensions of the full-bleed canvas.
const layoutObserver=new MutationObserver(size);
if(mount.parentElement)layoutObserver.observe(mount.parentElement,{attributes:true,attributeFilter:['class']});
layoutObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
renderer.domElement.style.touchAction='pan-y';
function hitMachine(e){const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(machineGroup.children,true).length>0;}
renderer.domElement.addEventListener('pointerdown',e=>{
 if(drag||e.button!==0||STATE==='spin'||STATE==='return')return;
 drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastTime:performance.now(),angle:dragAngle,elevation:dragElevation,moved:false,hit:hitMachine(e)};
 dragVelocity=0;renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove',e=>{
 if(!drag){hovered=e.pointerType==='mouse'&&hitMachine(e);renderer.domElement.style.cursor=hovered&&STATE!=='spin'?'grab':'default';return;}
 if(e.pointerId!==drag.id)return;
 const dx=e.clientX-drag.x,dy=e.clientY-drag.y,now=performance.now();
 drag.moved ||= Math.hypot(dx,dy)>7;
 const sensitivity=2.2/Math.max(320,mount.clientWidth);
 dragAngle=THREE.MathUtils.clamp(drag.angle+dx*sensitivity,-.65,.65);
 dragElevation=THREE.MathUtils.clamp(drag.elevation+dy*sensitivity*.4,-.23,.23);
 dragVelocity=THREE.MathUtils.clamp((e.clientX-drag.lastX)*sensitivity/Math.max(.016,(now-drag.lastTime)/1000),-1.6,1.6);
 drag.lastX=e.clientX;drag.lastTime=now;renderer.domElement.style.cursor='grabbing';
});
renderer.domElement.addEventListener('pointerup',e=>{
 if(!drag||e.pointerId!==drag.id)return;
 const clicked=!drag.moved&&drag.hit&&hitMachine(e);if(performance.now()-drag.lastTime>100)dragVelocity=0;
 drag=null;renderer.domElement.style.cursor=hovered?'grab':'default';
 if(clicked&&STATE!=='spin'&&STATE!=='return')onActivate();
});
const cancelDrag=()=>{drag=null;dragVelocity=0;hovered=false;renderer.domElement.style.cursor='default';};
renderer.domElement.addEventListener('pointercancel',cancelDrag);
renderer.domElement.addEventListener('lostpointercapture',()=>{if(drag)cancelDrag();});
renderer.domElement.addEventListener('pointerleave',()=>{hovered=false;});
let last=performance.now(),frame=0;
function loop(now){if(stopped)return;frame=requestAnimationFrame(loop);const elapsed=now-last,dt=Math.min(.04,elapsed/1000);last=now;if(document.hidden){diagnosticSamples=[];diagnosticAt=now;return;}syncEffectBudget();
 if(cosmic&&!reduced)cosmicStars.rotation.z+=dt*.025;if(!drag){dragVelocity*=Math.exp(-dt*9);dragAngle=THREE.MathUtils.clamp(dragAngle+dragVelocity*dt,-.65,.65);dragAngle*=Math.exp(-dt*2.8);dragElevation*=Math.exp(-dt*3.2);}press=damp(press,drag?.hit&&!drag.moved?1:0,16,dt);
 const pose=currentCameraPose(now);if(pose){camera.position.x+=(pose.position[0]-camera.position.x)*(1-Math.exp(-dt*3.7));camera.position.y=damp(camera.position.y,pose.position[1],4,dt);camera.position.z+=(pose.position[2]-camera.position.z)*(1-Math.exp(-dt*2.2));cameraAim.x=damp(cameraAim.x,pose.target[0],3.7,dt);cameraAim.y=damp(cameraAim.y,pose.target[1],3,dt);cameraAim.z=damp(cameraAim.z,pose.target[2],2.2,dt);camera.lookAt(cameraAim);}
 if(celebrateAt&&now>=celebrateAt){celebrateAt=0;effects.reveal();if(!revealSoundPlayed&&(machineKey==='wheel'||machineKey==='sphere')){revealSoundPlayed=true;onSound(`${machineKey}-reveal`,1);}if(!reduced)spawnBurst(cosmic?0xb6a1e8:machineKey==='wheel'?0xe3c58f:machineKey==='sphere'?0x96bbdb:0xbce0cc,{cosmicCapsule:cosmic&&machineKey==='capsule'});}effects.update(dt,now/1000,STATE,reduced);
 if(groupAnimation){groupAnimation.cards.forEach((card,i)=>{
  const delay=i*Math.min(SHARED_PROFILE.timing.groupStaggerStepMaxMs,SHARED_PROFILE.timing.groupStaggerMaxMs/Math.max(1,groupAnimation.cards.length-1));
  const k=reduced?1:smooth((now-groupAnimation.start-delay)/1900);
  card.mesh.position.lerpVectors(card.from,card.to,k);card.mesh.position.y+=Math.sin(k*Math.PI)*.35;
  card.mesh.quaternion.slerp(camera.quaternion,1-Math.exp(-dt*8));
 });}
 if(machine&&groupAnimation){machine.group.scale.lerp(new THREE.Vector3(.68,.68,.68),1-Math.exp(-dt*2));machine.group.position.z=damp(machine.group.position.z,-2,2,dt);machine.update(dt,now/1000,false);}
 if(machine&&!groupAnimation){machine.press=press;machine.spin=STATE==='spin'?Math.min(1,(now-spinStart)/1500):0;machine.update(dt,now/1000,STATE==='spin');onSound('motion-'+machineKey,{phase:STATE,speed:machine.velocity||machine.energy||0,angle:machineKey==='wheel'?machine.theta:machine.group.rotation.y});}
 const followCapsule=machineKey==='capsule'&&STATE==='reveal'&&performance.now()<decorationUntil&&!!machine?.winner;
 effects.anchor(followCapsule?resultEffectAnchor(effectAnchor):effectAnchor,followCapsule);
 if(burstActive){burstLife+=dt;const a=burstGeometry.attributes.position.array;for(let i=0;i<burstCount;i++){const j=i*3;a[j]+=burstVelocities[j]*dt*40;a[j+1]+=burstVelocities[j+1]*dt*40;a[j+2]+=burstVelocities[j+2]*dt*40;}burstGeometry.attributes.position.needsUpdate=true;burstMaterial.opacity=Math.max(0,1-burstLife/burstDuration);if(burstLife>=burstDuration)clearBurst();}
 if(quality==='low'||reduced)renderer.render(scene,camera);else composer.render();
 if(diagnostics){
  if(elapsed>0)diagnosticSamples.push(elapsed);
  if(now-diagnosticAt>=2000&&diagnosticSamples.length){const sorted=[...diagnosticSamples].sort((a,b)=>a-b),mean=diagnosticSamples.reduce((a,b)=>a+b,0)/diagnosticSamples.length;let objects=0;scene.traverse(()=>objects++);
   const motion=machineKey==='capsule'&&machine?`\n搅动 ${machine.energy.toFixed(2)} · 平均速度 ${(machine.items.reduce((sum,b)=>sum+Math.hypot(...Object.values(b.userData.velocity)),0)/Math.max(1,machine.items.length)).toFixed(2)} · 仓内最高 ${Math.max(...machine.items.filter(b=>b!==machine.winner).map(b=>b.position.y)).toFixed(2)}`:machineKey==='sphere'&&machine?`\n姓名 ${machine.items.length} · 球体转角 ${(machine.group.rotation.y*180/Math.PI%360).toFixed(0)}°`:machineKey==='wheel'&&machine?`\n转角 ${machine.theta.toFixed(2)}rad · 角速 ${machine.velocity.toFixed(2)}rad/s · 刹停 ${machine.landing?'进行中':'结束'} · 抬升 ${Math.round(machine.settleProgress*100)}%`:'';
   const ambientActual=effects.stats(),starActual=starsGeo.drawRange.count,burstActual=burstGeometry.drawRange.count;
   const trailObjects=machineKey==='wheel'&&Array.isArray(machine?.trail)?machine.trail:[];
   const trailVisible=trailObjects.filter(item=>item.visible!==false&&item.material?.opacity>0).length;
   const budgetLine=`\n装饰阶段 ${decorationPhase()} · 预算 A/S/B/T/Σ ${effectBudgetState.ambient}/${effectBudgetState.stars}/${effectBudgetState.burst}/${effectBudgetState.trail}/${effectBudgetState.total} · draw A ${ambientActual.drawRange}/${ambientActual.visible?'显示':'隐藏'} S ${starActual}/${cosmicStars.visible?'显示':'隐藏'} B ${burstActual}/${burst.visible?'显示':'隐藏'} · trail ${trailVisible}/${trailObjects.length}`;
   diagnostics.textContent=`本地画面诊断 · 最近 2 秒\n${machineKey} / ${cosmic?'星空':'经典'} / ${STATE} / ${quality}\n${mount.clientWidth}×${mount.clientHeight} · DPR ${renderer.getPixelRatio().toFixed(2)}\n画布 ${renderer.domElement.width}×${renderer.domElement.height} · 辉光 ${Math.round(composer.renderTarget1.width)}×${Math.round(composer.renderTarget1.height)}\n平均 ${(1000/mean).toFixed(1)} FPS · P95 ${sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))].toFixed(1)} ms\n几何 ${renderer.info.memory.geometries} · 纹理 ${renderer.info.memory.textures} · 程序 ${renderer.info.programs.length} · 场景节点 ${objects}${motion}${budgetLine}`;
   diagnosticSamples=[];diagnosticAt=now;
  }
 }
}
frame=requestAnimationFrame(loop);
return {
 configure:build,
 background:config=>background.update(config),
 async start(){
  const wasSpinning=STATE==='spin';
  if(groupAnimation||!machine){clearResultSnapshot();buildKey='';build(CURRENT);}
  const id=++transitionId;celebrateAt=0;decorationUntil=0;clearBurst();effects.reset();effects.anchor(effectAnchor,false);
  if(machine?.flying&&!reduced){STATE='return';syncEffectBudget();const wasOut=machine.flying.phase==='out';machine.beginReturn();if(wasOut&&machine.flying?.phase==='back')onSound(`${machineKey}-return`,1);const returnMs=machineKey==='capsule'?MACHINE_PROFILES.capsule.timing.returnMs:SHARED_PROFILE.timing.returnMs;await new Promise(resolve=>setTimeout(resolve,returnMs));if(id!==transitionId||stopped)return false;}
  clearResultSnapshot();if(machine){machine.forceHome();machine.reset();}resultBounds=null;STATE='spin';if(!wasSpinning){revealSoundPlayed=false;onSound(`${machineKey}-start`,1);}syncEffectBudget();refreshCameraFits(false);spinStart=performance.now();return true;
 },
 reveal(results,celebrate=true){transitionId++;resultBounds=null;STATE='reveal';revealStart=performance.now();
  const origins=resultOrigins();clearResultSnapshot();
  if(results.length>1){if(machineKey!=='sphere')disposeMachine();saveResultSnapshot('results',results,origins);layoutResultPage(0,{animate:true,animationStart:performance.now(),notify:true});}
  else if(results.length){
   const item=results[0];
   if(!machine||!CURRENT.items.some(i=>i.id===item.id&&i.name===item.name)){
    const cfg={...CURRENT,items:[item,...CURRENT.items.filter(i=>i.id!==item.id).slice(0,machineKey==='sphere'?undefined:47)],machine:machineKey,theme:cosmic?'cosmic':'classic'};
    build(cfg);STATE='reveal';
   }
   saveResultSnapshot('results',results,origins.size?origins:resultOrigins());
   machine.highlight(item.id);resultBounds=singleResultBounds(machineKey);refreshCameraFits(false);
   resultPageMeta={kind:'results',page:0,pageSize:resultPageSize(Math.max(0,mount.clientWidth)),pageCount:1,total:1,start:0,end:1};dispatchResultPage(resultPageInfo());
  }else{saveResultSnapshot('results',results,origins);layoutResultPage(0);refreshCameraFits(false);}
  decorationUntil=performance.now()+currentRevealDuration()+2100;syncEffectBudget();
  celebrateAt=celebrate?performance.now()+(reduced?0:groupAnimation?SHARED_PROFILE.timing.groupRevealStartMs:machineKey==='wheel'?machine?.revealMs||0:machineKey==='capsule'?MACHINE_PROFILES.capsule.timing.celebrationMs:Math.max(0,(machine?.revealMs||2000)-SHARED_PROFILE.timing.celebrationLeadMs)):0;
 },
 revealGroups(groups){
  transitionId++;STATE='reveal';revealStart=performance.now();effects.reveal();if(!revealSoundPlayed&&(machineKey==='wheel'||machineKey==='sphere')){revealSoundPlayed=true;onSound(`${machineKey}-reveal`,1);}const origins=resultOrigins();clearResultSnapshot();if(machineKey!=='sphere')disposeMachine();
  saveResultSnapshot('groups',groups,origins);layoutResultPage(0,{animate:true,animationStart:performance.now(),notify:true});
  decorationUntil=performance.now()+currentRevealDuration()+2100;syncEffectBudget();
 },
 resultPageInfo,
 showResultPage(page){return layoutResultPage(page,{animate:false,notify:true});},
 finishReveal(){
  if(STATE!=='reveal')return;
  decorationUntil=Math.min(decorationUntil,performance.now()+2100);
  if(machineKey==='wheel'&&machine?.plan)machine.finishPresentation();
  if(groupAnimation)groupAnimation.start=performance.now()-10000;
  if(machine?.flying)machine.flying.wall0=performance.now()-10000;
  if(machine?.align){machine.align.start=performance.now()-10000;machine.update(0,performance.now()/1000,false);}
  if(machine?.flying)machine.flying.wall0=performance.now()-10000;
  if(machineKey!=='wheel'&&machine?.landing)machine.landT0=performance.now()-10000;
  if(celebrateAt){if(cosmic&&machineKey==='capsule'){celebrateAt=0;clearBurst();}else celebrateAt=performance.now();}
 },
 revealDelay(){return currentRevealDuration();},
  reset(){const needsRebuild=!!groupAnimation||!machine;transitionId++;celebrateAt=0;decorationUntil=0;clearBurst();effects.reset();effects.anchor(effectAnchor,false);clearResultSnapshot();if(needsRebuild){buildKey='';build(CURRENT);}groupAnimation=null;resultBounds=null;STATE='idle';if(machine){machine.forceHome();machine.reset();}syncEffectBudget();refreshCameraFits(false);},
 quality(value){quality=value;effects.quality(value);const ratio=SHARED_PROFILE.rendering.qualityPixelRatio;renderer.setPixelRatio(Math.min(devicePixelRatio,ratio[value]??ratio.other));composer.setPixelRatio(renderer.getPixelRatio());size();},
 reduced(value){const changed=reduced!==Boolean(value);reduced=Boolean(value);if(changed&&reduced){celebrateAt=0;decorationUntil=0;clearBurst();effects.reset();effects.anchor(effectAnchor,false);}if(value&&machineKey==='wheel'&&machine?.plan)machine.finishPresentation();syncEffectBudget();},
  dispose(){transitionId++;stopped=true;cancelAnimationFrame(frame);observer.disconnect();layoutObserver.disconnect();background.dispose();clearBurst();effects.dispose();clearResultSnapshot();machineBounds=null;machineFitPoints=null;resultBounds=null;cameraFitCache=null;disposeMachine();disposeGroup(scene);for(const pass of composer.passes)pass.dispose?.();composer.dispose();diagnostics?.remove();for(const texture of backdropTextures.values())texture.dispose();env.dispose();pmrem.dispose();renderer.dispose();renderer.domElement.remove();}
};
}
