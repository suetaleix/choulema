import * as THREE from '/vendor/three.module.js';
import { SHARED_PROFILE } from './machine-profiles.mjs';

// One persistent effect rig per renderer. It never receives candidate identities
// or changes the authoritative result. Quality changes reuse all GPU buffers.
export function createEffects(scene) {
 const rig=new THREE.Group();scene.add(rig);
 let cosmic=false,energy=0,revealAge=99,quality='high',phaseTime=0,machineKey='capsule';
 const profile=SHARED_PROFILE.effects;
 const uniforms={uTime:{value:0},uPhase:{value:0},uEnergy:{value:0},uCosmic:{value:0},uMachine:{value:0},uAnchor:{value:new THREE.Vector3()},uAnchorActive:{value:0},uColor:{value:new THREE.Color(profile.machineColors.capsule)},uSize:{value:profile.pointSizeByQuality.other}};
 const n=profile.maxParticles,positions=new Float32Array(n*3),seeds=new Float32Array(n*3);
 for(let i=0;i<n;i++){seeds[i*3]=Math.random();seeds[i*3+1]=Math.random();seeds[i*3+2]=Math.random();}
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('aSeed',new THREE.BufferAttribute(seeds,3));geo.setDrawRange(0,0);
 const particles=new THREE.Points(geo,new THREE.ShaderMaterial({
  uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  vertexShader:`attribute vec3 aSeed; uniform float uTime,uEnergy,uCosmic,uMachine,uPhase,uAnchorActive,uSize;uniform vec3 uAnchor; varying float vAlpha;
   void main(){float capsuleAngle=aSeed.x*6.283185+uTime*(.08+.13*aSeed.y)+uPhase*.35;
    float sphereAngle=aSeed.x*6.283185+uTime*(.015+.015*aSeed.y);
    float wheelAngle=aSeed.x*6.283185+uTime*(.08+.13*aSeed.y)+uPhase*.7;
    vec3 p;
    if(uMachine<.5){
     float radius=sqrt(aSeed.y)*1.1;
     p=vec3(cos(capsuleAngle)*radius,.15+aSeed.z*1.65+sin(capsuleAngle*2.+uTime)*uEnergy*.08,sin(capsuleAngle)*radius)*.95;
     if(uAnchorActive>.5&&aSeed.z<.15)p=uAnchor+vec3(cos(capsuleAngle)*(.48+.15*aSeed.y),sin(capsuleAngle)*(.30+.1*aSeed.y),-.25);
    }else if(uMachine<1.5){
     float radius=2.4+aSeed.y;
     p=vec3(cos(sphereAngle)*radius,sin(sphereAngle)*radius*.7+.35,-3.-aSeed.z*1.5);
    }else{
     float radius=2.67+aSeed.y*.11;
     vec3 disk=vec3(cos(wheelAngle)*radius,.23+sin(uTime+aSeed.z*6.283185)*.025,sin(wheelAngle)*radius);
     float tilt=1.5707963-1.02;
     p=vec3(disk.x,disk.y*cos(tilt)-disk.z*sin(tilt),disk.y*sin(tilt)+disk.z*cos(tilt));
    }
    vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
    gl_PointSize=clamp(uSize*(.6+aSeed.y)*12./max(2.,-mv.z),1.,8.);
    vAlpha=(.10+.25*uEnergy)*(.35+.65*aSeed.z)*(uMachine>.5&&uMachine<1.5?.6:1.)*(uMachine<.5&&uCosmic>.5?1.15:1.);
   }`,
  fragmentShader:`uniform vec3 uColor;varying float vAlpha;
   void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*6.)*vAlpha;
    gl_FragColor=vec4(uColor*1.8,a);}`
 }));particles.frustumCulled=false;rig.add(particles);

 const rings=[];
 for(let i=0;i<profile.ringCount;i++){
  const mesh=new THREE.Mesh(new THREE.TorusGeometry(profile.ringRadius+i*profile.ringRadiusStep,profile.ringTube+i*profile.ringTubeStep,8,128),new THREE.MeshBasicMaterial({color:profile.themeColors.classic,transparent:true,opacity:.2,blending:THREE.AdditiveBlending,depthWrite:false}));
  mesh.rotation.set(profile.ringRotationX+(i-1)*profile.ringTiltStep,i*.4,i*.7);mesh.position.y=-.1+i*.15;rig.add(mesh);rings.push(mesh);
 }
 const wave=new THREE.Mesh(new THREE.RingGeometry(.93,1,128),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false}));
 wave.position.set(0,.65,2.3);rig.add(wave);
 const glow=new THREE.PointLight(0xb5ff91,0,13,2);glow.position.fromArray(profile.glow.position);rig.add(glow);
 const nebula=new THREE.Mesh(new THREE.PlaneGeometry(24,17),new THREE.ShaderMaterial({
  uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`varying vec2 vUv;uniform float uTime,uEnergy;uniform vec3 uColor;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
   float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+3.;a*=.5;}return v;}
   void main(){vec2 p=(vUv-.5)*vec2(1.4,1.);float r=length(p);float angle=r*5.-uTime*.025;
    vec2 q=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p*5.;
    float n=fbm(q*1.7);float dust=fbm(q+vec2(n,fbm(q*1.7+3.1)));float halo=exp(-pow((r-.28)*8.,2.));
    float fade=(1.-smoothstep(.2,.73,r))*smoothstep(.035,.2,r);
    vec3 color=mix(vec3(.035,.105,.31),uColor,dust*.72);
    gl_FragColor=vec4(color*(.48+halo*.7),dust*fade*(.055+uEnergy*.035));}`
 }));nebula.position.set(0,.7,-5);nebula.visible=false;rig.add(nebula);

 function applyMachineTheme(){
  const cosmicCapsule=cosmic&&machineKey==='capsule';
  const color=cosmicCapsule?profile.machineColors.cosmicCapsule:profile.machineColors[machineKey]||profile.machineColors.capsule;
  uniforms.uColor.value.setHex(color);uniforms.uCosmic.value=+cosmicCapsule;
  for(const ring of rings)ring.material.color.copy(uniforms.uColor.value);
  glow.color.copy(uniforms.uColor.value);nebula.visible=cosmicCapsule&&quality!=='low';
 }
 function setTheme(value){cosmic=Boolean(value);applyMachineTheme();}
 function setMachine(value){machineKey=Object.hasOwn(profile.machineColors,value)&&value!=='cosmicCapsule'?value:'capsule';uniforms.uMachine.value=machineKey==='sphere'?1:machineKey==='wheel'?2:0;applyMachineTheme();}
 function setAnchor(position,active){if(position)uniforms.uAnchor.value.copy(position);uniforms.uAnchorActive.value=active&&position?1:0;}
 let currentBudget={ambient:0,stars:0,burst:0,trail:0,total:0};
 function setBudget(value){currentBudget={...value};const ambient=Number.isFinite(currentBudget.ambient)?Math.max(0,Math.min(n,Math.floor(currentBudget.ambient))):0;geo.setDrawRange(0,ambient);particles.visible=ambient>0;}
 function setQuality(value){quality=value;uniforms.uSize.value=value==='low'?profile.pointSizeByQuality.low:profile.pointSizeByQuality.other;}
 setQuality('high');applyMachineTheme();
 return {
  theme:setTheme,machine:setMachine,anchor:setAnchor,quality:setQuality,budget:setBudget,stats(){return {budget:{...currentBudget},drawRange:geo.drawRange.count,visible:particles.visible&&rig.visible};},lines(value){for(const ring of rings)ring.visible=value;wave.visible=value;},
  reveal(){revealAge=0;},reset(){revealAge=99;wave.material.opacity=0;energy=0;},
  update(dt,time,phase,reduced){
   rig.visible=!reduced;if(reduced)return;
   energy+=(+(phase==='spin')-energy)*(1-Math.exp(-dt*2.2));phaseTime+=dt*energy;uniforms.uPhase.value=phaseTime;revealAge+=dt;
   const burst=Math.max(0,1-revealAge/2.1);
   uniforms.uTime.value=time;uniforms.uEnergy.value=energy;
   const cosmicCapsule=cosmic&&machineKey==='capsule';
   for(let i=0;i<rings.length;i++){const ring=rings[i];ring.rotation.z+=dt*(.1+i*.04+energy*(1+i*.2));ring.material.opacity=(cosmicCapsule?.2:.07)+energy*.32+burst*.2;ring.scale.setScalar(1+Math.sin(time*1.8+i)*.012+burst*.12);}
   wave.scale.setScalar(.6+Math.min(revealAge,3)*3);wave.material.opacity=revealAge<1.1?Math.pow(1-revealAge/1.1,2)*.65:0;
   glow.intensity=energy*(cosmicCapsule?profile.glow.cosmicEnergy:profile.glow.classicEnergy)+burst*(cosmicCapsule?profile.glow.cosmicBurst:profile.glow.classicBurst);
   nebula.visible=cosmicCapsule&&quality!=='low';
  },
  dispose(){scene.remove(rig);rig.traverse(o=>{o.geometry?.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());});}
 };
}
