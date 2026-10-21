import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {THEME_CHOICES,validThemeChoice,sanitizeThemeChoices} from '../static/v7-preview/theme-audio-state.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../static/v7-preview/theme-audio/manifest.json',import.meta.url),'utf8'));
test('each product theme contains three distinct complete playable auditions',()=>{
 const hashes=new Set(),levels=[];
 assert.deepEqual(Object.keys(manifest.themes),['default','cosmic']);
 for(const [theme,keys] of Object.entries(THEME_CHOICES)){
  assert.equal(keys.length,3);
  for(const key of keys){
   const entry=manifest.candidates[key],clip=entry.clip;assert.equal(entry.theme,theme);
   const path=new URL('../static/v7-preview/'+clip.url.slice(2),import.meta.url),bytes=fs.readFileSync(path);
   assert.equal(bytes.length,clip.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),clip.sha256);hashes.add(clip.sha256);
   const run=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',fileURLToPath(path)],{encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);const duration=Number(JSON.parse(run.stdout).format.duration);assert.ok(duration>=16&&duration<16.1);
   levels.push(clip.measuredLUFS);assert.ok(Math.abs(clip.measuredLUFS+19)<.5);assert.ok(clip.truePeakDbTP<=-1.5);
   for(const phase of manifest.phases)assert.ok(clip.phaseRmsDbfs[phase.id]>-55,key+' '+phase.id);
   assert.ok(entry.events.some(event=>event.kind==='reveal'&&event.time===11.8));
  }
 }
 assert.equal(hashes.size,6);assert.ok(Math.max(...levels)-Math.min(...levels)<.5);
});
test('current choices reject every old audition and never cross theme boundaries',()=>{
 for(const bad of ['default1','default2','default3','cosmic1','cosmic2','cosmic3','cosmic4','cosmic5','cosmic6','aurora','a','__proto__','constructor',undefined]){
  assert.equal(validThemeChoice('default',bad),'');assert.equal(validThemeChoice('cosmic',bad),'');
 }
 assert.equal(validThemeChoice('__proto__','slot-default1'),'');
 assert.deepEqual(sanitizeThemeChoices({default:'slot-default2',cosmic:'slot-cosmic3'}),{default:'slot-default2',cosmic:'slot-cosmic3'});
 assert.deepEqual(sanitizeThemeChoices({default:'slot-cosmic1',cosmic:'slot-default1'}),{default:'',cosmic:''});
});
test('current candidates contain only original tonal assets and no foley sources',()=>{
 assert.deepEqual(manifest.sources,{});
 for(const entry of Object.values(manifest.candidates)){
  assert.deepEqual(entry.sources,[]);assert.match(entry.originalTones,/pitched rhythm only/);
  assert.equal(entry.design.noFoley,true);assert.equal(entry.design.continuousRoll,false);
  assert.equal(entry.playback.rollEnabled,false);
 }
});
test('auditions do not bind production choices and replace all six rejected arrangements',()=>{
 assert.equal(manifest.reviewOnly,true);assert.deepEqual(manifest.themeAssignments,{default:null,cosmic:null});
 assert.equal(Object.keys(manifest.candidates).length,6);assert.equal(manifest.duration,16);
 assert.equal(manifest.version,'slot-review-3');
 const previous=JSON.parse(fs.readFileSync(new URL('./fixtures/theme-audio-default-baseline.json',import.meta.url),'utf8'));
 const oldHashes=Object.values(previous).map(c=>c.sha256);
 for(const entry of Object.values(manifest.candidates))assert.ok(!oldHashes.includes(entry.clip.sha256));
});
test('four clean event assets decode without a background loop',()=>{
 for(const entry of Object.values(manifest.candidates)){
  assert.deepEqual(Object.keys(entry.slotClips),['start','pulse','stop','reveal']);
  for(const [name,clip] of Object.entries(entry.slotClips)){
   const path=new URL('../static/v7-preview/'+clip.url.slice(2),import.meta.url),bytes=fs.readFileSync(path);
   assert.equal(bytes.length,clip.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),clip.sha256);
   const file=fileURLToPath(path);
   const run=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);assert.ok(Math.abs(Number(JSON.parse(run.stdout).format.duration)-clip.duration)<.11);
   assert.ok(name==='pulse'?clip.measuredLUFS===null:Number.isFinite(clip.measuredLUFS));assert.ok(clip.truePeakDbTP<=-1.5);
   if(name==='reveal')assert.equal(clip.duration,4.2);
  }
  assert.notEqual(entry.slotClips.pulse.sha256,entry.slotClips.stop.sha256);
 }
});

