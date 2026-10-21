import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/v6/studio.js',import.meta.url),'utf8');
const startup=source.slice(source.indexOf('// Each visit starts with the full experience'),source.indexOf("$('#stage').addEventListener('resultpagechange'"));
test('entering the game restores high quality and full animation even after a simplified session',()=>{
 const fields={'#quality':{value:'low'},'#reduceMotion':{checked:true}};
 const env={$:id=>fields[id],storage:{get:()=>true},matchMedia:()=>({matches:true})};
 vm.runInNewContext(startup,env);
 assert.equal(fields['#quality'].value,'high');
 assert.equal(fields['#reduceMotion'].checked,false);
 // A manual choice applies to this visit, then startup restores the full experience.
 const changes=[];
 vm.runInNewContext(source.match(/\$\('#reduceMotion'\)\.onchange=e=>\{[^}]+\};/)[0],{...env,stage:{reduced:value=>changes.push(value)}});
 fields['#reduceMotion'].onchange({target:{checked:true}});
 assert.deepEqual(changes,[true]);
 fields['#reduceMotion'].checked=true;
 vm.runInNewContext(startup,env);
 assert.equal(fields['#reduceMotion'].checked,false);
});
