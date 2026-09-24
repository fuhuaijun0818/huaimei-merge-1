import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {redactContactPii} from './platform/contact-pii-redaction.mjs';
import {postgresPersistenceEnabled} from './persistence/postgres-helpers.mjs';
import {getPostgresAcquisitionSessionStore} from './persistence/postgres-session-store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const path=()=>resolve(root,process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE||'.local-data/reception-conversations.json');
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}};
const key=(tenant,channel,id)=>createHash('sha256').update(JSON.stringify([tenant,channel,id])).digest('hex').slice(0,20);
// Match the durable PostgreSQL assistant ID.  The public UI receives this ID
// with the chat response and uses it to reconcile a short presentation reply
// with the canonical history row.
const assistantMessageIdFor=(envelope)=>`reply_${createHash('sha256')
 .update(`${String(envelope.tenant_id||'').trim().toLowerCase()}:${String(envelope.channel||'')}:${String(envelope.conversation_id||'')}\u0000${String(envelope.message?.id||'')}\u0000assistant`)
 .digest('hex')}`;
const cursorFor=(externalId,nextSeq)=>`${String(externalId||'conversation')}#${Math.max(0,Number(nextSeq)||0)}`;
const normalizeMessageMetadata=(row)=>{
 row.messages=Array.isArray(row.messages)?row.messages:[];
 row.nextSeq=Number.isInteger(row.nextSeq)?row.nextSeq:0;
 for(const message of row.messages){
  if(!Number.isInteger(message.seq))message.seq=++row.nextSeq;
  else row.nextSeq=Math.max(row.nextSeq,message.seq);
  if(!message.status)message.status='committed';
 }
 row.cursor=typeof row.cursor==='string'&&row.cursor?row.cursor:cursorFor(row.externalId,row.nextSeq);
 return row;
};
export function recordLocalConversation(envelope,response){
 if(postgresPersistenceEnabled())return;
 const records=read(path());const id=key(envelope.tenant_id,envelope.channel,envelope.conversation_id);
 const row=records[id]||{id,tenant:envelope.tenant_id,channel:envelope.channel,externalId:envelope.conversation_id,createdAt:envelope.message.timestamp||new Date().toISOString(),messages:[],nextSeq:0};
 normalizeMessageMetadata(row);
 const messageId=String(envelope.message.id);const at=envelope.message.timestamp||new Date().toISOString();
 const requestedStatus=response?.messageStatus || (response?.status==='failed'?'failed':response?.reply?.text?'committed':'processing');
 const existingMessage=row.messages.find(m=>m.id===messageId);
 if(existingMessage){
  existingMessage.status=requestedStatus;
  if(response?.error_code)existingMessage.error_code=String(response.error_code);
 }else{
  row.messages.push({id:messageId,seq:++row.nextSeq,status:requestedStatus,from:'customer',text:redactContactPii(envelope.message.text),at});
 }
 const reply=response?.reply?.text;
 const assistantMessageId=assistantMessageIdFor(envelope);
 if(reply&&!row.messages.some(m=>m.id===assistantMessageId))row.messages.push({id:assistantMessageId,seq:++row.nextSeq,status:'committed',from:response.handover?.required?'system':'ai',text:redactContactPii(reply),at:new Date().toISOString()});
 row.messages=row.messages.slice(-200);row.updatedAt=new Date().toISOString();row.cursor=cursorFor(row.externalId,row.nextSeq);row.projects=response.profile_signals?.projects||row.projects||[];records[id]=row;
 mkdirSync(dirname(path()),{recursive:true});const tmp=path()+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(records),{mode:0o600});renameSync(tmp,path());
}
export function readLocalConversations(tenant){
 if(postgresPersistenceEnabled())return [];
 const records=Object.values(read(path())).filter(r=>r.tenant===tenant);
 // Recover currently retained pre-upgrade sessions without inferring a tenant.
 const sessionPath=process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE;
 if(sessionPath!==':memory:')for(const [id,s] of Object.entries(read(resolve(root,sessionPath||'.local-data/acquisition-sessions.json')).sessions||{})){
  const prefix=tenant+':web:';if(!id.startsWith(prefix))continue;const externalId=id.slice(prefix.length);if(records.some(r=>r.channel==='web'&&r.externalId===externalId))continue;
  if(!s.turns?.length)continue;
  records.push(normalizeMessageMetadata({id:key(tenant,'web',externalId),tenant,externalId,channel:'web',projects:s.projects||[],createdAt:new Date(s.createdAt).toISOString(),updatedAt:new Date(s.updatedAt).toISOString(),messages:s.turns.map((t,i)=>({id:id+':'+i,from:t.role==='user'?'customer':'ai',text:redactContactPii(t.content||''),at:t.at||new Date(s.updatedAt).toISOString()}))}));
 }
 return records.map(normalizeMessageMetadata).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,500);
}
export async function readPersistedConversations(tenant){
 if(postgresPersistenceEnabled())return getPostgresAcquisitionSessionStore().listConversations({tenantId:tenant});
 return readLocalConversations(tenant);
}
export function localConversationView(row,customer,task){
 const customerId=customer?.id||'C-VISITOR-'+row.id;
 const visitor=customer||{id:customerId,origin:'acquisition_advisor',dataClassification:'production',name:'访客 '+row.id.slice(-6).toUpperCase(),mobile:'未留手机号',source:'在线咨询',firstChannel:'获客顾问 Web',latestChannel:'获客顾问 Web',owner:'未分配',agent:'AI获客顾问·小美',macroStage:'售前',microStage:'在线咨询',stageEnteredAt:row.createdAt,score:0,health:0,photo:null,photoConsent:'未上传',tags:['在线访客','未留资'],interests:(row.projects||[]).map(name=>({name,score:0})),pains:[],itches:[],delights:[],profile:{budget:'待确认',decision:'待确认',contact:'未留资',style:'在线咨询',concern:'',confidence:0},nextAction:{title:'继续在线沟通',reason:'访客正在咨询',guardrail:'未留资不代表授权电话回访'},timeline:[],serviceConsent:'未授权',marketingConsent:'未授权'};
 return {customer:visitor,conversation:{id:'V-LIVE-'+row.id,externalConversationId:row.externalId,customerId,channel:row.channel==='web'?'获客顾问 Web':row.channel,status:task?.status==='pending'?'待人工':task?.status==='claimed'?'人工接待':'进行中',mode:task?.status==='claimed'?'人工':'AI辅助',unread:0,updatedAt:row.updatedAt,cursor:row.cursor||cursorFor(row.externalId,row.nextSeq),lastMessage:row.messages.at(-1)?.text||'',messages:row.messages}};
}
