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
const evidencePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64').toString('base64');
const admin={subject:'fixture-bootstrap',roles:['administrator'],tenantId:tenant,departmentIds:['*']};
const accounts={};
for(const role of ROLE_CATALOG.filter(r=>r.key!=="superadministrator"))accounts[role.key]=await saveManagementAccount({account:'fixture-'+role.key,display_name:role.name,role:role.key,departments:['*'],password},admin);
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
// This fixture verifies the Basic-auth compatibility path.  Do not inherit a
// developer's browser-session gate, otherwise the request is rejected before
// the managed-account authenticator being tested is reached.
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HUAMEI_HOST:'127.0.0.1',HUAMEI_API_KEY:randomBytes(24).toString('hex'),HUAMEI_RUNTIME_ENV:'development',HUAMEI_EXTERNAL_TEST_MODE:'true',HUAMEI_ADMIN_SESSION_AUTH:'false',HUAMEI_LOCAL_REQUIRE_AUTH:'false',HUAMEI_ADMIN_USERNAME:'fixture-bootstrap',HUAMEI_ADMIN_PASSWORD:password,HUAMEI_PREVIEW_USERNAME:'fixture-preview',HUAMEI_PREVIEW_PASSWORD:randomBytes(24).toString('hex'),HUAMEI_PUBLIC_TENANT_ID:tenant,HUAMEI_DEFAULT_TENANT_ID:tenant,HUAMEI_ACQUISITION_TENANT_ID:tenant,HUAMEI_LLM_ENABLED:'false',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_GRAPHRAG_ENABLED:'false',HUAMEI_HR_STORE_FILE:':memory:',HUAMEI_FINANCE_STORE_FILE:':memory:',HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:JSON.stringify({active_key_id:'fixture',keys:{fixture:randomBytes(32).toString('base64')}})},stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',b=>{stderr+=b.toString();});
const exited=new Promise(resolve=>child.once('exit',resolve));
const callAccount=(account,path,body)=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Basic '+Buffer.from(`${account}:${password}`).toString('base64'),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
const call=(role,path,body)=>callAccount(`fixture-${role}`,path,body);
try{
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'HTTP fixture must start: '+stderr);
 for(const role of ROLE_CATALOG.filter(r=>r.key!=="superadministrator")){
  const response=await call(role.key,'/api/admin/identity');assert.equal(response.status,200,role.key);
  const identity=(await response.json()).data;assert.equal(identity.role,role.name);assert.deepEqual([...identity.capabilities].sort(),[...role.capabilities].sort());
  assert.equal((await call(role.key,'/')).status,200);
  assert.equal((await call(role.key,'/api/admin/accounts')).status,role.key==='administrator'?200:403);
  assert.equal((await call(role.key,'/api/admin/knowledge/publications')).status,['content','publisher','quality'].includes(role.key)?200:403);
  assert.equal((await call(role.key,'/api/admin/integrations/member-check')).status,role.key==='administrator'?200:403);
  assert.equal((await call(role.key,'/api/admin/hr')).status,role.key==='hr'?200:403,role.key+' HR permission boundary');
  assert.equal((await call(role.key,'/api/admin/hr/accounts')).status,role.key==='hr'?200:403,role.key+' HR account boundary');
  assert.equal((await call(role.key,'/api/admin/finance')).status,role.key==='finance'?200:403,role.key+' finance permission boundary');
  assert.equal((await call(role.key,'/api/admin/finance/exports/approved.xlsx')).status,role.key==='finance'?200:403,role.key+' finance export boundary');
  assert.equal((await call(role.key,'/api/admin/expense-claims')).status,200,role.key+' employee expense claim access');
 }
 const presalesIdentity=(await (await call('presales','/api/admin/identity')).json()).data;
 const employeeClaimResponse=await call('presales','/api/admin/expense-claims',{type:'payment',company:'fixture company',expense_type:'交通费',project_name:'employee submit project',amount:66.8,description:'employee claim',evidence_files:[{file_name:'receipt.png',mime_type:'image/png',data_base64:evidencePng}]});
 assert.equal(employeeClaimResponse.status,201);
 const employeeClaim=(await employeeClaimResponse.json()).data;
 assert.equal(employeeClaim.type,'expense');
 assert.equal(employeeClaim.applicant_subject,presalesIdentity.subject);
 assert.equal(employeeClaim.source,'employee_self_service');
 const financeClaims=(await (await call('finance','/api/admin/finance')).json()).data.requests;
 assert.ok(financeClaims.some(request=>request.id===employeeClaim.id),'employee expense claim must enter finance approval queue');
 const hrAccountList=await call('hr','/api/admin/hr/accounts');assert.equal(hrAccountList.status,200);
 const visibleHrAccounts=(await hrAccountList.json()).data;
 assert.ok(visibleHrAccounts.every(account=>!['系统管理员','超级管理员'].includes(account.business_role)),'HR must not see administrator accounts');
 const employeeAccount=`hr-created-${randomUUID().slice(0,8)}`;
 const createdEmployee=await call('hr','/api/admin/hr/accounts',{account:employeeAccount,display_name:'HR created employee',role:'presales',departments:['*'],enabled:true,password});
 assert.equal(createdEmployee.status,201);
 const createdEmployeeData=(await createdEmployee.json()).data;
 assert.equal(createdEmployeeData.business_role,'售前顾问');
 assert.equal((await callAccount(employeeAccount,'/api/admin/identity')).status,200,'HR-created employee can authenticate');
 const updatedEmployee=await call('hr','/api/admin/hr/accounts',{subject:createdEmployeeData.subject,expected_version:createdEmployeeData.version,display_name:'HR updated employee',role:'content',departments:['*'],enabled:true});
 assert.equal(updatedEmployee.status,201);
 assert.equal((await updatedEmployee.json()).data.business_role,'内容专员');
 assert.equal((await callAccount(employeeAccount,'/api/admin/identity')).status,200,'password reset is optional when HR updates an employee');
 assert.equal((await call('hr','/api/admin/hr/accounts',{account:`hr-admin-${randomUUID().slice(0,8)}`,display_name:'Forbidden admin',role:'administrator',departments:['*'],enabled:true,password})).status,403);
 assert.equal((await call('hr','/api/admin/hr/accounts',{account:`hr-super-${randomUUID().slice(0,8)}`,display_name:'Forbidden superadmin',role:'superadministrator',departments:['*'],enabled:true,password})).status,403);
 assert.equal((await call('hr','/api/admin/hr/accounts',{subject:accounts.hr.subject,expected_version:accounts.hr.version,display_name:'Self elevation',role:'hr',departments:['*'],enabled:true})).status,403);
 const payload={source_filename:'fixture.md',department:'整形外科',content_type:'服务流程',owner:'fixture',text_content:'Synthetic fixture for role-scoped knowledge intake. No patient or medical assertions.'};
 for(const role of ['administrator','presales','publisher','quality'])assert.equal((await call(role,'/api/admin/knowledge/intake/documents',payload)).status,403,role+' cannot edit knowledge');
 assert.equal((await call('content','/api/admin/knowledge/intake/documents',payload)).status,201);
 const constrained=await saveManagementAccount({account:'fixture-scoped',display_name:'scoped',role:'presales',departments:['整形外科'],password},admin);
 assert.equal((await call('scoped','/api/admin/appointment-intakes')).status,403,'unrouted appointments must not leak across department scopes');
 const content=accounts.content;
 const disabled=await call('administrator','/api/admin/accounts',{subject:content.subject,expected_version:1,display_name:'fixture',role:'content',departments:['*'],enabled:false});assert.equal(disabled.status,200);
 assert.equal((await call('content','/api/admin/identity')).status,403,'disabled credentials must not authenticate');
 assert.equal((await call('publisher','/api/admin/knowledge/publications',{document_ids:['missing']})).status,403);
 console.log('PASS: six real Basic accounts, HR provisioning, employee expense submission to finance approval, finance-only approval backend, role claims, content creation and immediate account revocation');
}finally{
 child.kill('SIGTERM');await Promise.race([exited,delay(1500)]);if(child.exitCode===null)child.kill('SIGKILL');await closePostgresClient();
}
