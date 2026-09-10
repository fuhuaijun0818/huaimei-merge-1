// Only conversational / informational routes can be refined. Safety, prices,
// products, doctors, appointments and contact capture retain authoritative rules.
export const SEMANTIC_REFINABLE_INTENTS=new Set(['need_clarification','conversation_followup','project_discovery_by_concern']);
export function canUseSemanticQuestion(semantic,inspectRisk) {
 const q=semantic?.question||'';
 return semantic?.used===true&&semantic.needs_clarification===true&&semantic.confidence>=0&&q.length>=6&&q.length<=120
  &&(q.match(/[？?]/g)||[]).length===1
  && !/[0-9]|建议|推荐|适合|诊断|治疗|注射|手术|价格|费用|手机号|电话|微信|保证|预约|照片|病史|过敏/.test(q)
  &&inspectRisk(q).decision==='allow';
}
