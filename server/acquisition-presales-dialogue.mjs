// Conversation preferences are not booking, payment or dispatch receipts.
// The case supplies dialogue patterns only; no historical offer is imported.
export const PRESALES_DIALOGUE_VERSION = '1.0.0';
const unique = values => [...new Set(values)];
const defer = /(?:先不|暂时不|不着急|不想|不要)(?:预约|约)|下个月再说|先考虑|考虑一下|别催|不要催/;
const ready = /帮我约|想预约|想面诊|约一下|约面诊|安排面诊|去面诊|过去面诊/;
// A-020 AC1：拒绝电话联系、联系时间偏好与暂缓预约是三类不同语义。
// 拒绝联系必须能独立识别并在后续轮次持续生效（A-013 AC4、A-020 AC3/AC4）。
const contactRefusal = /(?:不要|不用|不需要|无需|别)(?:再)?(?:给我)?(?:联系|打电话|来电|电话回访|回访)|不要再打(?:电话|给我电话)?|不方便接电话/;
// 只有客户明确给出新意愿时才恢复联系邀请，且不能被“不要给我打电话”误判为同意。
const contactConsent = /(?:可以|同意|方便|愿意|请)(?:再)?(?:给我)?(?:打电话|来电|联系我)|打电话给我|电话联系我|可以联系我/;
const timePattern = /(?:下个月|这个月|本月|周末|(?:下周|本周)[一二三四五六日天]?|周[一二三四五六日天]|今天|明天|后天|(?:\d{1,2}|[一二三四五六七八九十]{1,3})月(?:\d{1,2}|[一二三四五六七八九十]{1,3})[日号]|(?:\d{1,2}|[一二三四五六七八九十]{1,3})[号日]|上午|下午|晚上|\d{1,2}点(?:半)?)/g;
export function extractVisitPreference(message = '') {
  // A correction replaces, rather than merges with, the abandoned date.
  const latest = String(message).split(/改成|改到|改为|还是|换成|换到/).at(-1);
  const positive = latest.split(/[，。；,;\n]/).filter(s => !/(?:不去|不行|没空|不能|不要|别约|不是|不方便|去不了)/.test(s));
  return unique(positive.join(' ').match(timePattern) || []).join('、') || null;
}

export function advancePresalesState(previous = {}, message = '') {
  const text = String(message);
  let preference = extractVisitPreference(text);
  const previousPreference = typeof previous.visit_preference === 'string' ? extractVisitPreference(previous.visit_preference) : null;
  if (preference && /^(?:上午|下午|晚上|\d{1,2}点半?)(?:、(?:上午|下午|晚上|\d{1,2}点半?))*$/.test(preference) && previousPreference) {
    preference = [previousPreference.replace(/(?:、)?(?:上午|下午|晚上|\d{1,2}点半?)/g,''),preference].filter(Boolean).join('、');
  }
  const arrival = /(?:我|我们)?(?:已经|现在)?(?:到医院了|到院了|到门口了|到大门了)/.test(text) || Boolean(previousPreference && /^(?:我)?到了[。！!]?\s*$/.test(text));
  let willingness = ['deferred','interested'].includes(previous.willingness) ? previous.willingness : 'undecided';
  if (defer.test(text)) willingness = 'deferred';
  else if (ready.test(text) || (preference && /去吧|过来|过去|面诊|还是|改到|改成/.test(text))) willingness = 'interested';
  // 拒绝联系是独立状态：拒绝后持续抑制电话回访与预约邀请，
  // 直到客户给出明确的新意愿（同意联系或明确要预约）。
  const refusedNow = contactRefusal.test(text);
  const consentedNow = !refusedNow && (contactConsent.test(text) || ready.test(text));
  const contactRefused = consentedNow ? false
    : refusedNow ? true
      : previous.contact_refused === true;
  return {
    version:PRESALES_DIALOGUE_VERSION,
    willingness,
    contact_refused:contactRefused,
    visit_preference:preference || (/(?:去不了|不去|没空|不能来|不方便)/.test(text) ? null : previousPreference),
    arrival_reported:arrival || previous.arrival_reported === true,
    pending_verifications:unique([
      ...(Array.isArray(previous.pending_verifications) ? previous.pending_verifications : []),
      ...presalesTopicIds(text)
    ]).filter(id => ['same_day','price','refund','payment','pickup','availability','location'].includes(id)),
    // Never set a confirmed state from a customer's words or an attachment.
    fulfillment:'unverified'
  };
}

