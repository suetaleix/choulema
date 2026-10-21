export const emailKey=value=>String(value||'').trim().toLowerCase();

export class EmailCodeState {
 constructor(now=()=>Date.now()){this.now=now;this.revision=0;this.challenge=null;this.pending=false;this.cooldowns=new Map();}
 invalidate(){this.revision++;this.challenge=null;}
 remaining(email){return Math.max(0,Math.ceil(((this.cooldowns.get(emailKey(email))||0)-this.now())/1000));}
 valid(email){return this.challenge?.email===emailKey(email)&&this.challenge.expires>this.now();}
 async request(email,send){
  email=emailKey(email);
  if(this.pending||this.remaining(email))throw new Error('请稍后再获取验证码');
  this.invalidate();const revision=this.revision;this.pending=true;
  try{
   const result=await send(email);
   if(!result?.success||!result.challenge_id)throw new Error('未能确认发送状态，请稍后重新获取');
   this.cooldowns.set(email,this.now()+Math.max(60,Number(result.retry_after)||60)*1000);
   if(revision!==this.revision)return false;
   this.challenge={email,id:result.challenge_id,expires:this.now()+(Number(result.expires_in)||600)*1000};return true;
  }catch(error){
   const wait=Number(error.data?.retry_after)||60;
   this.cooldowns.set(email,this.now()+Math.max(1,wait)*1000);throw error;
  }finally{this.pending=false;}
 }
}
