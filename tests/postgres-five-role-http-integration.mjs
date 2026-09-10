import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {closePostgresClient} from '../server/platform/postgres.mjs';
import {saveManagementAccount} from '../server/platform/management-accounts.mjs';
import {ROLE_CATALOG} from '../src/role-catalog.js';
assert.equal(process.env.HUAMEI_PERSISTENCE_BACKEND,'postgres');
const tenant='role-http-'+randomUUID().slice(0,8),password=randomBytes(24).toString('hex');
const admin={subject:'fixture-bootstrap',roles:['administrator'],tenantId:tenant,departmentIds:['*']};
const accounts={};
for(const role of ROLE_CATALOG.filter(r=>r.key!=="superadministrator"))accounts[role.key]=await saveManagementAccount({account:'fixture-'+role.key,display_name:role.name,role:role.key,departments:['*'],password},admin);
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HUAMEI_HOST:'127.0.0.1',HUAMEI_API_KEY:randomBytes(24).toString('hex'),HUAMEI_RUNTIME_ENV:'development',HUAMEI_EXTERNAL_TEST_MODE:'true',HUAMEI_ADMIN_USERNAME:'fixture-bootstrap',HUAMEI_ADMIN_PASSWORD:password,HUAMEI_PREVIEW_USERNAME:'fixture-preview',HUAMEI_PREVIEW_PASSWORD:randomBytes(24).toString('hex'),HUAMEI_PUBLIC_TENANT_ID:tenant,HUAMEI_DEFAULT_TENANT_ID:tenant,HUAMEI_ACQUISITION_TENANT_ID:tenant,HUAMEI_LLM_ENABLED:'false',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_GRAPHRAG_ENABLED:'false',HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:JSON.stringify({active_key_id:'fixture',keys:{fixture:randomBytes(32).toString('base64')}})},stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',b=>{stderr+=b.toString();});
const exited=new Promise(resolve=>child.once('exit',resolve));
const call=(role,path,body)=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Basic '+Buffer.from(`fixture-${role}:${password}`).toString('base64'),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
try{
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'HTTP fixture must start: '+stderr);
 for(const role of ROLE_CATALOG.filter(r=>r.key!=="superadministrator")){
  const response=await call(role.key,'/api/admin/identity');assert.equal(response.status,200,role.key);
  const identity=(await response.json()).data;assert.equal(identity.role,role.name);assert.deepEqual([...identity.capabilities].sort(),[...role.capabilities].sort());
  assert.equal((await call(role.key,'/')).status,200);
  assert.equal((await call(role.key,'/api/admin/accounts')).status,role.key==='administrator'?200:403);
  assert.equal((await call(role.key,'/api/admin/knowledge/publications')).status,['content','publisher','quality'].includes(role.key)?200:403);
  assert.equal((await call(role.key,'/api/admin/integrations/member-check')).status,role.key==='administrator'?200:403);
 }
 const payload={source_filename:'fixture.md',department:'整形外科',content_type:'服务流程',owner:'fixture',text_content:'Synthetic fixture for role-scoped knowledge intake. No patient or medical assertions.'};
 for(const role of ['administrator','presales','publisher','quality'])assert.equal((await call(role,'/api/admin/knowledge/intake/documents',payload)).status,403,role+' cannot edit knowledge');
 assert.equal((await call('content','/api/admin/knowledge/intake/documents',payload)).status,201);
 const constrained=await saveManagementAccount({account:'fixture-scoped',display_name:'scoped',role:'presales',departments:['整形外科'],password},admin);
 assert.equal((await call('scoped','/api/admin/appointment-intakes')).status,403,'unrouted appointments must not leak across department scopes');
 const content=accounts.content;
 const disabled=await call('administrator','/api/admin/accounts',{subject:content.subject,expected_version:1,display_name:'fixture',role:'content',departments:['*'],enabled:false});assert.equal(disabled.status,200);
 assert.equal((await call('content','/api/admin/identity')).status,403,'disabled credentials must not authenticate');
 assert.equal((await call('publisher','/api/admin/knowledge/publications',{document_ids:['missing']})).status,403);
 console.log('PASS: five real Basic accounts, role claims, static entry, backend permission matrix, content creation and immediate account revocation');
}finally{
 child.kill('SIGTERM');await Promise.race([exited,delay(1500)]);if(child.exitCode===null)child.kill('SIGKILL');await closePostgresClient();
}
