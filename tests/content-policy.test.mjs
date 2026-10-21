import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {appearanceProblem,accessProblem,capabilityAllowed} from '../static/v7/content-policy.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../static/v7/content-catalog.json',import.meta.url),'utf8'));
test('presentation compatibility and entitlement are independent of sale visibility',()=>{
 const cfg={machine:'sphere',theme:'cosmic',mode:'groups',count:2,items:[],sound:'slot-cosmic2'};
 assert.equal(appearanceProblem(catalog,cfg),'');assert.match(accessProblem(catalog,cfg,[]),/星空/);
 assert.equal(accessProblem(catalog,cfg,['cosmic']),'');
 assert.ok(appearanceProblem(catalog,{...cfg,machine:'wheel'}));
 assert.ok(appearanceProblem(catalog,{...cfg,sound:'slot-default1'}));
 assert.ok(appearanceProblem(catalog,cfg,{themes:{cosmic:{enabled:false}}}));
});
test('separately granted capability does not impersonate full professional membership',()=>{
 const account={features:['export_pack'],capabilities:['result_export']};
 assert.equal(capabilityAllowed(catalog,account,'result_export'),true);
 assert.equal(capabilityAllowed(catalog,account,'branding'),false);
 assert.equal(capabilityAllowed(catalog,{features:['pro'],capabilities:[]},'branding'),false);
});
