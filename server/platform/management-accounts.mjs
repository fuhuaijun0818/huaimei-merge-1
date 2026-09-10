import { scrypt as scryptCallback, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { postgres, postgresPersistenceEnabled, ensureTenant, appendAuditEvent } from '../persistence/postgres-helpers.mjs';
import { roleCatalogEntry } from '../../src/role-catalog.js';
import { requirePhaseOneCapability } from './phase-one-role-policy.mjs';
import { transferAccountAppointments } from '../persistence/appointment-state-store.mjs';
const scrypt=promisify(scryptCallback);
const loginFailures=new Map();
let activePasswordChecks=0;
const fail=(code,message,status=403)=>Object.assign(new Error(message),{code,status});
const safe=row=>{const {password_hash,...publicFields}=row;return publicFields;};
const principal=row=>({subject:row.subject,displayName:row.display_name,roles:[row.business_role],phaseOneRole:row.business_role,tenantIds:[row.tenant_id],departmentIds:row.department_ids,issuer:'urn:huamei:managed-account',accountVersion:row.version});
async function passwordHash(password,salt=randomBytes(16).toString('hex')){
 if(typeof password!=='string'||password.length<8||password.length>256)throw fail('PASSWORD_INVALID','密码需为8至256个字符',400);
 return `${salt}:${Buffer.from(await scrypt(password,salt,64)).toString('hex')}`;
}
export async function authenticateManagedBasic(request,tenantId){
 if(!postgresPersistenceEnabled())return null;
 const match=String(request.headers.authorization||'').match(/^Basic ([A-Za-z0-9+/=]{1,2048})$/i);if(!match)return null;
 const decoded=Buffer.from(match[1],'base64').toString('utf8');const split=decoded.indexOf(':');if(split<1)return null;
 const account=decoded.slice(0,split),password=decoded.slice(split+1);
 if(!/^[a-zA-Z0-9_.@-]{3,80}$/.test(account)||password.length<8||password.length>256)return null;
 const attemptKey=tenantId+':'+account+':'+(request.socket?.remoteAddress||'local');
 const now=Date.now();for(const [key,v] of loginFailures){if(v.until<now)loginFailures.delete(key);}
 if(activePasswordChecks>=8||loginFailures.size>=5000||(loginFailures.get(attemptKey)?.count||0)>=20)return null;
 activePasswordChecks++;
 try{
 const row=(await postgres().tenantQuery(tenantId,'SELECT * FROM management_accounts WHERE tenant_id=$1 AND account=$2',[tenantId,account])).rows[0];
 const salt=row?.password_hash?.split(':')[0]||'00000000000000000000000000000000';
 const computed=await passwordHash(password,salt);const target=row?.password_hash||`${salt}:${'0'.repeat(128)}`;
 if(!row?.enabled||computed.length!==target.length||!timingSafeEqual(Buffer.from(computed),Buffer.from(target))){const prior=loginFailures.get(attemptKey);loginFailures.set(attemptKey,{count:(prior?.count||0)+1,until:prior?.until||now+60000});return null;}
 loginFailures.delete(attemptKey);
 return principal(row);
 }finally{activePasswordChecks--;}
}
export async function applyManagementAccount(principalInput,tenantId,{required=false}={}){
 if(!postgresPersistenceEnabled()){if(required)throw fail('MANAGEMENT_ACCOUNT_STORE_REQUIRED','人员权限库尚未就绪',503);return principalInput;}
 const row=(await postgres().tenantQuery(tenantId,'SELECT * FROM management_accounts WHERE tenant_id=$1 AND subject=$2',[tenantId,principalInput.subject])).rows[0];
 if(!row){if(required)throw fail('MANAGEMENT_ACCOUNT_NOT_PROVISIONED','实名账号尚未分配本机构岗位');return principalInput;}
 if(!row.enabled)throw fail('MANAGEMENT_ACCOUNT_DISABLED','账号已停用，请联系系统管理员');
 // OIDC proves identity; current local assignment controls authorization on every request.
 return {...principalInput,...principal(row),issuer:principalInput.issuer};
}
export async function listManagementAccounts(p){
 requirePhaseOneCapability(p,'users:manage');
 return (await postgres().tenantQuery(p.tenantId,'SELECT * FROM management_accounts WHERE tenant_id=$1 ORDER BY account',[p.tenantId])).rows.filter(row=>p.departmentIds?.includes("*")||row.department_ids.every(d=>p.departmentIds?.includes(d))).map(safe);
}
export async function saveManagementAccount(input,p){
 requirePhaseOneCapability(p,'users:manage');
 if(!postgresPersistenceEnabled())throw fail('MANAGEMENT_ACCOUNT_STORE_REQUIRED','人员管理需要数据库',503);
  const role=roleCatalogEntry(input.role);
  if(role?.key==='superadministrator')requirePhaseOneCapability(p,'superadmin:manage');
 if(!role||!Array.isArray(input.departments)||!input.departments.length||input.departments.some(d=>typeof d!=='string'||!d.trim()||d.length>80))throw fail('MANAGEMENT_ASSIGNMENT_INVALID','请填写有效岗位和科室范围',400);
 const scope=new Set(p.departmentIds||[]);
 if(!scope.has('*')&&input.departments.some(d=>!scope.has(d)))throw fail('MANAGEMENT_GRANT_SCOPE_EXCEEDED','不能授予超出本人范围的科室权限');
 const hash=input.password===undefined?null:await passwordHash(input.password);
 return postgres().tenantTransaction(p.tenantId,async client=>{
  await ensureTenant(client,p.tenantId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['management-accounts:'+p.tenantId]);
  const existing=input.subject?(await client.query('SELECT * FROM management_accounts WHERE tenant_id=$1 AND subject=$2 FOR UPDATE',[p.tenantId,input.subject])).rows[0]:null;
  if(input.subject&&!existing)throw fail('MANAGEMENT_ACCOUNT_NOT_FOUND','账号不存在',404);
  if(existing?.business_role==='超级管理员')requirePhaseOneCapability(p,'superadmin:manage');
  if(existing?.business_role==='超级管理员'&&existing.enabled&&(input.enabled===false||role.key!=='superadministrator')){
   const count=(await client.query("SELECT count(*)::integer AS n FROM management_accounts WHERE tenant_id=$1 AND enabled AND business_role='超级管理员'",[p.tenantId])).rows[0].n;
   if(count<=1)throw fail('LAST_SUPERADMIN_REQUIRED','不能停用或移除最后一位超级管理员',409);
  }
  if(existing && input.expected_version!==existing.version)throw fail('MANAGEMENT_ACCOUNT_VERSION_CONFLICT','人员权限已变化，请刷新后修改',409);
  if(!existing&&!hash&&!String(input.oidc_subject||""))throw fail("MANAGEMENT_CREDENTIAL_REQUIRED","新账号必须设置密码或绑定企业身份",400);
  const enabled=input.enabled!==false;
  if(existing?.business_role==='系统管理员'&&existing.enabled&&(!enabled||role.key!=='administrator')){
   const count=(await client.query("SELECT count(*)::integer AS n FROM management_accounts WHERE tenant_id=$1 AND enabled AND business_role='系统管理员'",[p.tenantId])).rows[0].n;
   if(count<=1)throw fail('LAST_ADMINISTRATOR_REQUIRED','不能停用或移除最后一位有效系统管理员',409);
  }
  const account=existing?.account||String(input.account||'');
  if(!/^[a-zA-Z0-9_.@-]{3,80}$/.test(account)||[process.env.HUAMEI_ADMIN_USERNAME,process.env.HUAMEI_PREVIEW_USERNAME].includes(account))throw fail('MANAGEMENT_ACCOUNT_INVALID','账号格式无效或为保留登录账号',400);
  const name=String(input.display_name||'').trim();if(!name||name.length>120)throw fail('MANAGEMENT_NAME_INVALID','请填写真实姓名',400);
  const subject=existing?.subject||String(input.oidc_subject||`staff_${randomUUID()}`);
  if(!/^[A-Za-z0-9_.:@/-]{3,160}$/.test(subject))throw fail('MANAGEMENT_SUBJECT_INVALID','实名身份标识无效',400);
  if(!existing&&(await client.query('SELECT 1 FROM management_accounts WHERE tenant_id=$1 AND (subject=$2 OR account=$3)',[p.tenantId,subject,account])).rowCount)throw fail('MANAGEMENT_ACCOUNT_EXISTS','账号或实名身份已存在，请刷新后编辑现有账号',409);
  if(existing&&!scope.has('*')&&existing.department_ids.some(d=>!scope.has(d)))throw fail('MANAGEMENT_GRANT_SCOPE_EXCEEDED','不能修改超出本人范围的账号');
  const assignmentChanging=existing&&(!enabled||existing.business_role!==role.name||JSON.stringify(existing.department_ids)!==JSON.stringify(input.departments));
  let transferred={handovers:0,appointments:0};
  if(assignmentChanging){
   const active=(await client.query("SELECT id FROM handovers WHERE tenant_id=$1 AND assignee=$2 AND status='claimed' ORDER BY id FOR UPDATE",[p.tenantId,subject])).rows;
   const appointmentCount=await transferAccountAppointments(client,p.tenantId,subject);
   if(active.length||appointmentCount){
    requirePhaseOneCapability(p,'services:transfer');
    const recipient=(await client.query('SELECT * FROM management_accounts WHERE tenant_id=$1 AND subject=$2',[p.tenantId,String(input.transfer_to_subject||'')])).rows[0];
    if(!recipient||recipient.subject===subject||!recipient.enabled||recipient.business_role!=='售前顾问')throw fail('MANAGEMENT_WORK_TRANSFER_REQUIRED','该账号有在办事项，请选择有效售前顾问接收后再停用或调整岗位',409);
    if(!recipient.department_ids.includes('*')&&existing.department_ids.some(d=>!recipient.department_ids.includes(d)))throw fail('MANAGEMENT_TRANSFER_SCOPE_INVALID','接收人的科室权限不能小于原接待人的范围');
    const ids=active.map(r=>r.id);
    if(ids.length){
     await client.query('UPDATE handovers SET assignee=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[p.tenantId,ids,recipient.subject]);
     await client.query("UPDATE tasks SET assignee=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND handover_record_id=ANY($2::uuid[]) AND status IN ('pending','ready','in_progress')",[p.tenantId,ids,recipient.subject]);
    }
    transferred={handovers:ids.length,appointments:await transferAccountAppointments(client,p.tenantId,subject,recipient.subject)};
    await appendAuditEvent(client,{tenantId:p.tenantId,actorId:p.subject,actorType:'human',action:'management.work.transferred',resourceType:'management_account',resourceId:subject,details:{to_subject:recipient.subject,...transferred}});
   }
  }
  const row=(await client.query('INSERT INTO management_accounts(tenant_id,subject,account,display_name,business_role,department_ids,enabled,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,subject) DO UPDATE SET display_name=EXCLUDED.display_name,business_role=EXCLUDED.business_role,department_ids=EXCLUDED.department_ids,enabled=EXCLUDED.enabled,password_hash=COALESCE(EXCLUDED.password_hash,management_accounts.password_hash),version=management_accounts.version+1,updated_at=clock_timestamp() RETURNING *',[p.tenantId,subject,account,name,role.name,[...new Set(input.departments)],enabled,hash])).rows[0];
  await appendAuditEvent(client,{tenantId:p.tenantId,actorId:p.subject,actorType:'human',action:existing?'management.account.updated':'management.account.created',resourceType:'management_account',resourceId:subject,details:{previous_role:existing?.business_role||null,role:role.name,enabled,password_reset:Boolean(hash),version:row.version}});
  return {...safe(row),handover_required:false,transferred};
 });
}
