export function createConversationReadState(){
 const read=new Map();
 const ids=conversation=>(conversation.messages||[]).filter(m=>m.from!=='system').map((m,i)=>String(m.id||`${m.from}:${m.at}:${i}:${m.text}`));
 return {
  markRead(conversation){if(conversation)read.set(conversation.id,new Set(ids(conversation)));},
  unread(conversation){const seen=read.get(conversation.id)||new Set();return ids(conversation).filter(id=>!seen.has(id)).length;}
 };
}
