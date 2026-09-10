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
      receipt = { status:'accepted', masked_mobile:saved.lead.customer.mobile,
        identity:{phone_verification_status:'pending_manual'},
        message:`收到，${intent.name ? '姓名和' : ''}手机号已保存。后续顾问联系时会人工核对，您也可以继续在这里咨询。` };
    } catch {
      receipt = { status:'failed', message:'手机号暂未保存成功，请稍后重新发送。您可以继续在线咨询。' };
    }
  }
  return { receipt, remaining_message:intent.remaining_message, result:{ status:'completed', run_id:`contact-${randomUUID()}`,
    agent:{id:'A-01',name:'AI获客顾问·小美'}, guardrails:{llm_used:false}, usage:{provider:'contact_capture'},
    output:{message:receipt.message, structured_data:{intent:'contact_submission',next_questions:[]},
      recommended_actions:[], handover:{required:false}, citations:[]} } };
}
