import {SOUND_PRESETS} from './sound-catalog.mjs?v=theme-release-1';
export {appearanceProblem,accessProblem,capabilityAllowed} from './content-policy.mjs';

const response=await fetch('/v7/content-catalog.json?v=8.0.0',{cache:'no-cache'});
if(!response.ok)throw new Error('内容目录加载失败，请刷新后重试');
export const CONTENT=await response.json();
if(CONTENT.schema_version!==1)throw new Error('内容版本不匹配，请刷新后重试');
export const themeSounds=theme=>(CONTENT.themes[theme]?.sounds||[]).map(id=>[id,SOUND_PRESETS[id]]).filter(([,p])=>p);
export function soundFor(theme,key){const choices=themeSounds(theme);if(!choices.length)throw new Error('该主题音效尚未交付');return choices.find(([id])=>id===key)?.[0]||choices[0][0];}
export function audioConfig(config){return {...config,machine:CONTENT.machines[config.machine]?.stage_id||config.machine,sound:soundFor(config.theme,config.sound)};}
