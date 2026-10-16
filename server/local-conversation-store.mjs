import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {redactContactPii} from './platform/contact-pii-redaction.mjs';
import {postgresPersistenceEnabled} from './persistence/postgres-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const path=()=>resolve(root,process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE||'.local-data/reception-conversations.json');
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}};
const key=(tenant,channel,id)=>createHash('sha256').update(JSON.stringify([tenant,channel,id])).digest('hex').slice(0,20);
export function recordLocalConversation(envelope,response){
 if(postgresPersistenceEnabled())return;
 const records=read(path());const id=key(envelope.tenant_id,envelope.channel,envelope.conversation_id);
 const row=records[id]||{id,tenant:envelope.tenant_id,channel:envelope.channel,externalId:envelope.conversation_id,createdAt:envelope.message.timestamp||new Date().toISOString(),messages:[]};
 const messageId=String(envelope.message.id);const at=envelope.message.timestamp||new Date().toISOString();
 if(!row.messages.some(m=>m.id===messageId))row.messages.push({id:messageId,from:'customer',text:redactContactPii(envelope.message.text),at});
 const reply=response.reply?.text;
 if(reply&&!row.messages.some(m=>m.id===messageId+':reply'))row.messages.push({id:messageId+':reply',from:response.handover?.required?'system':'ai',text:redactContactPii(reply),at:new Date().toISOString()});
 row.messages=row.messages.slice(-200);row.updatedAt=new Date().toISOString();row.projects=response.profile_signals?.projects||row.projects||[];records[id]=row;
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
  records.push({id:key(tenant,'web',externalId),tenant,externalId,channel:'web',projects:s.projects||[],createdAt:new Date(s.createdAt).toISOString(),updatedAt:new Date(s.updatedAt).toISOString(),messages:s.turns.map((t,i)=>({id:id+':'+i,from:t.role==='user'?'customer':'ai',text:redactContactPii(t.content||''),at:t.at||new Date(s.updatedAt).toISOString()}))});
 }
 return records.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,500);
}

/**
 * 客户侧回读自己这一段会话。只按租户+渠道+会话编号精确取一条，不做模糊匹配，
 * 也不返回其他访客的记录。
 */
export function readLocalConversationRecord(tenant,channel,externalId){
 if(postgresPersistenceEnabled())return null;
 const row=read(path())[key(tenant,channel,externalId)];
 return row?JSON.parse(JSON.stringify(row)):null;
}

/**
 * 人工回复也要落进同一条会话记录，客户页才能按来源标识人工消息。
 * 幂等：同一个消息ID重复写入不会产生第二条。
 */
export function appendLocalConversationMessage({tenant,channel,conversationId,from='human',text,at,messageId}={}){
 if(postgresPersistenceEnabled())return null;
 const safeText=String(text||'').trim().slice(0,1000);
 if(!safeText)return null;
 const records=read(path());const id=key(tenant,channel,conversationId);const now=new Date().toISOString();
 const row=records[id]||{id,tenant,channel,externalId:conversationId,createdAt:at||now,messages:[]};
 const resolvedId=String(messageId||`msg_${randomUUID()}`);
 if(!row.messages.some(m=>m.id===resolvedId))row.messages.push({id:resolvedId,from,text:redactContactPii(safeText),at:at||now});
 row.messages=row.messages.slice(-200);row.updatedAt=now;records[id]=row;
 mkdirSync(dirname(path()),{recursive:true});const tmp=path()+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(records),{mode:0o600});renameSync(tmp,path());
 return JSON.parse(JSON.stringify(row.messages.at(-1)));
}
export function localConversationView(row,customer,task){
 const customerId=customer?.id||'C-VISITOR-'+row.id;
 const visitor=customer||{id:customerId,origin:'acquisition_advisor',dataClassification:'production',name:'访客 '+row.id.slice(-6).toUpperCase(),mobile:'未留手机号',source:'在线咨询',firstChannel:'获客顾问 Web',latestChannel:'获客顾问 Web',owner:'未分配',agent:'AI获客顾问·小美',macroStage:'售前',microStage:'在线咨询',stageEnteredAt:row.createdAt,score:0,health:0,photo:null,photoConsent:'未上传',tags:['在线访客','未留资'],interests:(row.projects||[]).map(name=>({name,score:0})),pains:[],itches:[],delights:[],profile:{budget:'待确认',decision:'待确认',contact:'未留资',style:'在线咨询',concern:'',confidence:0},nextAction:{title:'继续在线沟通',reason:'访客正在咨询',guardrail:'未留资不代表授权电话回访'},timeline:[],serviceConsent:'未授权',marketingConsent:'未授权'};
 return {customer:visitor,conversation:{id:'V-LIVE-'+row.id,externalConversationId:row.externalId,customerId,channel:row.channel==='web'?'获客顾问 Web':row.channel,status:task?.status==='pending'?'待人工':task?.status==='claimed'?'人工接待':'进行中',mode:task?.status==='claimed'?'人工':'AI辅助',unread:0,updatedAt:row.updatedAt,lastMessage:row.messages.at(-1)?.text||'',messages:row.messages}};
}
