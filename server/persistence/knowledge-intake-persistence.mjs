import { AsyncLocalStorage } from 'node:async_hooks';
import { postgres, postgresPersistenceEnabled, ensureTenant, appendAuditEvent } from './postgres-helpers.mjs';
import { createFieldEncryption } from '../platform/field-encryption.mjs';
import { normalizeTenantId } from '../platform/tenant-context.mjs';
export const knowledgeIntakeContext = new AsyncLocalStorage();
const context = (tenantId,recordId='state') => ({tenantId,scope:'knowledge.intake',recordId});
export function withKnowledgeIntake(payload, operation) {
 if (!postgresPersistenceEnabled()) return operation(payload);
 const tenantId=normalizeTenantId(typeof payload==='string'?payload:payload?.tenant_id);
 const existing=knowledgeIntakeContext.getStore();
 if(existing) {
  if(existing.tenantId!==tenantId) throw Object.assign(new Error('知识事务租户不一致'),{status:403,code:'KNOWLEDGE_TENANT_MISMATCH'});
  return operation(payload);
 }
 return postgres().tenantTransaction(tenantId,async client=>{
  await ensureTenant(client,tenantId);
  // Lock before first insert as well, so two initial writes cannot race.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['knowledge-intake:'+tenantId]);
  const result=await client.query('SELECT payload FROM knowledge_intake_state WHERE tenant_id=$1 FOR UPDATE',[tenantId]);
  const encryption=createFieldEncryption();
  const state=result.rows[0]?encryption.decryptJson(result.rows[0].payload,context(tenantId)):{version:3,documents:[],assets:[],events:[]};
  const originalEvents=new Set(state.events.map(e=>e.id));
  const tx={tenantId,client,encryption,state,dirty:false};
  const value=await knowledgeIntakeContext.run(tx,()=>operation(payload));
  if(tx.dirty){
   await client.query('INSERT INTO knowledge_intake_state(tenant_id,payload,revision) VALUES($1,$2::jsonb,1) ON CONFLICT(tenant_id) DO UPDATE SET payload=EXCLUDED.payload,revision=knowledge_intake_state.revision+1,updated_at=clock_timestamp()',[tenantId,JSON.stringify(encryption.encryptJson(tx.state,context(tenantId)))]);
   for(const event of tx.state.events.filter(e=>!originalEvents.has(e.id))) await appendAuditEvent(client,{tenantId,eventId:event.id,actorId:event.actor,actorType:'human',action:event.type,resourceType:'knowledge_intake',resourceId:event.document_id||event.asset_id,details:{version:event.version||null,department:event.department}});
  }
  return value;
 });
}
export async function persistIntakeAsset(assetId,buffer) {
 const tx=knowledgeIntakeContext.getStore();
 await tx.client.query('INSERT INTO knowledge_intake_assets(tenant_id,asset_id,payload) VALUES($1,$2,$3::jsonb)',[tx.tenantId,assetId,JSON.stringify(tx.encryption.encryptJson({base64:buffer.toString('base64')},context(tx.tenantId,assetId)))]);
}
export async function loadIntakeAsset(assetId) {
 const tx=knowledgeIntakeContext.getStore();
 const r=await tx.client.query('SELECT payload FROM knowledge_intake_assets WHERE tenant_id=$1 AND asset_id=$2',[tx.tenantId,assetId]);
 if(!r.rows[0]) return null;
 return Buffer.from(tx.encryption.decryptJson(r.rows[0].payload,context(tx.tenantId,assetId)).base64,'base64');
}
