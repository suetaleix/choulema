import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {phaseAt,validChoice,validMachine,prepareReviewChoice} from '../static/v7-preview/complete-audio-state.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../static/v7-preview/soft-audio/manifest.json',import.meta.url),'utf8'));
test('twelve real playable files have complete duration, active phases and consistent loudness',()=>{
 const hashes=new Set(),levels=[];
 for(const entry of Object.values(manifest.candidates)){
  assert.deepEqual(Object.keys(entry.clips),['capsule','wheel','sphere']);
  for(const clip of Object.values(entry.clips)){
   const path=new URL('../static/v7-preview/'+clip.url.slice(2),import.meta.url);
   const bytes=fs.readFileSync(path);assert.equal(bytes.length,clip.bytes);
   assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),clip.sha256);
   hashes.add(clip.sha256);levels.push(clip.measuredLUFS);
   const run=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',fileURLToPath(path)],{encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);
   const duration=Number(JSON.parse(run.stdout).format.duration);assert.ok(duration>=16&&duration<16.1);
   assert.ok(Math.abs(clip.measuredLUFS+18)<.2);assert.ok(clip.truePeakDbTP<=-1.5);
   for(const phase of manifest.phases)assert.ok(clip.phaseRmsDbfs[phase.id]>-55,phase.id+' must contain audible activity');
   assert.ok(clip.events.some(event=>event.kind==='reveal-note'&&event.time===11.8));
  }
 }
 assert.equal(hashes.size,12);assert.ok(Math.max(...levels)-Math.min(...levels)<.2);
});
test('source licenses and transformation credits are present; no production theme assignment',()=>{
 for(const source of Object.values(manifest.sources)){
  assert.match(source.page,/^https:\/\//);assert.match(source.sha256,/^[0-9a-f]{64}$/);
  assert.ok(['CC0-1.0','CC-BY-3.0'].includes(source.license));
 }
 const credits=fs.readFileSync(new URL('../static/v7-preview/soft-audio/CREDITS.txt',import.meta.url),'utf8');
 assert.ok(credits.includes('The Berklee College of Music'));assert.ok(credits.includes('All source samples modified'));
 assert.deepEqual(manifest.themeAssignments,{default:null,cosmic:null});assert.equal(manifest.reviewOnly,true);
});
test('phase transitions handle pauses, reveal-only seek and end boundaries',()=>{
 assert.equal(phaseAt(0,manifest.phases).id,'start');assert.equal(phaseAt(10.2,manifest.phases).id,'coast');
 assert.equal(phaseAt(11.8,manifest.phases).id,'reveal');assert.equal(phaseAt(16.03,manifest.phases).id,'tail');
 assert.equal(phaseAt(-1,manifest.phases).id,'start');assert.equal(phaseAt(0,[]),null);
});
test('untrusted old choices and machine hashes fall back to valid review values',()=>{
 for(const bad of ['__proto__','constructor','../../secret',undefined,'a']){assert.equal(validChoice(bad),'');assert.equal(validMachine(bad),'capsule');}
 assert.deepEqual(prepareReviewChoice('spring','moon'),{default:'spring',cosmic:'moon'});
 assert.deepEqual(prepareReviewChoice('a','__proto__'),{default:'',cosmic:''});
});
