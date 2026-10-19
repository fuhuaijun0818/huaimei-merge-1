import {spawnSync} from 'node:child_process';
const tests=['acquisition-turn-planning','chat-contact-capture','acquisition-semantic-followup','presales-journey','natural-dialogue','acquisition-session','acquisition-orchestration','member-repeatcheck','lead-store','conversation-unread','admin-browser-session','phase-one-role-policy','security-redteam','concurrency-gate','graphrag-latency-optimization','domain-vocabulary','multimodal-readiness'];
const results=[];
for(const name of tests){const r=spawnSync(process.execPath,[`tests/${name}.mjs`],{stdio:'inherit',env:{...process.env,HUAMEI_LLM_ENABLED:'false',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_ACQUISITION_SESSION_STORE_FILE:':memory:',HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:':memory:',HUAMEI_LEAD_STORE_FILE:':memory:',HUAMEI_KNOWLEDGE_ROOT:'knowledge/huamei-v1'}});results.push({test:name,passed:r.status===0});}
console.log(JSON.stringify({suite:'team-baseline',results},null,2));
if(results.some(r=>!r.passed))process.exit(1);
