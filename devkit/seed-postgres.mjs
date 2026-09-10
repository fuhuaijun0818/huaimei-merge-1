// Account provisioning for an explicitly named localhost development database only.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {seed} from './fixtures.mjs';
const connectionString=process.env.HUAMEI_TEAM_SEED_DATABASE_URL;
if(!connectionString)throw new Error('缺少HUAMEI_TEAM_SEED_DATABASE_URL；仅允许本机huamei_team_dev开头的开发库');
const target=new URL(connectionString),database=decodeURIComponent(target.pathname.slice(1));
if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||!/^huamei_team_dev[a-z0-9_]*$/.test(database)||target.search||process.env.NODE_ENV==='production'||process.env.HUAMEI_RUNTIME_ENV==='production')throw new Error('只允许明确命名的本机开发数据库，不接受URL查询参数或生产环境');
seed();const data=JSON.parse(readFileSync('.team-dev/state.json'));
if(!process.argv.includes('--apply')){console.log(JSON.stringify({dry_run:true,database,tenants:['team_alpha','team_beta'],accounts:data.accounts.length,requires:'迁移全部完成；仅创建模拟租户与12个岗位账号；业务样例仍在Mock中'}));process.exit(0);}
const {Client}=await import('pg');const client=new Client({connectionString,connectionTimeoutMillis:5000});await client.connect();
try{
 const actual=(await client.query('SELECT current_database() AS name')).rows[0].name;if(actual!==database)throw new Error('数据库不匹配');
 await client.query('BEGIN');
 for(const tenant of ['team_alpha','team_beta']){
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
  const prior=await client.query('SELECT settings FROM tenants WHERE tenant_id=$1',[tenant]);
  if(prior.rowCount&&prior.rows[0].settings?.devkit_seed!=='v2')throw new Error('目标模拟租户已有非本工具数据，拒绝覆盖');
  await client.query("INSERT INTO tenants(tenant_id,display_name,settings) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id) DO NOTHING",[tenant,'开发模拟机构 '+tenant,JSON.stringify({devkit_seed:'v2'})]);
  for(const a of data.accounts.filter(a=>a.tenant===tenant))await client.query(`INSERT INTO management_accounts(tenant_id,subject,account,display_name,business_role,department_ids,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,subject) DO UPDATE SET password_hash=EXCLUDED.password_hash,business_role=EXCLUDED.business_role,department_ids=EXCLUDED.department_ids,enabled=true,version=management_accounts.version+1`,[tenant,a.subject,a.username,'模拟 '+a.role,a.role,a.departments,a.password_hash]);
 }
 await client.query('COMMIT');console.log('已写入两个标记开发租户及12个模拟账号；密码保存在本机accounts.private.json。需用真实应用登录逐角色验收。');
}catch(e){await client.query('ROLLBACK');console.error('初始化失败，事务已回滚。检查迁移、权限和开发库配置。');process.exitCode=1;}finally{await client.end();}
