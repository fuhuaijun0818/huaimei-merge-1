// Uses the configured model with synthetic dialogue and isolated stores only.
// Run explicitly: node --env-file=.env.local scripts/verify-unified-turn-planning-live.mjs
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'huamei-turn-live-'));
Object.assign(process.env,{HUAMEI_PERSISTENCE_BACKEND:'local_json',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_LEAD_STORE_FILE:':memory:',HUAMEI_ACQUISITION_SESSION_STORE_FILE:':memory:',HUAMEI_LOCAL_CONVERSATION_STORE_FILE:join(dir,'conversations.json'),HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:join(dir,'operations.json')});
const {processAcquisitionEnvelope}=await import('../server/acquisition-domain-service.mjs');
const {getAcquisitionSession}=await import('../server/acquisition-session.mjs');
const messages=['我想了解一下热玛吉','一般原理','我想先缓缓，最近不太想跑医院','那还是登记下周五下午吧','改成周六上午','陈晓雨 13812345678','价格怎么算？当天面诊能直接做吗？','先不说热玛吉了，医院怎么走？'];
const results=[];
try {
  for(const [index,message] of messages.entries()) {
    const start=Date.now();
    const response=await processAcquisitionEnvelope({tenant_id:'huamei-shanghai',channel:'web',conversation_id:'unified-live-synthetic',actor:{},context:{},interests:[],message:{id:`live-${index}`,text:message,timestamp:new Date().toISOString()}});
    const session=await getAcquisitionSession('huamei-shanghai:web:unified-live-synthetic');
    const item={turn:index+1,input:message.replace(/1\d{10}/g,'[synthetic phone]'),reply:response.reply.text,planning:response.guardrails.turn_planning,source:response.guardrails.client_output_source,intent:response.profile_signals.intent,lead_status:response.lead_receipt?.status||null,willingness:session.presales_state?.willingness,slots:session.known_slots,action:response.orchestration?.action_proposal?.type||null,latency_ms:Date.now()-start};
    results.push(item);console.log(JSON.stringify(item));
  }
  const checks={every_turn_planned:results.every(r=>r.planning?.used),principle_context:/热玛吉/.test(results[1].reply)&&!/哪个项目|最想改善/.test(results[1].reply),deferral:results[2].willingness==='deferred'&&!/帮您预约|留下手机号/.test(results[2].reply),time_correction:results[4].slots.time_preference?.includes('周六'),capture:results[5].lead_status==='accepted'&&!/最想改善|哪个项目/.test(results[5].reply),multiple_questions:/费用|价格|收费/.test(results[6].reply)&&/当天|当日/.test(results[6].reply),no_fulfilled_booking:results.every(r=>!/预约成功|名额已锁定|已为您登记/.test(r.reply)),no_unexecuted_followup:results.every(r=>!/(?:稍后|届时|随后|到时).{0,18}(?:联系|同步|通知|发送)/.test(r.reply))};
  await writeFile(new URL('../docs/project-control/UNIFIED_TURN_PLANNING_LIVE_2026-09-10.json',import.meta.url),JSON.stringify({tested_at:new Date().toISOString(),scope:'real configured model; domain integration; isolated stores; external member lookup disabled',checks,results},null,2)+'\n');
  console.log(JSON.stringify({checks}));
  assert(Object.values(checks).every(Boolean),'live checks failed; see report');
} finally {await rm(dir,{recursive:true,force:true});}
