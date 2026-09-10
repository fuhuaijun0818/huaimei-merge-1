import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'huamei-conversations-'));
process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE=join(dir,'conversations.json');
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE=':memory:';
const {recordLocalConversation,readLocalConversations,localConversationView}=await import('../server/local-conversation-store.mjs');
try {
const env={tenant_id:'huamei-shanghai',channel:'web',conversation_id:'visitor-test',message:{id:'m1',text:'了解热玛吉，电话13812345678',timestamp:new Date().toISOString()}};
recordLocalConversation(env,{reply:{text:'项目介绍'},profile_signals:{projects:['热玛吉']}});
recordLocalConversation(env,{reply:{text:'项目介绍'},profile_signals:{projects:['热玛吉']}});
let rows=readLocalConversations('huamei-shanghai');assert.equal(rows.length,1);assert.equal(rows[0].messages.length,2);assert.doesNotMatch(JSON.stringify(rows),/13812345678/);
assert.equal(readLocalConversations('other-tenant').length,0);
recordLocalConversation({...env,message:{...env.message,id:'m2',text:'一般原理'}},{reply:{text:'射频原理'}});
rows=readLocalConversations('huamei-shanghai');assert.equal(rows[0].messages.length,4);
const visitor=localConversationView(rows[0]);assert.equal(visitor.customer.mobile,'未留手机号');assert.equal(visitor.conversation.status,'进行中');
const captured=localConversationView(rows[0],{id:'captured-customer'},{status:'claimed'});assert.equal(captured.conversation.customerId,'captured-customer');assert.equal(captured.conversation.mode,'人工');assert.equal(captured.conversation.id,visitor.conversation.id);
console.log('PASS visitor visible before capture; messages appended; replay deduped; PII redacted; tenant isolation; capture relinks without duplicate conversation');
} finally {await rm(dir,{recursive:true,force:true});}