const TOPICS = [
  {id:'same_day', test:/(?:当天|当日|一天).{0,12}(?:做|手术|面诊)|面诊.{0,12}(?:就做|接着做)/, coverage:/当天|当日/, answer:'当天面诊后能否安排手术，需要医生评估并核对院方安排，现在还不能确认。'},
  {id:'price', test:/多少钱|费用|价格|收费|太贵|有点贵/, coverage:/费用|价格|收费|报价|贵/, answer:'具体费用还需要核实当前报价和包含的项目，我这里暂时没有可确认的金额。'},
  {id:'refund', test:/(?:定金|订金|押金|钱|费用).{0,12}(?:退|抵)|(?:退|抵).{0,8}(?:定金|订金|钱)|不做.{0,8}退/, coverage:/退|抵扣/, answer:'定金能否退还或抵扣，需要核对您对应订单的条款，目前还不能确认退款条件。'},
  {id:'payment', test:/付好了|付过了|付款了|支付成功|付款截图|支付截图|已经付款/, coverage:/付款|支付|到账|订单/, answer:'您提到已经付款；是否到账、对应什么订单，还需要通过院方订单核验，聊天中的说明或截图不能代替确认。'},
  {id:'pickup', test:/接机|接站|接送|专车|派车|来接我/, coverage:/接机|接站|接送|派车/, answer:'接送是否提供、覆盖哪里，需要核实当前服务安排；现在还没有确认车辆。'},
  {id:'availability', test:/排到什么时候|最早.{0,8}(?:约|排|做|时间)|什么时间能约|什么时候能约|有(?:没有)?(?:号|位置|名额)|还能约|排得上/, coverage:/排班|时段|名额|可约/, answer:'目前没有已核实的实时可约时段，需要顾问核对排班后确认。'},
  // A-010 AC1/AC2、A-017 AC3：营业时间属于已知问题，必须给出明确的“待核实”口径，
  // 不能静默丢掉，也不能把营业时间说成医生排班或可约号源。
  {id:'hours', test:/(?:营业|上班|开门|接诊).{0,6}(?:时间|几点)|几点(?:上班|下班|开门|关门|接诊)|(?:周末|周六|周日|节假日).{0,6}(?:营业|上班|开门|接诊|有人)/, coverage:/营业时间|上班时间|门诊时间|开门时间/, answer:'营业时间和医生排班的实时信息需要核实；营业时间不等于有号，具体接诊时段要由顾问确认。'},
  {id:'location', test:/位置在哪里|地址在哪|怎么走|医院在哪|哪个门|哪个机场|虹桥还是浦东/, coverage:/院区|地址|入口|机场/, answer:'到院路线需要先确认接诊院区，避免走错地方；目前还没有已核实的院区地址。'},
  {id:'arrival', test:/(?:我|我们)?(?:已经|现在)?(?:到医院了|到院了|到门口了|到大门了)/, coverage:/前台|入口|接待/, answer:'您已经到院了，可以先向前台说明来意；我这里还没有接待人员到场的确认。'},
  {id:'service_complaint', test:/没人回|没有回复|不回复|终于加上|等了.{0,5}(?:半天|好久)|一直没回/, coverage:/等|回复|抱歉/, answer:'让您久等了，抱歉，我们先把您现在的问题说清楚。'}
];

