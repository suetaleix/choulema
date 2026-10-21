import * as THREE from '/vendor/three.module.js';

// Appearance only. The controller owns rotation and winners; disk owns all resources.
const TAU=Math.PI*2;
const vertexShader=`
 varying vec2 vPlane;
 void main(){vPlane=position.xz/2.4;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}
`;
const fragmentShader=`
 precision highp float;
 varying vec2 vPlane;
 uniform float uTime,uMotion,uCount,uWinner,uSettle;
 const float TAU=6.28318530718;
 float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
 void main(){
  vec2 p=vPlane;float r=length(p),a=atan(p.x,p.y);
  float turn=mod(a+TAU,TAU)/TAU,cell=turn*uCount;
  float selected=1.0-step(.1,abs(floor(cell)-uWinner));
  // Broad transparent curtains grow from each sector edge, with fine folded light.
  float edgeDistance=min(fract(cell),1.0-fract(cell));
  float bend=.025*sin(r*7.0-uTime*.28)+.018*sin(r*12.0+a*2.0+uTime*.17);
  float folded=fract(cell+bend),ridge=min(folded,1.0-folded);
  float silk=exp(-ridge*ridge*1500.0),veil=exp(-ridge*ridge*18.0);
  float filament=pow(.5+.5*sin(r*44.0+a*3.0-uTime*.22),4.0);
  float radial=smoothstep(.23,.48,r)*(1.0-smoothstep(.92,1.0,r));
  float colorMix=.5+.5*sin(a*3.0+r*1.9);
  vec3 tint=mix(vec3(.08,.67,.79),vec3(.48,.19,.95),colorMix);
  vec3 color=tint*(veil*.23+silk*.18+veil*filament*.07)*radial;
  vec2 grid=floor(p*72.0),local=fract(p*72.0)-.5;
  float seed=hash(grid),star=exp(-dot(local,local)*180.0)*step(.973,seed)*radial;
  color+=vec3(.54,.76,1.0)*star*.48;
  float seam=exp(-edgeDistance*edgeDistance*16000.0)*radial;
  color+=tint*seam*.09;
  float rim=exp(-pow((r-.994)*260.0,2.0));color+=tint*rim*.22;
  color*=1.0+uMotion*.20;color*=1.0-uSettle*(1.0-selected)*.48;
  color+=tint*selected*uSettle*(veil*.18+rim*.40);
  gl_FragColor=vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
 }
`;
function flatRing(inner,outer,segments=192,start=0,length=TAU){
 const geometry=new THREE.RingGeometry(inner,outer,segments,1,start,length);
 geometry.rotateX(-Math.PI/2);return geometry;
}
function glassMaterial(overrides={}){
 return new THREE.MeshPhysicalMaterial({color:0xf4fbff,metalness:0,roughness:.025,
  transmission:.985,thickness:.14,ior:1.24,transparent:true,opacity:1,
  attenuationColor:0x9ebcfa,attenuationDistance:5,clearcoat:.06,clearcoatRoughness:.05,
  envMapIntensity:.075,specularIntensity:.22,depthWrite:false,...overrides});
}
function circle(radius,tube,y,material,parent){
 // A soft band covers multiple pixels at small sizes; a subpixel torus sparkles.
 const mesh=new THREE.Mesh(flatRing(radius-tube*3,radius+tube*3),new THREE.ShaderMaterial({
  uniforms:{uRadius:{value:radius},uWidth:{value:tube},uColor:{value:material.color},uOpacity:{value:material.opacity}},
  vertexShader,transparent:true,depthWrite:false,side:THREE.DoubleSide,
  fragmentShader:`varying vec2 vPlane;uniform float uRadius,uWidth,uOpacity;uniform vec3 uColor;
   void main(){float d=(length(vPlane)*2.4-uRadius)/uWidth;
    gl_FragColor=vec4(uColor,exp(-d*d)*uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`}));
 mesh.position.y=y;mesh.renderOrder=3;parent.add(mesh);return mesh;
}
function ribbonGeometry(radius,start,length){
 const positions=[],colors=[],indices=[],segments=80;
 const cyan=new THREE.Color(0x68dbeb),violet=new THREE.Color(0x9b76f3);
 for(let i=0;i<=segments;i++){
  const t=i/segments,angle=start+t*length,taper=Math.sin(Math.PI*t);
  const color=cyan.clone().lerp(violet,t).multiplyScalar(taper);
  for(const edge of [-1,1]){
   const r=radius+edge*.009*taper;
   positions.push(Math.sin(angle)*r,.16+Math.sin(angle*2)*.09,Math.cos(angle)*r);
   colors.push(color.r,color.g,color.b);
  }
  if(i<segments){const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
 geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}
export function createAuroraWheel(disk,sectors){
 const uniforms={uTime:{value:0},uMotion:{value:0},uCount:{value:Math.max(2,sectors.length)},uWinner:{value:-1},uSettle:{value:0}};
 // One clear optical plate replaces the old overlapping tinted cylinders.
 const plate=new THREE.Mesh(new THREE.CylinderGeometry(2.42,2.42,.075,128),glassMaterial());
 plate.name='aurora-glass-plate';plate.position.y=.08;disk.add(plate);
 const rimProfile=[];
 for(let i=0;i<=24;i++){
  const a=i/24*TAU;rimProfile.push(new THREE.Vector2(2.46+Math.cos(a)*.08,.09+Math.sin(a)*.044));
 }
 const rim=new THREE.Mesh(new THREE.LatheGeometry(rimProfile,192),glassMaterial({thickness:.2,ior:1.36}));
 rim.name='aurora-optical-rim';disk.add(rim);
 const faceMaterial=new THREE.ShaderMaterial({uniforms,vertexShader,fragmentShader,
  side:THREE.DoubleSide,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
 sectors.forEach((sector,index)=>{
  const span=TAU/uniforms.uCount.value;
  const face=new THREE.Mesh(flatRing(.54,2.4,Math.max(5,Math.ceil(192/uniforms.uCount.value)),index*span-Math.PI/2,span),faceMaterial);
  face.name='aurora-curtain';face.position.y=.031;face.renderOrder=2;sector.add(face);
 });
 const edgeMaterial={color:new THREE.Color(0xa8cde9),opacity:.38};
 circle(2.537,.006,.105,edgeMaterial,disk);circle(2.382,.004,.13,edgeMaterial,disk);
 const rimGlow=new THREE.Mesh(flatRing(2.40,2.52),new THREE.ShaderMaterial({uniforms,vertexShader,
  transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
  fragmentShader:`varying vec2 vPlane;uniform float uTime,uMotion;
   void main(){float r=length(vPlane)*2.4,a=atan(vPlane.x,vPlane.y);
    float stripe=exp(-pow((r-2.464)*41.0,2.0));float flow=.5+.5*sin(a*3.0-uTime*.18);
    vec3 tint=mix(vec3(.04,.5,.58),vec3(.34,.10,.62),flow);
    gl_FragColor=vec4(tint*stripe*(.22+uMotion*.10),1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`}));
 rimGlow.position.y=.143;rimGlow.renderOrder=3;disk.add(rimGlow);
 // A cut crystal under a thin optical lens: no opaque center button or inflated dome.
 const core=new THREE.Group();core.position.y=.195;disk.add(core);
 const lens=new THREE.Mesh(new THREE.CylinderGeometry(.55,.55,.055,64),glassMaterial({thickness:.09,ior:1.3}));
 lens.name='aurora-core-lens';core.add(lens);
 circle(.55,.007,.036,edgeMaterial,core);circle(.44,.004,.038,edgeMaterial,core);
 const positions=[],colors=[],palette=[0xc5edff,0x689fe1,0xa98cfa,0x5769cb,0xbce6ff,0x72c5da,0x8689e9,0x6376c3];
 for(let i=0;i<8;i++){
  const a=i*TAU/8,b=(i+1)*TAU/8,ra=i%2===0?.38:.09,rb=(i+1)%2===0?.38:.09;
  positions.push(0,.15,0,Math.sin(a)*ra,.044,Math.cos(a)*ra,Math.sin(b)*rb,.044,Math.cos(b)*rb);
  positions.push(0,-.035,0,Math.sin(b)*rb,.044,Math.cos(b)*rb,Math.sin(a)*ra,.044,Math.cos(a)*ra);
  const color=new THREE.Color(palette[i]);for(let j=0;j<6;j++)colors.push(color.r,color.g,color.b);
 }
 const crystalGeometry=new THREE.BufferGeometry();
 crystalGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 crystalGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));crystalGeometry.computeVertexNormals();
 const crystalMaterial=glassMaterial({vertexColors:true,color:0xffffff,transmission:.72,thickness:.18,ior:1.52,
  roughness:.04,envMapIntensity:.6,specularIntensity:.55,clearcoat:.4,emissive:0x5557a1,emissiveIntensity:.04});
 const crystal=new THREE.Mesh(crystalGeometry,crystalMaterial);crystal.name='aurora-cut-star';crystal.renderOrder=4;core.add(crystal);
 const coreSpark=new THREE.Mesh(new THREE.OctahedronGeometry(.028),new THREE.MeshBasicMaterial({color:0xe1faff,toneMapped:false}));
 coreSpark.position.y=.15;core.add(coreSpark);
 const ribbons=new THREE.Group();ribbons.name='aurora-orbits';disk.add(ribbons);
 const ribbonMaterial=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});
 const tipMaterial=new THREE.MeshBasicMaterial({color:0xa6e5ef,transparent:true,opacity:.7,depthWrite:false,toneMapped:false});
 for(const [radius,start,length] of [[2.69,.24,1.5],[2.66,3.47,1.3]]){
  ribbons.add(new THREE.Mesh(ribbonGeometry(radius,start,length),ribbonMaterial));
  const angle=start+length*.90,tip=new THREE.Mesh(new THREE.OctahedronGeometry(.025),tipMaterial);
  tip.position.set(Math.sin(angle)*radius,.16+Math.sin(angle*2)*.09,Math.cos(angle)*radius);ribbons.add(tip);
 }
 let clock=0,orbit=0;
 return {
  update(dt,{velocity=0,winner=-1,settle=0,reduced=false}={}){
   const speed=Math.min(1,Math.abs(velocity)/12),step=Math.min(.05,Math.max(0,dt));
   if(!reduced){clock+=step*(1+speed*.4);orbit+=step*(.035+speed*.4);}
   uniforms.uTime.value=reduced?0:clock;uniforms.uMotion.value=reduced?0:speed;
   uniforms.uWinner.value=winner;uniforms.uSettle.value=settle;
   ribbons.visible=!reduced;ribbons.rotation.y=-orbit;
   ribbonMaterial.opacity=.44+speed*.25;crystalMaterial.emissiveIntensity=.04+speed*.025+settle*.08;
  },
 };
}
