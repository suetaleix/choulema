import {createStage as classicStage} from '/v6/stage.js?v=ui-polish-20261007';
import {createStage as cosmicStage} from './stellar-stage.js?v=ui-polish-20261007';
import {CONTENT} from './content-catalog.mjs';

// Only shipped code can register a factory; the admin cannot supply executable URLs.
const renderers={classic:classicStage,cosmic:cosmicStage};

// Own exactly one renderer. Appearance changes retain the authoritative run.
export function createStage(mount,onActivate,onSound,reducedMotion=false){
 let stage=classicStage(mount,onActivate,onSound,reducedMotion,true),theme='classic',quality='high',reduced=reducedMotion;
 const api={
  configure(config){
   const definition=CONTENT.themes[config.theme],machine=CONTENT.machines[config.machine];
   if(!definition||!machine||!definition.machines.includes(config.machine)||!renderers[definition.renderer])throw new Error('机台呈现版本不兼容，请刷新或选择其他内容');
   const next=definition.renderer;
   if(!stage||theme!==next){
    stage?.dispose();theme=next;
    stage=renderers[next](mount,onActivate,onSound,reduced,true);
    stage.quality(quality);
   }
   mount.dataset.theme=config.theme;mount.dataset.stageMachine=config.machine;
   stage.configure({...config,machine:machine.stage_id,theme:next});
  },
  quality(value){quality=value;stage?.quality(value);},
  reduced(value){reduced=value;stage?.reduced(value);},
  dispose(){stage?.dispose();stage=null;theme=null;}
 };
 for(const key of ['background','start','reveal','revealGroups','resultPageInfo','showResultPage','finishReveal','revealDelay','reset'])api[key]=(...args)=>stage?.[key](...args);
 return api;
}
