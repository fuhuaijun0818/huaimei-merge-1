import { randomUUID } from 'node:crypto';

// Extract values locally; the model only sees a presence marker, never a phone.
export function chatContactName(text = '') {
  return String(text).match(/(?:我叫|姓名\s*[:：]?|名字是|联系人\s*[:：]?)\s*([\p{Script=Han}·]{2,8})(?=[\s，,。；;：:]|$)/u)?.[1] || '';
}
export function chatContactIntent(text = '') {
  const value = String(text).normalize('NFKC').trim();
  if (/不要|别联系|不是我|举例|例如|示例|测试号码|朋友的|家人的|他人的|她的号码|他的号码|身份证/.test(value)) return null;
  const matches = [...value.matchAll(/(?<!\d)(?:\+?86[ -]?)?(1[\d -]{8,15})(?!\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0], mobile = match[1].replace(/[ -]/g, '');
  if (mobile.length > 11) return null;
  let name = chatContactName(value);
  const before = value.slice(0,match.index).trim().replace(/[，,：:]$/, '').trim();
  const after = value.slice(match.index+match[0].length).trim().replace(/^[，,：:]/, '').trim();
  if (!name) name = [before,after].find(s=>/^[\p{Script=Han}·]{2,8}$/u.test(s) && !/电话|手机|联系|号码|多少钱|预约|谢谢|你好|名字|姓名/.test(s)) || '';
  let remainder = value.replace(match[0], '').replace(name || /$^/, '');
  remainder = remainder.replace(/(?:我的)?(?:手机号|手机|电话|联系方式|号码)(?:是|为)?\s*[:：]?|我叫|姓名\s*[:：]?|名字是|联系人\s*[:：]?/g, '').replace(/^[\s，,。；;！!]+|[\s，,。；;！!]+$/g, '').trim();
  return { mobile, name, remaining_message:remainder, valid:/^1[3-9]\d{9}$/.test(mobile) };
}

// A-019 AC4：从留资消息里识别联系时间偏好（只做承接，不宣称"已安排"）。
export function chatContactPreference(text = '') {
  const value = String(text).normalize('NFKC');
  if (!value || /不要|别联系|不用联系|无需联系/.test(value)) return null;
  const day = /周末|周六|周日|双休/.test(value) ? '周末'
    : /工作日|上班时间|工作时间/.test(value) ? '工作日' : '';
  const slot = /晚上|晚间|夜里|下班后/.test(value) ? '晚间'
    : /下午/.test(value) ? '下午'
    : /上午|早上|一早/.test(value) ? '上午'
    : /白天/.test(value) ? '白天' : '';
  if (!day && !slot) return null;
  const evidence = value.match(/(?:周末|周六|周日|双休|工作日|上班时间|工作时间|晚上|晚间|夜里|下班后|上午|早上|下午|白天)[^。；;，,]{0,8}/)?.[0]?.trim() || `${day}${slot}`;
  return { label: `${day}${slot}` || day, evidence };
}

export async function captureChatContact(envelope, saveLead) {
  if (envelope.channel !== 'web') return null;
  const intent = chatContactIntent(envelope.message.text);
  if (!intent) return null;
  let receipt = { status:'invalid', message:'手机号格式不正确，请发送11位中国大陆手机号。' };
  if (intent.valid) {
    try {
      const saved = await saveLead({ tenant_id:envelope.tenant_id, session_id:envelope.conversation_id,
        mobile:intent.mobile, name:intent.name, service_consent:true, interests:envelope.interests || [],
        messages:[{role:'user', content:envelope.message.text, at:envelope.message.timestamp}] });
      const preference = chatContactPreference(envelope.message.text);
      receipt = { status:'accepted', masked_mobile:saved.lead.customer.mobile,
        identity:{phone_verification_status:'pending_manual'},
        message:`收到，${intent.name ? '姓名和' : ''}手机号已保存。后续顾问联系时会人工核对，您也可以继续在这里咨询。`
          + (preference ? `已记录您希望${preference.label}联系的偏好，回电安排仍需顾问人工确认。` : ''),
        ...(preference ? { contact_preference:{ label:preference.label, evidence:preference.evidence } } : {}) };
    } catch (error) {
      // A stored 禁止联系 preference is an explicit refusal, not a storage
      // failure: never claim the number was captured or that a call is coming.
      // A 的联系偏好回执（上一段）与 B 的拒绝语义（本段）都保留：被拒绝联系时按
      // “已按偏好处理”回执，而不是谎称保存失败；真正的保存失败仍保留重试文案。
      receipt = error?.code === 'PRIVACY_CONTACT_SUPPRESSED'
        ? { status:'failed', message:'已按您之前设置的联系偏好处理，不会安排电话回访；我们可以继续在这里在线咨询。' }
        : { status:'failed', message:'手机号暂未保存成功，请稍后重新发送。您可以继续在线咨询。' };
    }
  }
  return { receipt, remaining_message:intent.remaining_message, result:{ status:'completed', run_id:`contact-${randomUUID()}`,
    agent:{id:'A-01',name:'AI获客顾问·小美'}, guardrails:{llm_used:false}, usage:{provider:'contact_capture'},
    output:{message:receipt.message, structured_data:{intent:'contact_submission',next_questions:[]},
      recommended_actions:[], handover:{required:false}, citations:[]} } };
}
