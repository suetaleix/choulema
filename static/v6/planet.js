import * as THREE from '/vendor/three.module.js';
export function createPlanet(){
 const group=new THREE.Group();
 const uniforms={time:{value:0},energy:{value:0}};
 const surface=new THREE.Mesh(new THREE.SphereGeometry(1.22,64,40),new THREE.ShaderMaterial({uniforms,
 vertexShader:`varying vec3 n,p;void main(){p=position;n=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
 fragmentShader:`varying vec3 n,p;uniform float time,energy;
 float noise(vec3 q){return sin(q.x+sin(q.z*1.7))*sin(q.y+cos(q.x*1.3));}
 void main(){vec3 q=p*3.;q.x+=time*.025;float f=noise(q)+.4*noise(q*2.1)+.18*noise(q*4.3);
 float bands=sin(p.y*13.+f*3.);vec3 c=mix(vec3(.025,.09,.28),vec3(.17,.31,.62),.5+.5*bands);
 c=mix(c,vec3(.32,.16,.57),smoothstep(.2,.9,f));float clouds=smoothstep(.42,.88,noise(q*1.6+vec3(time*.012,0.,0.))*.6+f*.5);
 c=mix(c,vec3(.53,.75,.9),clouds*.65);float day=max(dot(normalize(n),normalize(vec3(-.8,1.,1.8))),0.);
 gl_FragColor=vec4(c*(.22+day*1.05)+vec3(.03,.08,.15)*energy,1.);}`
 }));group.add(surface);
 const air=new THREE.Mesh(new THREE.SphereGeometry(1.32,48,32),new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,side:THREE.BackSide,blending:THREE.AdditiveBlending,
 vertexShader:`varying vec3 normalView,viewDir;void main(){vec4 v=modelViewMatrix*vec4(position,1.);normalView=normalize(normalMatrix*normal);viewDir=normalize(-v.xyz);gl_Position=projectionMatrix*v;}`,
 fragmentShader:`varying vec3 normalView,viewDir;uniform float energy;void main(){float f=pow(1.-abs(dot(normalize(normalView),normalize(viewDir))),3.);gl_FragColor=vec4(vec3(.2,.48,1.),f*(.26+energy*.16));}`
 }));group.add(air);
 return {group,update(dt,energy,reduced){uniforms.time.value+=reduced?0:dt;uniforms.energy.value=energy;if(!reduced)surface.rotation.y+=dt*(.08+energy*.18);}};
}
