import { randomBytes, createHash } from 'node:crypto';
export function createAdminSessions({now=Date.now,idleMs=30*60_000,absoluteMs=8*60*60_000}={}) {
  const sessions=new Map(), attempts=new Map();
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const token=req=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('huamei_admin_session='))?.slice(21)||'';
  const cleanup=()=>{for(const [key,s] of sessions)if(now()-s.last>=idleMs||now()-s.created>=absoluteMs)sessions.delete(key);for(const [key,a] of attempts)if(a.until<=now())attempts.delete(key);};
  return {
    cookie(value,secure=false){return `huamei_admin_session=${value}; Path=/; HttpOnly; SameSite=Strict${secure?'; Secure':''}${value?'':'; Max-Age=0'}`;},
    issue(req,principal){cleanup();if(sessions.size>=5000)throw new Error('会话数量已达上限');this.revoke(req);const value=randomBytes(32).toString('hex');sessions.set(hash(value),{principal,created:now(),last:now()});return value;},
    read(req,{touch=true}={}){cleanup();const s=sessions.get(hash(token(req)));if(!s)return null;if(touch)s.last=now();return s;},
    revoke(req){sessions.delete(hash(token(req)));},
    allowLogin(req){cleanup();const key=hash(req.socket.remoteAddress||'unknown');const a=attempts.get(key)||{count:0,until:now()+60_000};if(a.count>=15||attempts.size>=5000&&!attempts.has(key))return false;a.count++;attempts.set(key,a);return true;}
  };
}
export async function readLoginBody(request) {
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))throw new Error('请使用登录表单提交');
  let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>4096)throw new Error('登录信息过长');}
  const value=JSON.parse(body);
  if(typeof value?.username!=='string'||typeof value?.password!=='string'||!value.username.trim()||value.username.includes(':')||value.username.length>128||value.password.length<8||value.password.length>1024)throw new Error('请输入有效的账号和密码');
  return {username:value.username.trim(),password:value.password};
}
