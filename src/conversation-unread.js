const STORAGE_PREFIX='huamei.conversation-read-state.v1';

const browserStorage=()=>{
 try{return globalThis.localStorage||null;}catch{return null;}
};

const messageIds=conversation=>(conversation?.messages||[])
 .filter(message=>message.from==='customer'||message.from==='ai')
 .map((message,index)=>String(message.id||`${message.from}:${message.at}:${index}:${message.text}`));

const receiptIds=value=>Array.isArray(value)
 ? [...new Set(value.map(String).filter(id=>id&&id.length<=256))].slice(-200)
 : [];

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
  // Server receipts are merged rather than replacing local state, so an
  // offline read in this tab cannot be lost when the next signed-in snapshot
  // is hydrated.  The receipt contains message identifiers only, never text.
  mergeReceipts(receipts){
   if(!receipts||typeof receipts!=='object'||Array.isArray(receipts))return;
   for(const [conversationId,seen] of Object.entries(receipts)){
    const ids=receiptIds(seen);if(!ids.length)continue;
    const existing=read.get(conversationId)||new Set();
    ids.forEach(id=>existing.add(id));read.set(conversationId,existing);
   }
   persist();
  },
  receiptFor(conversation){
   if(!conversation?.id)return [];
   return receiptIds([...((read.get(conversation.id))||new Set())]);
  },
  unread(conversation){
   const seen=read.get(conversation?.id)||new Set();
   return messageIds(conversation).filter(id=>!seen.has(id)).length;
  },
  lastReadMessageId(conversation){
   const messages=messageIds(conversation);
   const seen=read.get(conversation?.id)||new Set();
   for(let index=messages.length-1;index>=0;index--)if(seen.has(messages[index]))return messages[index];
   return null;
  }
 };
}
