import test from 'node:test';
import assert from 'node:assert/strict';
import {EmailCodeState} from '../static/v7/email-verification.mjs';

const accepted={success:true,challenge_id:'issued',retry_after:60,expires_in:600};
test('changing address during delivery cannot attach the old challenge to the new form',async()=>{
 const state=new EmailCodeState(()=>0);let complete;
 const pending=state.request('First@Example.test',()=>new Promise(resolve=>complete=resolve));
 assert.equal(state.pending,true);state.invalidate();complete(accepted);
 assert.equal(await pending,false);assert.equal(state.valid('first@example.test'),false);
 assert.equal(state.remaining('FIRST@example.test'),60);assert.equal(state.remaining('second@example.test'),0);
});
test('resend interval, expiry, and successful replacement track the address and clock',async()=>{
 let time=0;const state=new EmailCodeState(()=>time);await state.request('one@example.test',async()=>accepted);
 assert.equal(state.valid('ONE@example.test'),true);assert.equal(state.valid('two@example.test'),false);
 await assert.rejects(state.request('one@example.test',async()=>accepted));
 time=60001;await state.request('one@example.test',async()=>({...accepted,challenge_id:'new'}));
 assert.equal(state.challenge.id,'new');time+=600000;assert.equal(state.valid('one@example.test'),false);
});
test('network uncertainty and server rate limits clear the challenge and retain retry time',async()=>{
 const state=new EmailCodeState(()=>0);
 await assert.rejects(state.request('one@example.test',async()=>{throw Object.assign(new Error('limit'),{data:{retry_after:3600}})}));
 assert.equal(state.pending,false);assert.equal(state.remaining('one@example.test'),3600);assert.equal(state.valid('one@example.test'),false);
 await assert.rejects(state.request('two@example.test',async()=>{throw new TypeError('offline')}));
 assert.equal(state.remaining('two@example.test'),60);
});
test('double send is blocked while transport is pending',async()=>{
 const state=new EmailCodeState();let complete;
 const first=state.request('one@example.test',()=>new Promise(resolve=>complete=resolve));
 await assert.rejects(state.request('two@example.test',async()=>accepted));
 complete(accepted);await first;assert.equal(state.valid('one@example.test'),true);
});
