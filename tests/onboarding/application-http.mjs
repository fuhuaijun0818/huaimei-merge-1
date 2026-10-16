import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,cpSync,existsSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),'huamei-http-')),checks=[];let child;
const freePort=()=>new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});
try{
 // Copy tracked source only. Never load the developer's .env or local business data.
 for(const p of execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)){
  if(p.startsWith('.env')||p.endsWith('/.env')||p.includes('/node_modules/'))continue;
  if(existsSync(p)){mkdirSync(dirname(join(dir,p)),{recursive:true});cpSync(p,join(dir,p));}
 }
 if(!existsSync('node_modules'))throw new Error('请先npm ci');symlinkSync(resolve('node_modules'),join(dir,'node_modules'),'dir');
 if(!existsSync('apps/acquisition-advisor/dist'))throw new Error('请先npm run team:build');cpSync('apps/acquisition-advisor/dist',join(dir,'apps/acquisition-advisor/dist'),{recursive:true});
 const port=await freePort(),servicePort=await freePort(),base=`http://127.0.0.1:${port}`,password=randomBytes(18).toString('base64url');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'development',PORT:String(port),HUAMEI_RUNTIME_ENV:'development',HUAMEI_HOST:'127.0.0.1',HUAMEI_ALLOWED_ORIGINS:base,HUAMEI_ACQUISITION_SERVICE_HOST:'127.0.0.1',HUAMEI_ACQUISITION_SERVICE_PORT:String(servicePort),HUAMEI_ACQUISITION_SERVICE_URL:`http://127.0.0.1:${servicePort}`,HUAMEI_PERSISTENCE_BACKEND:'local_json',HUAMEI_LLM_ENABLED:'false',HUAMEI_MEMBER_CHECK_ENABLED:'false',HUAMEI_GRAPHRAG_ENABLED:'false',HUAMEI_AGENT_ENGINE:'legacy',HUAMEI_OUTBOX_DELIVERY_ENABLED:'false',HUAMEI_ADMIN_USERNAME:'team-http-admin',HUAMEI_ADMIN_PASSWORD:password,HUAMEI_ADMIN_SESSION_AUTH:'true',HUAMEI_LOCAL_REQUIRE_AUTH:'true',HUAMEI_LOCAL_MANAGEMENT_ROLE:'超级管理员',HUAMEI_KNOWLEDGE_ROOT:join(dir,'knowledge/huamei-v1'),HUAMEI_KNOWLEDGE_APPROVAL_MODE:'preview',HUAMEI_NATURAL_DIALOGUE_ENABLED:'true',HUAMEI_UNIFIED_TURN_PLANNING_ENABLED:'true',HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED:'true'};
 let log='';child=spawn(process.execPath,['scripts/start-local-stack.mjs'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{log=(log+b).slice(-10000);});child.stderr.on('data',b=>{log=(log+b).slice(-10000);});
 let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null)throw new Error('临时应用提前退出');try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await delay(100);}assert(ready,'临时应用未就绪');
 const get=(path,options={})=>fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(10000),...options});
 const test=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name);};
 test('advisor page',(await get('/advisor/')).status,200);test('anonymous management denied',(await get('/api/admin/identity')).status,401);
 let r=await get('/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:env.HUAMEI_ADMIN_USERNAME,password})});test('login',r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
 test('authenticated session',(await get('/auth/session',{headers:{Cookie:cookie}})).status,200);
 const chat=async(message,session={})=>{const response=await get('/api/public/acquisition-chat',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({message,...session})});test('chat HTTP '+message,response.status,200);return response.json();};
 const first=await chat('我想了解热玛吉');assert(first.session_id,'会话ID');checks.push('server session ID');const second=await chat('一般原理',{session_id:first.session_id,session_token:first.session_token});assert(/热玛吉/.test(second.reply||JSON.stringify(second.reply_segments)),'追问应保持项目');checks.push('project followup context');
 r=await get('/api/public/acquisition-lead',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({mobile:'13800000001',name:'模拟HTTP客户',service_consent:true,session_id:first.session_id,session_token:first.session_token})});test('format-only contact save',r.status,200);const lead=await r.json();assert(!JSON.stringify(lead).includes('13800000001'),'公网回执应脱敏');checks.push('public receipt redacted');
 r=await get('/api/local/acquisition-customers',{headers:{Cookie:cookie}});test('management conversation query',r.status,200);const data=await r.json();assert(JSON.stringify(data).includes(first.session_id),'后台应存在同一会话ID');checks.push('same conversation frontend to backend');

 // A 模块：刷新后回读会话、重试幂等与凭证边界。
 const transcriptRequest=()=>get('/api/public/acquisition-conversation',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({session_id:first.session_id,session_token:first.session_token})});
 const transcript=await transcriptRequest();test('conversation transcript restore',transcript.status,200);
 const transcriptBody=await transcript.json();
 assert.ok(transcriptBody.messages.length>=2,'会话回读应包含客户与AI消息');assert.equal(transcriptBody.messages[0].role,'customer');checks.push('transcript message order');
 const retryKey='retry-client-message-0001';
 const sendOnce=()=>get('/api/public/acquisition-chat',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Idempotency-Key':retryKey},body:JSON.stringify({message:'重试幂等检查',client_message_id:retryKey,session_id:first.session_id,session_token:first.session_token})});
 const firstSend=await sendOnce();const firstSendBody=await firstSend.json();test('client message first send',firstSend.status,200);
 const retrySend=await sendOnce();const retrySendBody=await retrySend.json();test('client message retry',retrySend.status,200);
 assert.equal(retrySendBody.run_id,firstSendBody.run_id,'同一幂等键重试应返回同一回执');checks.push('client message retry is idempotent');
 const afterRetry=await (await transcriptRequest()).json();
 assert.equal(afterRetry.messages.filter((item)=>item.text==='重试幂等检查').length,1,'重试不得产生重复对话记录');checks.push('retry does not duplicate conversation');
 const invalidTranscript=await get('/api/public/acquisition-conversation',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({session_id:first.session_id,session_token:'invalid-token'})});
 assert.ok([400,401,403].includes(invalidTranscript.status),'无效凭证不得回读会话');checks.push('transcript rejects invalid credential');

 // A-005：流式答复（片段推送 + 最终回执）与归档一致性。
 const parseSse=(text)=>text.split('\n\n').filter((chunk)=>chunk.trim()).map((chunk)=>{
  const event={name:'message',data:null};
  for(const line of chunk.split('\n')){
   if(line.startsWith('event:'))event.name=line.slice(6).trim();
   if(line.startsWith('data:')){try{event.data=JSON.parse(line.slice(5).trim());}catch{}}
  }
  return event;
 });
 const streamBody=()=>JSON.stringify({message:'请介绍光子嫩肤的一般项目知识',client_message_id:'stream-check-1',session_id:first.session_id,session_token:first.session_token});
 const streamResponse=await get('/api/public/acquisition-chat/stream',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Idempotency-Key':'stream-check-1'},body:streamBody()});
 test('chat stream status',streamResponse.status,200);
 assert.match(streamResponse.headers.get('content-type')||'',/text\/event-stream/);checks.push('chat stream content type');
 const streamEvents=parseSse(await streamResponse.text());
 const streamDeltas=streamEvents.filter((item)=>item.name==='delta');
 const streamFinals=streamEvents.filter((item)=>item.name==='final');
 assert.ok(streamDeltas.length>=2,'流式应答应包含多个片段');assert.equal(streamFinals.length,1,'流式应答应以唯一最终回执结束');checks.push('chat stream emits deltas and one final');
 assert.equal(streamFinals[0].data.run_id,streamDeltas[0].data.run_id,'片段与最终回执必须属于同一轮次');checks.push('stream fragments share the run id');
 const streamedText=streamDeltas.map((item)=>item.data.text).join('');
 assert.equal(streamedText,(streamFinals[0].data.reply_segments||[]).join(''),'片段拼接后应与最终回执一致');checks.push('stream fragments match final receipt');
 const resumed=parseSse(await (await get('/api/public/acquisition-chat/stream',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Idempotency-Key':'stream-check-1'},body:JSON.stringify({message:'请介绍光子嫩肤的一般项目知识',client_message_id:'stream-check-1',since_seq:1,session_id:first.session_id,session_token:first.session_token})})).text());
 assert.equal(resumed.filter((item)=>item.name==='delta').length,streamDeltas.length-1,'重连只补发缺失片段');checks.push('stream resume skips delivered fragments');
 const archived=await (await transcriptRequest()).json();
 assert.ok(archived.messages.some((item)=>String(item.text||'').replace(/\s+/g,'')===streamedText.replace(/\s+/g,'')),'后台归档应与流式提交文本一致');checks.push('stream text matches archive');
 test('logout',(await get('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:base}})).status,200);test('old session rejected',(await get('/auth/session',{headers:{Cookie:cookie}})).status,401);
 mkdirSync('.team-dev',{recursive:true});const report={scope:'isolated real Node application HTTP; LLM/member disabled; local_json; not browser or PostgreSQL acceptance',passed:true,count:checks.length,checks};writeFileSync('.team-dev/application-http-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');for(let i=0;i<30&&child.exitCode===null;i++)await delay(100);if(child.exitCode===null)child.kill('SIGKILL');}
 rmSync(dir,{recursive:true,force:true});
}