export const presalesTopicIds = message => TOPICS.filter(t => t.test.test(message)).map(t => t.id);

export function buildPresalesPlan(message, context = {}) {
  const state = advancePresalesState(context.presales_state, message);
  const topics = presalesTopicIds(message);
  if (state.arrival_reported && /^(?:我)?到了[。！!]?\s*$/.test(message) && !topics.includes('arrival')) topics.push('arrival');
  return {
    ...state,
    topics,
    stage:state.arrival_reported ? 'arrival_preparation' : topics.some(t => ['price','refund','payment','same_day'].includes(t)) ? 'decision_support' : state.willingness === 'interested' || topics.includes('availability') ? 'appointment_coordination' : 'consultation',
    max_questions:1,
    suppress_booking_invitation:state.willingness === 'deferred' || state.contact_refused === true,
    action_policy:'Only describe pending requests. No booking/payment/pickup confirmation without a server receipt.'
  };
}

// Run only after input safety checks. Preserve existing answers with their
// evidence; fill uncovered service questions with explicit uncertainty.
export function applyPresalesDialogue(result, message, context = {}) {
  if (result.status !== 'completed' || result.handover?.required) return result;
  const plan = buildPresalesPlan(message, context);
  const intent = result.structured_data?.intent || '';
  const topical = TOPICS.filter(t => plan.topics.includes(t.id));
  const special = topical.some(t => !['price','location'].includes(t.id));
  const dateChange = Boolean(extractVisitPreference(message)) && (plan.willingness === 'interested' || /去吧|太赶|改期/.test(message));
  const deferredNow = defer.test(message);
  const contactRefusedNow = contactRefusal.test(message);
  const costConcern = /(?:担心|顾虑).{0,8}(?:费用|价格)|(?:费用|价格).{0,5}(?:高|贵)|太贵|有点贵/.test(message);
  const stripsQuestions = text => String(text).replace(/还有其他想了解的吗？\s*或者帮您预约专家做进一步分析？/g,'').replace(/[^。！？!?\n]*[？?]/g,'').trim();
  const replaceGeneric = /need_clarification|conversation_followup|conversation_acknowledgement|appointment_query|appointment_request/.test(intent);
  let text = result.message;
  let serviceOnly = false;
  if (special || dateChange || deferredNow || contactRefusedNow || (plan.topics.length > 1)) {
    const relevantBase = topical.some(t => t.coverage.test(text)) && !replaceGeneric;
    const keepKnowledge = /project_explanation|project_comparison|knowledge_grounded_explanation/.test(intent) && /原理|区别|介绍|是什么/.test(message);
    text = relevantBase || keepKnowledge ? stripsQuestions(text) : '';
    serviceOnly = !text;
    const additions = topical.filter(t => !t.coverage.test(text)).map(t => t.answer);
    text = [text, ...additions].filter(Boolean).join('\n');
    if (costConcern && topical.every(t => t.id === 'price')) {
      text = '费用是您在意的重点，具体总价和包含项还需要核实，了解清楚再决定。';
      serviceOnly = true;
    }
    if (contactRefusedNow) text = '好的，我不会安排电话回访，也不会再向您索要联系方式；有问题可以继续在这里在线咨询。';
    else if (deferredNow) text = [text, /担心|顾虑|犹豫/.test(message) && !topical.length ? '不用急着预约，您目前最担心哪一方面？' : '不用赶着决定，按您方便的节奏来。'].filter(Boolean).join('\n');
    else if (dateChange) text = [text, `${/太赶|有点赶/.test(message) ? '时间赶就不用勉强，' : ''}先以${plan.visit_preference.replaceAll('、','')}作为您的期望到院时间，实际安排还需要顾问确认。`].filter(Boolean).join('\n');
    if (!text) text = result.message;
  }
  if (plan.suppress_booking_invitation) text = text.replace(/还有其他想了解的吗？\s*或者帮您预约专家做进一步分析？/g,'').trim();
  const overridden = text !== result.message;
  return {
    ...result, message:text,
    ...(serviceOnly ? {citations:[]} : {}),
    structured_data:{...result.structured_data,
      ...(serviceOnly ? {intent:'presales_coordination', understanding_status:'presales_context_resolved', knowledge_hits:[]} : {}),
      sales_dialogue:plan,
      ...(overridden ? {next_questions:(text.match(/[^。！？!?\n]*[？?]/g) || [])} : {})
    },
    // These are UI proposals, never receipts or auto-dispatched commands.
    ...(serviceOnly ? {recommended_actions:plan.suppress_booking_invitation ? [{type:'wait_for_customer'}] : topical.length ? [{type:'request_human_source_verification'}] : [{type:'collect_appointment_preference',fields:['preferred_date','time_preference']}]} : {})
  };
}

