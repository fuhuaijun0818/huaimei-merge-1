import { INTENT_ONTOLOGY } from './acquisition-intent.mjs';

export const TURN_PLAN_VERSION = '1.0.0';
export const TURN_INTENTS = Object.keys(INTENT_ONTOLOGY).filter(key => !['risk','restricted'].includes(INTENT_ONTOLOGY[key].domain));
TURN_INTENTS.push('contact_submission');
const steps = new Set(['answer', 'clarify', 'offer_appointment', 'defer', 'acknowledge_contact']);
const fields = new Set(['budget', 'time_preference', 'style_preference', 'concern']);

// Plans are proposals. Only literal, current-message evidence may update slots;
// no model output can manufacture a contact value or a fulfilled booking.
export function validateTurnPlan(data, { current = '' } = {}) {
  const bad = reason => ({ used:false, reason });
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  if (!data || typeof data !== 'object' || !Number.isFinite(data.confidence) || data.confidence < .8 || data.confidence > 1) return bad('low_confidence_or_schema');
  if (!TURN_INTENTS.includes(data.intent) || !steps.has(data.next_step) || !text(data.clarification, 120)) return bad('invalid_plan_schema');
  if (!Array.isArray(data.questions) || data.questions.length > 3 || data.questions.some(q => !q || !TURN_INTENTS.includes(q.intent) || !text(q.query, 160) || !q.query.trim())) return bad('invalid_questions');
  if (data.next_step === 'clarify' && !data.clarification.trim()) return bad('missing_clarification');
  if (!Array.isArray(data.slot_updates) || data.slot_updates.length > 4) return bad('invalid_slots');
  const groundedSlots=data.slot_updates.filter(s=>s && fields.has(s.field) && text(s.value,80) && s.value && current.includes(s.value));
  const discardedSlots=data.slot_updates.length-groundedSlots.length;
  const validTask=data.task && ['unchanged','interested','deferred'].includes(data.task.willingness) && text(data.task.evidence,100)
    && (data.task.willingness==='unchanged' || data.task.evidence && current.includes(data.task.evidence));
  // A bad optional extraction must not erase an otherwise usable understanding.
  // Discard it; never write model-invented values or advance an ungrounded task.
  data={...data,task:validTask?data.task:{willingness:'unchanged',evidence:''}};
  if(data.task.willingness==='interested' && /(?:不|别|暂缓|取消|缓缓).{0,5}(?:约|登记|面诊)|没空|别催/.test(data.task.evidence))return bad('negated_appointment_interest');
  if(data.next_step==='defer' && data.task.willingness!=='deferred')return bad('deferral_without_evidence');
  const discardedStep=data.next_step==='offer_appointment' && data.task.willingness!=='interested';
  if(discardedStep)data={...data,next_step:data.intent==='contact_submission'?'acknowledge_contact':'answer'};
  if (data.task.willingness === 'deferred' && data.next_step === 'offer_appointment') return bad('contradictory_task');
  return { used:true, version:TURN_PLAN_VERSION, confidence:data.confidence, intent:data.intent,
    questions:data.questions.map(q=>({intent:q.intent,query:q.query.trim()})),
    clarification:data.clarification.trim(), next_step:data.next_step,
    discarded_task:!validTask, discarded_next_step:discardedStep, discarded_slot_updates:discardedSlots, slot_updates:groundedSlots.map(s=>({field:s.field,value:s.value})),
    task:{willingness:data.task.willingness,evidence:data.task.evidence} };
}

export function applyTurnPlanContext(context, plan) {
  if (!plan?.used) return context;
  const slots = {...context.known_slots};
  for (const update of plan.slot_updates) slots[update.field] = update.value;
  const state = {...context.presales_state};
  if (plan.task.willingness !== 'unchanged') state.willingness = plan.task.willingness;
  if (plan.next_step === 'defer') state.willingness = 'deferred';
  if (slots.time_preference) state.visit_preference = slots.time_preference;
  return {...context, known_slots:slots, presales_state:state,
    profile:{...context.profile,...slots}, turn_plan:plan};
}
