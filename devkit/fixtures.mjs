import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync,readFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
export const roles=['系统管理员','售前顾问','内容专员','发布与索引管理员','质量与运营人员','超级管理员'];
export const roleKeys=['admin','sales','content','publisher','quality','super'];
export const passwordHash=(value,salt=randomBytes(16).toString('hex'))=>`${salt}:${scryptSync(value,salt,64).toString('hex')}`;
export function passwordMatches(value,hash){try{const result=passwordHash(value,hash.split(':')[0]);return result.length===hash.length&&timingSafeEqual(Buffer.from(result),Buffer.from(hash));}catch{return false;}}
export function makeFixture(){
 const accounts=[],credentials=[],conversations=[],knowledge=[];
 for(const tenant of ['team_alpha','team_beta']){
  roles.forEach((role,i)=>{const username=`${tenant}_${roleKeys[i]}`,password=randomBytes(16).toString('base64url');accounts.push({username,subject:username,tenant,role,departments:['demo'],password_hash:passwordHash(password)});credentials.push({username,password,tenant,role});});
  for(let i=1;i<=3;i++)conversations.push({id:`${tenant}_conv_${i}`,tenant,customer_id:`${tenant}_customer_${i}`,name:`模拟客户${i}`,mode:i===3?'pending':'ai',version:1,assignee:null,contact:null,member:{status:'not_checked'},messages:[{id:`${tenant}_m_${i}`,seq:1,role:'user',content:['我想了解热玛吉','先了解，暂不联系','请转人工'][i-1]}]});
  knowledge.push({id:`${tenant}_public`,tenant,title:'模拟项目说明',content:'这是仅用于开发的公开项目介绍，不含真实报价和医疗结论。',version:1,status:'published',audience:'public'}, {id:`${tenant}_draft`,tenant,title:'模拟待审资料',content:'开发草稿，不应出现在对客检索。',version:1,status:'draft',audience:'internal'});
 }
 return{state:{schema:'huamei.dev.fixture.v2',mock_only:true,accounts,conversations,knowledge,appointments:[],reads:{},idempotency:{},events:[]},credentials};
}
export function seed(dir=resolve('.team-dev'),reset=false){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const statePath=join(dir,'state.json'),credentialPath=join(dir,'accounts.private.json');
 if(existsSync(statePath)&&!reset)return{created:false,statePath,credentialPath};
 const {state,credentials}=makeFixture();
 writeFileSync(statePath,JSON.stringify(state,null,2),{mode:0o600});chmodSync(statePath,0o600);
 writeFileSync(credentialPath,JSON.stringify({mock_only:true,credentials},null,2),{mode:0o600});chmodSync(credentialPath,0o600);
 return{created:true,statePath,credentialPath};
}
