import {THEME_CHOICES,validThemeChoice} from './theme-audio-state.mjs?v=slot-review-3';

export const MACHINES=['capsule','wheel','sphere'];
export const SPIN_MS=8500;
export function resolveExperience(params,choices={}){
 const theme=params.get('theme')==='default'?'default':'cosmic';
 return {theme,machine:MACHINES.includes(params.get('machine'))?params.get('machine'):'capsule',candidate:validThemeChoice(theme,params.get('sound'))||validThemeChoice(theme,choices[theme])||THEME_CHOICES[theme][0]};
}
export function expectedRevealSeconds(machine,totalMs){
 return machine==='capsule'?3.3:Math.max(0,totalMs/1000-(machine==='sphere'?.4:0));
}
export const isRevealEvent=(machine,kind)=>kind===(machine==='capsule'?'capsule-open':`${machine}-reveal`);
export function parseNames(text){
 const names=text.split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
 if(names.length<2||names.length>48)throw new Error('请填写 2～48 个选项，每行一个。');
 if(names.some(name=>[...name].length>18))throw new Error('每个选项请控制在 18 个字以内。');
 return [...new Set(names)];
}
// All awaits belong to a generation. Leaving a round invalidates late loads/results.
export function createRoundGate(){
 let generation=0,phase='idle';
 return {
  get phase(){return phase;},
  begin(){if(phase==='loading'||phase==='running')return null;phase='loading';return ++generation;},
  active(id){return generation===id;},
  set(id,next){if(generation!==id)return false;phase=next;return true;},
  cancel(){generation++;phase='idle';}
 };
}
