const STORAGE_PREFIX='huamei.conversation-read-state.v1';

const browserStorage=()=>{
 try{return globalThis.localStorage||null;}catch{return null;}
};

const messageIds=conversation=>(conversation?.messages||[])
 .filter(message=>message.from==='customer'||message.from==='ai')
 .map((message,index)=>String(message.id||`${message.from}:${message.at}:${index}:${message.text}`));

const scopeKey=scope=>{
 const subject=typeof scope==='string'?scope:scope?.subject;
 const tenant=typeof scope==='object' ? (scope?.tenantId ?? scope?.tenant_id) : '';
 return `${String(tenant||'default')}:${String(subject||'anonymous')}`;
};

export function createConversationReadState({storage=browserStorage(),storagePrefix=STORAGE_PREFIX}={}){
 let scope='anonymous';
 let read=new Map();
 const storageKey=()=>`${storagePrefix}:${scope}`;
 const persist=()=>{
  if(!storage)return;
  const conversations=Object.fromEntries([...read].map(([id,seen])=>[id,[...seen]]));
  try{storage.setItem(storageKey(),JSON.stringify({version:1,conversations}));}catch{/* Persistence is best-effort; unread state still works in memory. */}
 };
 const restore=()=>{
  read=new Map();
  if(!storage)return;
  try{
   const parsed=JSON.parse(storage.getItem(storageKey())||'null');
   if(parsed?.version!==1||!parsed.conversations||typeof parsed.conversations!=='object')return;
   for(const [conversationId,seen] of Object.entries(parsed.conversations)){
    if(Array.isArray(seen))read.set(conversationId,new Set(seen.map(String)));
   }
  }catch{/* Corrupt browser storage must not prevent the reception page from loading. */}
 };
 restore();
 return {
  setScope(nextScope){scope=scopeKey(nextScope);restore();},
  markRead(conversation){
   if(!conversation)return;
   read.set(conversation.id,new Set(messageIds(conversation)));
   persist();
  },
  unread(conversation){
   const seen=read.get(conversation?.id)||new Set();
   return messageIds(conversation).filter(id=>!seen.has(id)).length;
  }
 };
}
