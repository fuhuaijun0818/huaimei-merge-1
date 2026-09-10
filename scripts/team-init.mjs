import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(existsSync('.env.local')){console.log('保留已有 .env.local，未覆盖。');process.exit(0);}
const password=randomBytes(18).toString('base64url');
const overrides={HUAMEI_RUNTIME_ENV:'development',HUAMEI_PERSISTENCE_BACKEND:'local_json',HUAMEI_KNOWLEDGE_ROOT:'knowledge/huamei-v1',HUAMEI_PUBLIC_MATERIALS_ROOT:'',HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT:'',HUAMEI_KNOWLEDGE_APPROVAL_MODE:'preview',HUAMEI_LLM_ENABLED:'false',HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED:'true',HUAMEI_NATURAL_DIALOGUE_ENABLED:'true',HUAMEI_UNIFIED_TURN_PLANNING_ENABLED:'true',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_GRAPHRAG_ENABLED:'false',HUAMEI_AGENT_ENGINE:'legacy',HUAMEI_OUTBOX_DELIVERY_ENABLED:'false',HUAMEI_ADMIN_USERNAME:'teamadmin',HUAMEI_ADMIN_PASSWORD:password,HUAMEI_LOCAL_MANAGEMENT_ROLE:'超级管理员',HUAMEI_ADMIN_SESSION_AUTH:'true',HUAMEI_LOCAL_REQUIRE_AUTH:'true'};
const lines=readFileSync('.env.example','utf8').split('\n').filter(l=>!Object.keys(overrides).some(k=>l.startsWith(k+'=')));
writeFileSync('.env.local',lines.join('\n')+'\n'+Object.entries(overrides).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log(`仅本机开发账号：teamadmin\n开发密码：${password}\n配置已写入被Git忽略的.env.local。外部模型和院方查询默认关闭。`);
