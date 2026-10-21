import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedbackDraft,feedbackContext} from '../static/v7/feedback-state.mjs';
import {feedbackReplies} from '../static/v7/feedback.mjs';

test('feedback retries preserve request ID and edits create a new one',()=>{
 let n=0;const draft=new FeedbackDraft(()=>`request-${++n}`);draft.bind('account1');draft.value.content='遇到一处界面问题';
 const one=draft.request({page:'play'});assert.equal(draft.request({page:'play'}).request_id,one.request_id);
 draft.value.content+='，想改进';assert.notEqual(draft.request({page:'play'}).request_id,one.request_id);
});
test('identity changes discard feedback drafts while reopening same identity preserves them',()=>{
 const draft=new FeedbackDraft(()=> 'test');draft.bind('a');draft.value.content='我的私密反馈';draft.bind('a');assert.equal(draft.value.content,'我的私密反馈');draft.bind('b');assert.equal(draft.value.content,'');
});
test('attached diagnostics exclude names, result, URL and uncontrolled values',()=>{
 const result=feedbackContext({page:'play',app:'food',machine:'sphere',theme:'cosmic',width:390,height:844,roster:['张三'],result:'秘密',url:'http://x/?token=y'});
 assert.deepEqual(result,{page:'play',app:'food',machine:'sphere',theme:'cosmic',width:390,height:844});
 assert.deepEqual(feedbackContext({width:Infinity,height:-1,theme:'secret'}),{page:'play',app:'',machine:'',theme:'',width:0,height:0});
});
test('user can opt out of diagnostic context completely',()=>{
 const draft=new FeedbackDraft(()=> 'test');draft.bind('a');draft.value.attach=false;draft.value.content='反馈内容';assert.equal(draft.request({page:'play',machine:'wheel'}).context,null);
});
test('reply markup is escaped and internal notes are absent from user rendering',()=>{
 const ticket={replies:[{status:'planned',created_at:0,reply:'<img src=x onerror=alert(1)>',internal_note:'PRIVATE <script>x</script>'}]};
 const publicHTML=feedbackReplies(ticket);assert.ok(publicHTML.includes('&lt;img'));assert.ok(!publicHTML.includes('<img'));assert.ok(!publicHTML.includes('PRIVATE'));
 const adminHTML=feedbackReplies(ticket,true);assert.ok(adminHTML.includes('PRIVATE'));assert.ok(!adminHTML.includes('<script>'));
});
