import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=await mkdtemp(join(tmpdir(),'huamei-read-receipts-'));
process.env.HUAMEI_LOCAL_CONVERSATION_READ_RECEIPT_STORE_FILE=join(dir,'receipts.json');
process.env.HUAMEI_PERSISTENCE_BACKEND='local_json';
const {readLocalConversationReadReceipts,writeLocalConversationReadReceipt}=await import('../server/local-conversation-store.mjs');
try {
  assert.deepEqual(readLocalConversationReadReceipts({tenant_id:'tenant-a',subject:'advisor-a'}),{});
  const first=writeLocalConversationReadReceipt({tenant_id:'tenant-a',subject:'advisor-a',conversation_id:'V-LIVE-1',message_ids:['m1','m2']});
  assert.deepEqual(first.message_ids,['m1','m2']);
  writeLocalConversationReadReceipt({tenant_id:'tenant-a',subject:'advisor-a',conversation_id:'V-LIVE-1',message_ids:['m2','m3']});
  assert.deepEqual(readLocalConversationReadReceipts({tenant_id:'tenant-a',subject:'advisor-a'}),{'V-LIVE-1':['m1','m2','m3']});
  assert.deepEqual(readLocalConversationReadReceipts({tenant_id:'tenant-a',subject:'advisor-b'}),{});
  assert.deepEqual(readLocalConversationReadReceipts({tenant_id:'tenant-b',subject:'advisor-a'}),{});
  assert.throws(()=>writeLocalConversationReadReceipt({tenant_id:'tenant-a',subject:'advisor-a',conversation_id:'V-LIVE-2',message_ids:[]}),{code:'INVALID_CONVERSATION_READ_RECEIPT'});
  console.log('PASS local read receipts persist by tenant and authenticated subject without message text');
} finally { await rm(dir,{recursive:true,force:true}); }
