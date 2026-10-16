import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withKnowledgeIntake, knowledgeIntakeContext } from './persistence/knowledge-intake-persistence.mjs';
import { postgresPersistenceEnabled, appendAuditEvent } from './persistence/postgres-helpers.mjs';
import { knowledgeIntakeReadiness } from './knowledge-intake-store.mjs';
import { requirePhaseOneCapability, hasPhaseOneCapability } from './platform/phase-one-role-policy.mjs';
import { validateProductionEvaluationSubmission } from '../scripts/production-evaluation-policy.mjs';
import { canonicalJsonBytes, verifyEvidenceDocumentAttestation, trustedSignerRegistryFromEnv } from '../scripts/formal-evidence-common.mjs';
const hash = value=>createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
// Evaluation reports are persisted as PostgreSQL jsonb, whose object-key order
// is not the browser submission order.  Use canonical bytes for their stored
// integrity reference so the proof remains valid after a database round trip.
export const evidenceHash = value=>createHash('sha256').update(canonicalJsonBytes(value ?? null)).digest('hex');
const error=(code,message,status=409)=>Object.assign(new Error(message),{code,message,status});
const scope=(p,id)=>({tenantId:p.tenantId,scope:'knowledge.publication',recordId:id});
const accessible=(p,document)=>p.departmentIds?.includes('*')||p.departmentIds?.includes(document.department);
function transaction(p,operation) {
 if(!postgresPersistenceEnabled()) throw error('KNOWLEDGE_PUBLICATION_REQUIRES_POSTGRES','正式发布需要数据库持久化',503);
 return withKnowledgeIntake({tenant_id:p.tenantId},async()=>{
  const tx=knowledgeIntakeContext.getStore();
  await tx.client.query('INSERT INTO knowledge_publication_heads(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[p.tenantId]);
  const head=(await tx.client.query('SELECT * FROM knowledge_publication_heads WHERE tenant_id=$1 FOR UPDATE',[p.tenantId])).rows[0];
  return operation(tx,head);
 });
}
const unpack=(tx,row)=>tx.encryption.decryptJson(row.payload,scope(tx,row.package_id));
const safePackage=(pkg,head,events=[],usable=true)=>({id:pkg.id,checksum:pkg.checksum,created_at:pkg.created_at,created_by:pkg.created_by,
 documents:pkg.documents.map(d=>({id:d.id,title:d.title,version:d.version,department:d.department,expires_at:d.expires_at})),
 content_version:pkg.checksum,text_index_version:pkg.text_index.version,graph_version:pkg.graph.version,rule_version:pkg.rule_version,
 media_version:pkg.media_version,head_revision:Number(head.revision),active:head.package_id===pkg.id&&usable,
 status:head.package_id===pkg.id?(usable?'active':'suspended'):events.some(e=>e.kind==='withdrawn')?'withdrawn':events.some(e=>e.kind==='evaluation_passed')?'evaluated':'awaiting_evaluation',
 graph_engine:pkg.graph.engine,chunk_count:pkg.text_index.chunks.length,evaluation_required:true});
function validEvaluationProof(tx,pkg,proof){
 try{
  if(!(Date.parse(proof?.expires_at)>Date.now())||!proof?.signed_report)return false;
  const report=tx.encryption.decryptJson(proof.signed_report,scope(tx,'evaluation:'+pkg.id));
  return evidenceHash(report)===proof.report_sha256&&report.package_checksum===pkg.checksum&&verifyEvidenceDocumentAttestation(report,{evidenceKind:'evaluation_report',trustedSigners:trustedSignerRegistryFromEnv()}).ok;
 }catch{return false;}
}
function assertSource(tx,p,documents){
 for(const doc of documents){
  const current=tx.state.documents.find(d=>d.id===doc.id);
  if(!current||!accessible(p,current)) throw error('KNOWLEDGE_DOCUMENT_FORBIDDEN','资料不存在或不在授权科室范围',403);
  if(current.version!==doc.version||current.content_hash!==doc.content_hash||hash(current.hospital_confirmation)!==hash(doc.hospital_confirmation)) throw error('KNOWLEDGE_SOURCE_CHANGED','资料或院方依据已变化，请重新构建候选包');
  if(!knowledgeIntakeReadiness(current).ready||Date.parse(current.effective_at)>Date.now()||current.status!=='release_candidate') throw error('KNOWLEDGE_SOURCE_NOT_ELIGIBLE','资料、公开授权或院方确认依据不再有效');
 }
}
function build(documents){
 const chunks=documents.flatMap(d=>{
  const result=[];for(let start=0;start<d.raw_text.length;start+=780){const content=d.raw_text.slice(start,start+900);result.push({record_id:`${d.id}:v${d.version}:${result.length+1}`,document_id:d.id,title:d.title,content,source_reference:d.source_reference,expires_at:d.expires_at,tags:d.tags||[]});}return result;
 });
 // Evidence-linked graph of declared topics, not inferred medical capability.
 const entities=[...new Set(documents.flatMap(d=>d.tags||[]))].map(name=>({id:hash(name),name,type:'declared_topic'}));
 const relationships=chunks.flatMap(c=>entities.filter(e=>c.content.includes(e.name)).map(e=>({source:c.document_id,target:e.id,type:'mentions',evidence_record_id:c.record_id,evidence:e.name,expires_at:c.expires_at})));
 const graph={engine:'evidence-linked-extractive-v1',entities,relationships,communities:entities.map(e=>({entity_id:e.id,evidence_record_ids:relationships.filter(r=>r.target===e.id).map(r=>r.evidence_record_id)}))};
 return {text_index:{version:hash(chunks),chunks},graph:{...graph,version:hash(graph)}};
}
export async function listKnowledgePublications(principal){
 if(!hasPhaseOneCapability(principal,'evaluations:read')) requirePhaseOneCapability(principal,'knowledge:read');
 return transaction(principal,async(tx,head)=>{
  const rows=(await tx.client.query('SELECT * FROM knowledge_publication_packages WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[principal.tenantId])).rows;
  const events=(await tx.client.query('SELECT package_id,kind,payload FROM knowledge_publication_events WHERE tenant_id=$1',[principal.tenantId])).rows;
  return rows.map(row=>unpack(tx,row)).filter(pkg=>pkg.documents.every(d=>accessible(principal,d))).map(pkg=>{const history=events.filter(e=>e.package_id===pkg.id);let usable=true;try{assertSource(tx,principal,pkg.documents);}catch{usable=false;}usable=usable&&history.some(e=>e.kind==='evaluation_passed'&&validEvaluationProof(tx,pkg,e.payload.proof));return safePackage(pkg,head,history,usable);});
 });
}
export async function createKnowledgePublication(input,principal){
 requirePhaseOneCapability(principal,'knowledge:publish');
 if(!Array.isArray(input.document_ids)||!input.document_ids.length||input.document_ids.length>100||new Set(input.document_ids).size!==input.document_ids.length) throw error('KNOWLEDGE_SELECTION_INVALID','请选择1至100份不重复的候选资料',400);
 return transaction(principal,async(tx,head)=>{
  const intent=hash([...input.document_ids].sort());
  const prior=(await tx.client.query('SELECT * FROM knowledge_publication_packages WHERE tenant_id=$1 AND request_key=$2',[principal.tenantId,input.idempotency_key])).rows[0];
  if(prior){const pkg=unpack(tx,prior);if(!pkg.documents.every(d=>accessible(principal,d)))throw error('KNOWLEDGE_DOCUMENT_FORBIDDEN','资料超出授权科室',403);if(pkg.intent!==intent)throw error('IDEMPOTENCY_CONFLICT','同一请求标识对应不同内容');return safePackage(pkg,head);}
  const documents=input.document_ids.map(id=>tx.state.documents.find(d=>d.id===id));
  if(documents.some(d=>!d))throw error('KNOWLEDGE_DOCUMENT_FORBIDDEN','资料不存在或不可访问',403);
  assertSource(tx,principal,documents);
  const snapshots=documents.map(({versions,mutations,...document})=>document);
  // Never index phones, chat exports or restricted originals as ordinary knowledge.
  if(snapshots.some(d=>/(?:\b1[3-9]\d{9}\b|身份证号|患者姓名|聊天记录导出)/u.test(d.raw_text)))throw error('KNOWLEDGE_CONTACT_DATA_FORBIDDEN','候选正文包含可能的客户个人信息，请先脱敏',400);
  const compiled=build(snapshots);const id=`kpub_${randomUUID()}`;
  const pkg={id,intent,created_at:new Date().toISOString(),created_by:principal.subject,documents:snapshots,...compiled,rule_version:'huamei-public-evidence-v1',media_version:hash([]),media:[]};
  pkg.checksum=hash(pkg);
  await tx.client.query('INSERT INTO knowledge_publication_packages(tenant_id,package_id,request_key,checksum,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[principal.tenantId,id,input.idempotency_key,pkg.checksum,JSON.stringify(tx.encryption.encryptJson(pkg,scope(tx,id)))]);
  await appendAuditEvent(tx.client,{tenantId:principal.tenantId,actorId:principal.subject,actorType:'human',action:'knowledge.package.built',resourceType:'knowledge_publication',resourceId:id,details:{checksum:pkg.checksum,documents:snapshots.length}});
  return safePackage(pkg,head);
 });
}
export async function mutateKnowledgePublication(id,action,input,principal){
 const capabilities={evaluate:'evaluations:run',activate:'knowledge:publish',rollback:'knowledge:rollback',withdraw:'knowledge:withdraw'};
 if(!capabilities[action])throw error('KNOWLEDGE_ACTION_INVALID','未知发布操作',400);
 requirePhaseOneCapability(principal,capabilities[action]);
 return transaction(principal,async(tx,head)=>{
  const row=(await tx.client.query('SELECT * FROM knowledge_publication_packages WHERE tenant_id=$1 AND package_id=$2',[principal.tenantId,id])).rows[0];
  if(!row)throw error('KNOWLEDGE_PACKAGE_NOT_FOUND','发布包不存在',404);
  const pkg=unpack(tx,row);
  if(!pkg.documents.every(d=>accessible(principal,d)))throw error('KNOWLEDGE_DEPARTMENT_FORBIDDEN','发布包超出授权科室',403);
  const intent=hash({id,action,input:{...input,idempotency_key:undefined}});
  const previous=(await tx.client.query('SELECT payload FROM knowledge_publication_events WHERE tenant_id=$1 AND request_key=$2',[principal.tenantId,input.idempotency_key])).rows[0];
  if(previous){if(previous.payload.intent!==intent)throw error('IDEMPOTENCY_CONFLICT','同一请求标识对应不同操作');return previous.payload.result;}
  const events=(await tx.client.query('SELECT kind,payload FROM knowledge_publication_events WHERE tenant_id=$1 AND package_id=$2 ORDER BY created_at DESC',[principal.tenantId,id])).rows;
  // 操作前的启用包就是本次回滚/激活的“原版”；记下来才能满足回滚事件的可追溯要求。
  const fromPackageId=head.package_id?String(head.package_id):null;
  const fromRevision=Number(head.revision);
  let kind=action,proof={};
  if(action==='evaluate'){
   assertSource(tx,principal,pkg.documents);
   const report=input.report;
   const attestation=verifyEvidenceDocumentAttestation(report,{evidenceKind:'evaluation_report',trustedSigners:trustedSignerRegistryFromEnv()});
   const checks=validateProductionEvaluationSubmission(report||{});
   if(!attestation.ok||!checks.ok||report?.package_checksum!==pkg.checksum||report?.text_index_version!==pkg.text_index.version||report?.graph_version!==pkg.graph.version||Date.parse(report?.expires_at)<=Date.now()||!Number.isFinite(Date.parse(report?.expires_at)))throw error('KNOWLEDGE_EVALUATION_REJECTED','评测签名、版本绑定、有效期或质量门槛未通过',400);
   proof={report_sha256:evidenceHash(report),expires_at:report.expires_at,signed_report:tx.encryption.encryptJson(report,scope(tx,'evaluation:'+pkg.id))};kind='evaluation_passed';
  }else{
   if(input.confirmed!==true||typeof input.reason!=='string'||!input.reason.trim())throw error('KNOWLEDGE_CONFIRMATION_REQUIRED','请确认目标并填写操作原因',400);
   if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision!==Number(head.revision))throw error('KNOWLEDGE_HEAD_CONFLICT','当前发布版本已变化，请刷新后重试');
   if(action!=='withdraw'){
    assertSource(tx,principal,pkg.documents);
    if(events.some(e=>e.kind==='withdrawn'))throw error('KNOWLEDGE_PACKAGE_WITHDRAWN','已撤销的发布包不能重新激活');
    if(!events.some(e=>e.kind==='evaluation_passed'&&validEvaluationProof(tx,pkg,e.payload.proof)))throw error('KNOWLEDGE_EVALUATION_REQUIRED','发布包缺少有效且通过的正式评测');
    if(action==='rollback'&&!events.some(e=>['activate','rollback'].includes(e.kind)))throw error('KNOWLEDGE_ROLLBACK_TARGET_INVALID','回滚目标必须是曾启用的有效发布包');
    await tx.client.query('UPDATE knowledge_publication_heads SET package_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1',[principal.tenantId,id]);head.package_id=id;head.revision=Number(head.revision)+1;
   }else{kind='withdrawn';if(head.package_id===id){await tx.client.query('UPDATE knowledge_publication_heads SET package_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1',[principal.tenantId]);head.package_id=null;head.revision=Number(head.revision)+1;}}
  }
  const result=safePackage(pkg,head,[...events,{kind}]);
  await tx.client.query('INSERT INTO knowledge_publication_events(tenant_id,request_key,package_id,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[principal.tenantId,input.idempotency_key,id,kind,JSON.stringify({intent,actor:principal.subject,reason:input.reason||null,proof,result,from_package_id:fromPackageId,from_revision:fromRevision})]);
  await appendAuditEvent(tx.client,{tenantId:principal.tenantId,actorId:principal.subject,actorType:'human',action:`knowledge.package.${kind}`,resourceType:'knowledge_publication',resourceId:id,details:{checksum:pkg.checksum,head_revision:Number(head.revision),from_package_id:fromPackageId,from_revision:fromRevision}});
  return result;
 });
}
export const publicationRequestContext=new AsyncLocalStorage();
export async function loadActivePublication(tenantId){
 if(!postgresPersistenceEnabled())return null;
 return transaction({tenantId,departmentIds:['*']},async(tx,head)=>{
  if(!head.package_id)return {tenantId,revision:Number(head.revision),package:null};
  const row=(await tx.client.query('SELECT * FROM knowledge_publication_packages WHERE tenant_id=$1 AND package_id=$2',[tenantId,head.package_id])).rows[0];
  if(!row)throw error('KNOWLEDGE_ACTIVE_PACKAGE_MISSING','当前发布包不可用',503);
  const pkg=unpack(tx,row);
  try{assertSource(tx,{departmentIds:['*']},pkg.documents);}catch{return {tenantId,revision:Number(head.revision),package:null};}
  const proof=(await tx.client.query("SELECT payload FROM knowledge_publication_events WHERE tenant_id=$1 AND package_id=$2 AND kind='evaluation_passed' ORDER BY created_at DESC",[tenantId,pkg.id])).rows;
  if(!proof.some(p=>validEvaluationProof(tx,pkg,p.payload.proof)))return {tenantId,revision:Number(head.revision),package:null};
  return {tenantId,revision:Number(head.revision),package:pkg};
 });
}
