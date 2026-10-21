import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedStorage, importGuestDrafts} from '../static/v6/draft-storage.mjs';

const memory = () => {
  const entries = new Map();
  return {getItem:k=>entries.get(k)??null, setItem:(k,v)=>entries.set(k,v), removeItem:k=>entries.delete(k)};
};
test('sign out and another account cannot read names or pending orders', () => {
  const raw=memory(), a=scopedStorage(raw,'user:1'), b=scopedStorage(raw,'user:2'), guest=scopedStorage(raw,'guest:7');
  for(const key of ['clm-drafts','clm-prize-modes','clm-last-order','clm-checkout-pro']) {
    a.set(key,{private:'account A'});
    assert.equal(b.get(key,null),null);
    assert.equal(guest.get(key,null),null);
    assert.deepEqual(scopedStorage(raw,'user:1').get(key,null),{private:'account A'});
  }
});
test('guest login continues draft, preserves previous account draft, and consumes guest copy', () => {
  const raw=memory(), guest=scopedStorage(raw,'guest:7'), account=scopedStorage(raw,'user:1');
  const old={config:{app:'food',title:'account meal'}}, incoming={config:{app:'food',title:'guest meal'},run:{id:'merged-run'}};
  account.set('clm-drafts',{food:old,person:{config:{title:'saved class'}}});
  guest.set('clm-drafts',{food:incoming}); guest.set('clm-app','food');
  importGuestDrafts(raw,'guest:7','user:1');
  assert.deepEqual(account.get('clm-drafts',{}).food,incoming);
  assert.equal(account.get('clm-drafts',{}).person.config.title,'saved class');
  assert.deepEqual(account.get('clm-draft-recovery',[]),[old]);
  importGuestDrafts(raw,'guest:7','user:2');
  assert.deepEqual(scopedStorage(raw,'user:2').get('clm-drafts',{}),{});
  assert.deepEqual(account.get('clm-draft-recovery',[]),[old]);
});
test('failed local write retains guest data and legacy unowned data is never auto-displayed', () => {
  const raw=memory(), source=scopedStorage(raw,'guest:7');
  source.set('clm-drafts',{food:{config:{title:'keep me'}}});
  raw.setItem('clm-drafts',JSON.stringify({person:{config:{title:'unknown old account'}}}));
  const broken={...raw,setItem(){throw new Error('quota');}};
  assert.throws(()=>importGuestDrafts(broken,'guest:7','user:1'),/quota/);
  assert.equal(source.get('clm-drafts',{}).food.config.title,'keep me');
  assert.deepEqual(scopedStorage(raw,'user:1').get('clm-drafts',{}),{});
  assert.ok(raw.getItem('clm-drafts'));
});
test('opening a default guest page does not replace the returning account draft', () => {
  const raw=memory(), guest=scopedStorage(raw,'guest:7'), account=scopedStorage(raw,'user:1');
  const original={config:{title:'my existing draft'},touched:true};
  account.set('clm-drafts',{food:original});
  guest.set('clm-drafts',{food:{config:{title:'default food'},touched:false}});
  importGuestDrafts(raw,'guest:7','user:1');
  assert.deepEqual(account.get('clm-drafts',{}).food,original);
  assert.deepEqual(account.get('clm-draft-recovery',[]),[]);
});
test('interrupted migration retries without duplicating backups or replacing later edits', () => {
  const raw=memory(), guest=scopedStorage(raw,'guest:7'), account=scopedStorage(raw,'user:1');
  const old={config:{title:'old'},touched:true}, incoming={config:{title:'guest'},touched:true};
  account.set('clm-drafts',{food:old}); guest.set('clm-drafts',{food:incoming});
  let writes=0;
  const partial={...raw,setItem(k,v){if(++writes===3)throw new Error('quota');raw.setItem(k,v);}};
  assert.throws(()=>importGuestDrafts(partial,'guest:7','user:1'),/quota/);
  assert.equal(guest.get('clm-drafts',{}).food.config.title,'guest');
  importGuestDrafts(raw,'guest:7','user:1');
  assert.deepEqual(account.get('clm-draft-recovery',[]),[old]);
  // Model a failed source cleanup after the destination was committed.
  guest.set('clm-drafts',{food:incoming});
  account.set('clm-drafts',{food:{config:{title:'new account edit'},touched:true}});
  importGuestDrafts(raw,'guest:7','user:1');
  assert.equal(account.get('clm-drafts',{}).food.config.title,'new account edit');
  assert.deepEqual(guest.get('clm-drafts',{}),{});
});