export function presalesCoveragePassed(message, topics = []) {
  return TOPICS.filter(t => topics.includes(t.id)).every(t => t.coverage.test(message));
}

export function presalesPromisesSafe(message) {
  return !String(message).split(/[，。；;！!\n]/).some(clause =>
    !/(?:不能|没有|未|尚未|不代表|不等于|无法)/.test(clause)
    && (/(?:已(?:经)?|帮您|为您).{0,8}(?:登记|约好|预约成功|锁定|安排好|派车|到账|收到款|退款成功|接您)|(?:预约|付款|支付|车辆|接送).{0,4}(?:已确认|成功|安排好了)|马上.{0,4}(?:去接|来接|派车)|我(?:会|再|随后|到时).{0,12}(?:同步|通知|回复|联系|跟进)|我.{0,6}(?:留意着|帮您留意)/.test(clause)
      || /(?:稍后|届时|随后|到时).{0,18}(?:联系|同步|通知|发送)/.test(clause)
      || /已完成(?:付款|支付)/.test(clause) && !/您(?:说|提到|表示)/.test(clause)));
}

export const PRESALES_DIALOGUE_PROMPT = `
售前交流方式：
- sales_plan只是客户表达的意愿与问题清单，不是付款、预约或接送成功凭据。没有预约登记接口回执时，可以说“先以周六作为期望时间”，不能说“已为您登记”。
- pending_verifications用于保存待核实事项供后续交接，不要求每轮复述；本轮只问付款时，不要顺带重复之前的退款和接送说明。
- 客户一次提出多个问题，逐个简短回应，不能只回答分类器的主意图。无法核实的项目直接说明未确认，不能用泛泛追问替代回答。
- 客户连续发短句，结合历史承接，优先处理更正和最近选择；“好的”不等于授权付款或确认预约。
- 犹豫、改期、拒绝留下电话都要尊重，不反复邀约。已有项目和期望时间不要重问；不要索取电话中已经保存的信息。
- 有到院意愿后才协助确认下一步；到院阶段聚焦入口和接待，不重新推荐项目。客人抱怨等待时简短致歉后直接解决问题，不编造此前无人回复的原因。
- 语气温和但不假扮真人，不声称自己去接客户，不复制销售截图中的历史价格、活动、案例效果或诊断。
- 没有主动回访与通知执行能力，不能承诺“我帮您留意”“核实后我再同步”“到时通知您”。付款只能承接“您提到已付款”，不可把客户自述变成已验证的付款记录。
沟通示例（只学承接方式，不作为院方事实）：
客户：“先不约，我再想想。” → “没关系，按您的节奏来。有哪一点没了解清楚，我们可以继续聊。”
客户：“不是周末，我改成下周。” → 承接“下周”这个新偏好，说明是否已确认；不要继续问周末上午还是下午。
客户：“费用多少，最早什么时候能约？” → 分别回答费用核验情况和时段核验情况，不把“您想改善哪里”作为答复。
客户：“到了。”（此前已讨论到院）→ 承接到院和接待，不能宣称已派人或已派车。
`;
