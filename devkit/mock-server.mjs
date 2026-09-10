import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {seed,passwordMatches} from './fixtures.mjs';
const failure=(code,status=400)=>Object.assign(new Error(code),{status});
const safeUser=u=>({username:u.username,role:u.role,tenant:u.tenant});
export async function startMock({port=4390,dir=resolve('.team-dev')}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw failure('INVALID_PORT');
 const {statePath}=seed(dir);let state=JSON.parse(readFileSync(statePath));const sessions=new Map();
 const save=()=>{writeFileSync(statePath+'.tmp',JSON.stringify(state,null,2),{mode:0o600});renameSync(statePath+'.tmp',statePath);};
 const emit=(tenant,type,id)=>{state.events.push({id:state.events.length+1,tenant,type,object_id:id});};
 const auth=req=>{const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const s=sessions.get(token);if(!s||s.expires<Date.now())throw failure('UNAUTHENTICATED',401);return state.accounts.find(a=>a.username===s.username);};
 const permit=(u,allowed)=>{if(u.role!=='超级管理员'&&!allowed.includes(u.role))throw failure('FORBIDDEN',403);};
 const scoped=(items,id,u)=>{const item=items.find(x=>x.id===id&&x.tenant===u.tenant);if(!item)throw failure('NOT_FOUND',404);return item;};
 const server=createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Huamei-Mock':'true'});res.end(JSON.stringify({mock:true,...data}));};
  try{
   const url=new URL(req.url,'http://127.0.0.1');
   if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${server.address().port}`)throw failure('ORIGIN_DENIED',403);
   if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<h1>华美开发Mock V2</h1><p>此服务仅演练契约，不是前后台真实应用。</p><p>账号在本机 .team-dev/accounts.private.json。请用配套测试或API客户端访问 /dev/v2。</p>');return;}
   if(req.method==='GET'&&url.pathname==='/dev/v2/health'){send(200,{status:'ready',schema:'huamei.dev.contract.v2'});return;}
   const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>32768)throw failure('BODY_TOO_LARGE',413);chunks.push(b);}
   let body={};try{body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};}catch{throw failure('INVALID_JSON');}
   if(req.method==='POST'&&url.pathname==='/dev/v2/login'){
    const user=state.accounts.find(a=>a.username===body.username);if(!user||!passwordMatches(String(body.password||''),user.password_hash))throw failure('INVALID_LOGIN',401);
    const token=randomUUID();sessions.set(token,{username:user.username,expires:Date.now()+3600000});send(200,{token,user:safeUser(user)});return;
   }
   const u=auth(req);let code=200,result;
   if(req.method==='POST'&&url.pathname==='/dev/v2/logout'){sessions.delete(String(req.headers.authorization).replace(/^Bearer /,''));send(200,{status:'signed_out'});return;}
   if(req.method==='GET'&&url.pathname==='/dev/v2/identity'){send(200,{user:safeUser(u)});return;}
   if(req.method==='GET'&&url.pathname==='/dev/v2/events'){
    permit(u,['售前顾问']);const cursor=Number(url.searchParams.get('after')||0);send(200,{events:state.events.filter(e=>e.tenant===u.tenant&&e.id>cursor)});return;
   }
   if(req.method==='GET'&&url.pathname==='/dev/v2/conversations'){
    permit(u,['售前顾问','质量与运营人员']);result={data:state.conversations.filter(x=>x.tenant===u.tenant).map(({contact,...c})=>({...c,unread:c.messages.filter(m=>m.seq>(state.reads[u.username+':'+c.id]||0)&&m.role!=='human').length}))};
   }else if(req.method==='GET'&&url.pathname==='/dev/v2/knowledge'){
    const internal=url.searchParams.get('audience')==='internal';if(internal)permit(u,['内容专员','发布与索引管理员']);
    result={data:state.knowledge.filter(k=>k.tenant===u.tenant&&(internal||k.status==='published'&&k.audience==='public'))};
   }else{
    const route=url.pathname.match(/^\/dev\/v2\/(conversations|appointments|knowledge)\/([A-Za-z0-9_-]+)\/(messages|contact|member|claim|release|read|appointment|reschedule|cancel|publish|withdraw)$/);
    if(req.method!=='POST'||!route)throw failure('NOT_FOUND',404);
    const [,kind,id,action]=route;
    if(kind==='knowledge')permit(u,['发布与索引管理员']);else permit(u,['售前顾问']);
    const items=state[kind],obj=scoped(items,id,u);
    const ik=String(req.headers['idempotency-key']||'');if(!/^[A-Za-z0-9_-]{3,100}$/.test(ik))throw failure('IDEMPOTENCY_KEY_REQUIRED');
    const key=u.username+':'+ik,fp=JSON.stringify({path:url.pathname,body});const prior=state.idempotency[key];
    if(prior){if(prior.fp!==fp)throw failure('IDEMPOTENCY_CONFLICT',409);send(prior.code,{...prior.result,replayed:true});return;}
    const scenario=req.headers['x-mock-scenario']||'success';
    if(scenario==='storage_failure')throw failure('STORAGE_UNAVAILABLE',503);
    if(scenario==='timeout'){await new Promise(r=>setTimeout(r,120));throw failure('UPSTREAM_TIMEOUT',504);}
    if(scenario==='conflict')throw failure('VERSION_CONFLICT',409);
    if(!['success','member_true','member_false','member_error','member_invalid'].includes(scenario))throw failure('UNKNOWN_SCENARIO');
    const version=()=>{if(body.expected_version!==obj.version)throw failure('VERSION_CONFLICT',409);};
    if(kind==='conversations'&&action==='messages'){
     if(!['user','assistant','human'].includes(body.role)||typeof body.content!=='string'||!body.content.trim()||body.content.length>1000)throw failure('INVALID_MESSAGE');
     if(body.role==='human'&&(obj.mode!=='human'||obj.assignee!==u.username))throw failure('NOT_ASSIGNEE',409);
     if(body.role==='assistant'&&obj.mode!=='ai')throw failure('AI_FENCED',409);
     const message={id:randomUUID(),seq:obj.messages.length+1,role:body.role,content:body.content};obj.messages.push(message);emit(u.tenant,'message',id);result={message,status:'committed'};
    }else if(kind==='conversations'&&action==='contact'){
     const mobile=String(body.mobile||'').replace(/[\s()-]/g,'');if(!/^1[3-9][0-9]{9}$/.test(mobile))throw failure('PHONE_INVALID');
     obj.contact={name:String(body.name||'').slice(0,40),mobile};obj.member={status:'not_checked'};result={status:'accepted',receipt_id:randomUUID(),masked_mobile:mobile.slice(0,3)+'****'+mobile.slice(-4),verification_status:'pending_manual'};
    }else if(kind==='conversations'&&action==='member'){
     if(!obj.contact)throw failure('CONTACT_REQUIRED');
     obj.member=scenario==='member_error'?{status:'failed'}:scenario==='member_invalid'?{status:'unknown'}:{status:'completed',isRepeat:scenario==='member_true',record_status:scenario==='member_true'?'existing_record':'not_found'};result={member:obj.member};
    }else if(kind==='conversations'&&action==='claim'){
     version();if(obj.mode==='human')throw failure('ALREADY_CLAIMED',409);obj.mode='human';obj.assignee=u.username;obj.version++;emit(u.tenant,'handover',id);result={mode:obj.mode,version:obj.version,assignee:obj.assignee};
    }else if(kind==='conversations'&&action==='release'){
     version();if(obj.mode!=='human'||obj.assignee!==u.username)throw failure('NOT_ASSIGNEE',409);obj.mode='ai';obj.assignee=null;obj.version++;result={mode:obj.mode,version:obj.version};emit(u.tenant,'handover',id);
    }else if(kind==='conversations'&&action==='read'){
     if(!Number.isInteger(body.seq)||body.seq<0||body.seq>obj.messages.length)throw failure('INVALID_CURSOR');state.reads[u.username+':'+id]=Math.max(body.seq,state.reads[u.username+':'+id]||0);result={read_seq:state.reads[u.username+':'+id]};
    }else if(kind==='conversations'&&action==='appointment'){
     if(!obj.contact||body.customer_confirmed!==true||!/^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date||''))throw failure('CONFIRMED_CONTACT_DATE_REQUIRED');
     if(state.appointments.some(a=>a.conversation_id===id&&a.status==='registered'))throw failure('ACTIVE_APPOINTMENT_EXISTS',409);
     const a={id:'apt_'+randomUUID(),tenant:u.tenant,conversation_id:id,status:'registered',preferred_date:body.preferred_date,version:1};state.appointments.push(a);result={appointment:a,doctor_slot_reserved:false};code=201;
    }else if(kind==='appointments'&&['reschedule','cancel'].includes(action)){
     version();if(obj.status==='cancelled')throw failure('ALREADY_CANCELLED',409);if(body.customer_confirmed!==true)throw failure('CONFIRMATION_REQUIRED');
     if(action==='reschedule'){if(!/^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date||''))throw failure('INVALID_DATE');obj.preferred_date=body.preferred_date;}else obj.status='cancelled';obj.version++;result={appointment:obj};
    }else if(kind==='knowledge'&&['publish','withdraw'].includes(action)){
     version();if(action==='publish'&&body.review_passed!==true)throw failure('REVIEW_REQUIRED');obj.status=action==='publish'?'published':'withdrawn';obj.audience='public';obj.version++;result={release:{id:obj.id,version:obj.version,status:obj.status}};emit(u.tenant,'knowledge',id);
    }else throw failure('NOT_FOUND',404);
    // Freeze receipt snapshots: later edits must not mutate an idempotent replay.
    result=structuredClone(result);state.idempotency[key]={fp,code,result};save();
   }
   send(code,result);
  }catch(e){send(e.status||500,{error:{code:e.status?e.message:'INTERNAL_ERROR'}});}
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 return{server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const app=await startMock({port:Number(process.env.HUAMEI_TEAM_MOCK_PORT||4390)});console.log(`开发Mock：${app.url}（仅本机，不接真实服务）`);for(const s of ['SIGINT','SIGTERM'])process.on(s,async()=>{await app.close();process.exit(0);});}
