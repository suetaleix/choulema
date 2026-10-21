// Rendering-only mechanics. Server results never depend on this simulation.
export const damp=(value,target,rate,dt)=>target+(value-target)*Math.exp(-rate*dt);
export const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*t*(t*(t*6-15)+10);};
export function landingPlan(angle,target,velocity,reduced=false){
 const tau=Math.PI*2;let distance=((target-angle)%tau+tau)%tau;
 if(reduced)return {distance,duration:.15};
 const speed=Math.max(velocity,3);
 while(distance<speed*1.2)distance+=tau;
 return {distance,duration:2*distance/speed};
}
export function stepCapsules(bodies,dt,energy,time,feedback=null){
 const radius=1.46,diameter=.52;
 for(const b of bodies){const p=b.position,v=b.userData.velocity,i=b.userData.i;
  // A rotating paddle near the bowl floor transfers tangential force on contact.
  const angle=Math.atan2(p.z,p.x),phase=time*3.5,radial=Math.hypot(p.x,p.z);
  const blade=Math.abs(Math.sin(angle-phase));
  const contact=Math.max(0,1-blade/.42)*Math.max(0,1-Math.abs(p.y+.2)/.65)*(radial<1.15?1:0);
  // Smooth, independently phased agitation: the paddle lifts the lower bed,
  // wall circulation carries capsules up, then gravity brings them back down.
  // Phases are sampled once per draw, never jittered per frame.
  const seed=b.userData.mixPhase??i*2.399963;
  const lower=Math.max(0,Math.min(1,(1.35-p.y)/1.5));
  const pulse=.65+.35*Math.sin(time*2.7+seed);
  v.x+=energy*(-p.z*6+Math.sin(time*2.1+seed)*8+Math.cos(seed)*contact*5)*dt;
  v.z+=energy*(p.x*6+Math.cos(time*2.4+seed*1.7)*8+Math.sin(seed)*contact*5)*dt;
  v.y+=(-8+energy*(lower*(7+30*pulse*pulse)+contact*15))*dt;
  const angular=b.userData.angular ||= {x:0,y:0,z:0};
  const target={x:v.z/.26+energy*Math.sin(time*1.8+seed)*3,y:energy*Math.cos(time*2+seed)*5,z:-v.x/.26};
  for(const axis of ['x','y','z'])angular[axis]=damp(angular[axis],target[axis],energy>0?3:6,dt);
  const drag=Math.exp(-(energy?1.3:2.2)*dt);v.x*=drag;v.y*=drag;v.z*=drag;
  const speed=Math.hypot(v.x,v.y,v.z);if(speed>5){v.x*=5/speed;v.y*=5/speed;v.z*=5/speed;}
  p.x+=v.x*dt;p.y+=v.y*dt;p.z+=v.z*dt;
 }
 for(let pass=0;pass<3;pass++){
  for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
   const a=bodies[i],b=bodies[j],p=a.position,q=b.position,v=a.userData.velocity,w=b.userData.velocity;
   let x=q.x-p.x,y=q.y-p.y,z=q.z-p.z,d=Math.hypot(x,y,z);if(d>=diameter)continue;
   if(d<.00001){x=1;y=0;z=0;d=0;}else{x/=d;y/=d;z/=d;}
   const correction=(diameter-Math.min(d,diameter))*.5;
   p.x-=x*correction;p.y-=y*correction;p.z-=z*correction;q.x+=x*correction;q.y+=y*correction;q.z+=z*correction;
   const closing=(w.x-v.x)*x+(w.y-v.y)*y+(w.z-v.z)*z;
   if(closing<0){const impulse=-closing*.66;v.x-=impulse*x;v.y-=impulse*y;v.z-=impulse*z;w.x+=impulse*x;w.y+=impulse*y;w.z+=impulse*z;if(feedback&&impulse>feedback.strength){feedback.strength=impulse;feedback.pan=(p.x+q.x)/3;}}
  }
  for(const b of bodies){const p=b.position,v=b.userData.velocity;const y=p.y-.78,d=Math.hypot(p.x,y,p.z);
   if(d>radius){const x=p.x/d,ny=y/d,z=p.z/d;p.x=x*radius;p.y=.78+ny*radius;p.z=z*radius;
    const outward=v.x*x+v.y*ny+v.z*z;if(outward>0){v.x-=1.45*outward*x;v.y-=1.45*outward*ny;v.z-=1.45*outward*z;if(feedback&&outward>feedback.strength){feedback.strength=outward;feedback.pan=p.x/radius;}}
   }
  }
 }
}

// Monotonic braking with continuous velocity and zero acceleration at both ends.
export function brakeProgress(t){t=Math.max(0,Math.min(1,t));return 2*t-2*t*t*t+t*t*t*t;}
export function brakeSpeed(t){t=Math.max(0,Math.min(1,t));return 2-6*t*t+4*t*t*t;}

export function paletteIndex(key){let hash=2166136261;for(const char of String(key)){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%6;}

// Equal-area Fibonacci layout: every eligible entry gets one unique sphere slot.
export function nameSphereLayout(count){
 const size=Math.min(1,Math.sqrt(36/Math.max(1,count)));
 return Array.from({length:count},(_,i)=>{
  const y=1-2*(i+.5)/count,r=Math.sqrt(1-y*y),a=Math.PI*(1+Math.sqrt(5))*i;
  return {x:2.3*r*Math.cos(a),y:2.3*y,z:2.3*r*Math.sin(a),size};
 });
}
