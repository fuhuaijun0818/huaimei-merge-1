import { useEffect, useMemo, useRef, useState } from "react";

const QUICK_QUESTIONS = [
  "脸部松弛，想了解抗初老项目",
  "热玛吉和线雕有什么区别？",
  "皮肤暗沉发黄，想提亮"
];

const emptyConversation = () => [];
// 与服务端同一套规范化：+86 / 0086 / 空格 / 短横线都归一为 11 位，并且按整串
// 处理，避免把 "0086…" 这类输入截成错误号码。只在离开输入框和提交时调用，
// 输入过程中不做整体重写，否则粘贴/快速输入会被 React 的受控更新吃掉字符。
const normalizeMobileInput = (value) => {
  const digits = String(value || "").normalize("NFKC").replace(/\D/g, "");
  const local = /^1[3-9]\d{9}$/.test(digits) ? digits : digits.replace(/^(?:00)?86/, "");
  return local.slice(0, 11);
};

// 输入过程中只做轻量清洗：保留数字和开头的一个 +，其余分隔符由失焦时统一归一。
// 输入框不能用 maxLength=11：粘贴 "0086 138-0000-0001" 会被浏览器先截成
// "0086 138-00"，再归一就只剩 "13800"。
const cleanMobileTyping = (value) => {
  const text = String(value || "").normalize("NFKC");
  const digits = text.replace(/\D/g, "");
  return `${text.trim().startsWith("+") ? "+" : ""}${digits}`.slice(0, 20);
};
const restoreConversationMessages = (items) => collapseImmediateCustomerDuplicates(Array.isArray(items) ? [...items]
  .sort((left, right) => (Number(left?.seq) || 0) - (Number(right?.seq) || 0))
  .map((item) => {
    const id = String(item?.id || `restored-${item?.seq || Math.random()}`);
    const role = item?.from === "customer" ? "user" : item?.from === "staff" ? "staff" : "assistant";
    const content = String(item?.text || "");
    return {
      id,
      role,
      content,
      at:item?.at || undefined,
      status:item?.status === "failed" ? "failed" : undefined,
      isFinalSegment:item?.from !== "customer",
      // The API persists one canonical AI reply while the public UI presents
      // the same turn as short bubbles. Retain the canonical identity so a
      // poll that wins the race against the POST can be replaced in-place.
      ...(role === "assistant" ? { serverReplyId:id, serverReplyText:content } : {})
    };
  })
  .filter((item) => item.content) : []);
const duplicateCustomerWindowMs = 15_000;
const customerMessageFingerprint = (message) => `${message?.role || ""}\u0000${String(message?.content || "").trim().replace(/\s+/g, " ")}`;
const occurredAt = (message) => {
  const value = Date.parse(message?.at || "");
  return Number.isFinite(value) ? value : 0;
};
// A gateway retry can return the same customer turn with a different server
// ID. Keep the first copy rendered when its content and timestamp prove it is
// the same immediate submission; later, intentional repeated questions remain
// separate turns.
const collapseImmediateCustomerDuplicates = (items) => {
  const seen = new Map();
  return items.filter((message) => {
    if (message?.role !== "user") return true;
    const key = customerMessageFingerprint(message);
    const previous = seen.get(key);
    const currentAt = occurredAt(message);
    if (previous && currentAt && Math.abs(currentAt - previous) <= duplicateCustomerWindowMs) return false;
    seen.set(key, currentAt || Date.now());
    return true;
  });
};
const mergeConversationMessages = (current, incoming) => {
  // Only locally-created presentation segments replace the server's canonical
  // reply. A restored history row also carries serverReplyId for later
  // reconciliation, but it is not itself a segment and must never filter out
  // itself on the next history poll.
  const byId = new Map(current.filter((message) => message?.id).map((message) => [message.id, message]));
  const displayedServerReplyIds = new Set();
  const displayedOptimisticCustomers = new Map();
  for (const message of current) {
    if (message?.groupId && message?.serverReplyId) displayedServerReplyIds.add(message.serverReplyId);
    if (message?.optimistic && message?.role === "user") {
      displayedOptimisticCustomers.set(customerMessageFingerprint(message), occurredAt(message));
    }
  }
  for (const message of incoming) {
    // A just-sent answer is displayed as short segments, while history stores
    // the same answer as one canonical reply row. Keep the short segments and
    // do not append that canonical row a second time on the next poll.
    const isDisplayedReply = displayedServerReplyIds.has(message?.id);
    const optimisticAt = displayedOptimisticCustomers.get(customerMessageFingerprint(message));
    const isOptimisticCustomerReplay = message?.role === "user" && !message?.optimistic
      && optimisticAt && occurredAt(message)
      && Math.abs(occurredAt(message) - optimisticAt) <= duplicateCustomerWindowMs;
    if (message?.id && !byId.has(message.id) && !isDisplayedReply && !isOptimisticCustomerReplay) byId.set(message.id, message);
  }
  return collapseImmediateCustomerDuplicates([...byId.values()])
    .sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
};

// A history poll can observe the server's canonical reply just before the
// corresponding POST resolves in this tab. Replace that canonical row with
// the presentation segments, rather than rendering both versions of one turn.
const mergeReplySegments = (current, segments) => {
  if (!segments.length) return current;
  const serverReplyId = segments[0]?.serverReplyId;
  const existingSegment = current.some((message) => message?.serverReplyId === serverReplyId && message?.groupId);
  if (existingSegment) return current;
  const canonicalIndex = current.findIndex((message) => message?.role === "assistant" && message.id === serverReplyId);
  if (canonicalIndex < 0) return [...current, ...segments];
  return [
    ...current.slice(0, canonicalIndex),
    ...segments,
    ...current.slice(canonicalIndex + 1)
  ];
};
const createSessionId = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const trimTrailingSlashes = (value = "") => String(value).replace(/\/+$/, "");
const joinBaseUrl = (baseUrl, path) => {
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);
  if (!normalizedBaseUrl) return path;
  return `${normalizedBaseUrl}/${String(path).replace(/^\/+/, "")}`;
};

const API_BASE_URL = trimTrailingSlashes(import.meta.env.VITE_API_BASE_URL || "");
const HERO_IMAGE_URL = `${import.meta.env.BASE_URL}assets/hero-bg.png`;

function SendIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  );
}

function DownIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
    </svg>
  );
}

function FeedbackIcon({ type }) {
  const isUp = type === "up";
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" d={isUp
        ? "M7 10v10H4V10h3Zm0 10h9.1a2 2 0 0 0 1.95-1.55l1.26-5.5A2 2 0 0 0 17.36 10H14l.44-2.64A3 3 0 0 0 11.48 4L7 10Z"
        : "M7 14V4H4v10h3Zm0-10h9.1a2 2 0 0 1 1.95 1.55l1.26 5.5A2 2 0 0 1 17.36 14H14l.44 2.64A3 3 0 0 1 11.48 20L7 14Z"} />
    </svg>
  );
}

function Composer({ value, onChange, onSubmit, disabled, restoringSession, inputRef }) {
  const canSend = value.trim() && !disabled;
  return (
    <div className="composer-area">
      <form className="composer" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          aria-label="咨询内容"
          autoComplete="off"
          disabled={restoringSession}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}
          maxLength={1000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="描述您的关注点，例如：脸部松弛、肤色暗沉…"
          value={value}
        />
        <button className="send-button" type="submit" disabled={!canSend} aria-label="发送咨询">
          <SendIcon />
        </button>
      </form>
      <p className="compliance-note">时代之美 · AI获客顾问·小美 · 项目信息仅供参考，具体适用性请咨询专业医师</p>
    </div>
  );
}

const publicMediaUrl = (value = "") => {
  const rawUrl = String(value || "");
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : joinBaseUrl(API_BASE_URL, rawUrl);
};

function KnowledgeSources({ citations = [], onPreview }) {
  if (!citations.length) return null;
  return (
    <div className="knowledge-sources" aria-label="参考资料">
      <span>参考资料</span>
      {citations.slice(0, 3).map((citation) => {
        const preview = citation?.preview?.url ? { ...citation.preview, url:publicMediaUrl(citation.preview.url) } : null;
        const label = String(citation.title || "项目资料").replace(/[｜|]\s*项目知识$/, "");
        const className = `source-chip ${citation.requires_verification ? "needs-verification" : ""}`;
        const title = citation.requires_verification ? "价格、活动、医生或医疗信息需人工核验原始资料" : "经审核的一般项目资料";
        const content = <>{label}{citation.requires_verification && <em>需核验</em>}{preview && <b>{preview.type === "pdf" ? "预览 PDF" : "查看图片"}</b>}</>;
        return preview ? (
          <button className={`${className} source-chip-button`} type="button" key={`${citation.knowledge_id}-${citation.source_record_id || "source"}`} title={`${title}，点击${preview.type === "pdf" ? "预览 PDF" : "查看图片"}`} onClick={() => onPreview(preview)}>{content}</button>
        ) : (
          <span className={className} key={`${citation.knowledge_id}-${citation.source_record_id || "source"}`} title={title}>{content}</span>
        );
      })}
    </div>
  );
}

function PublicKnowledgeMedia({ media = [], onPreview }) {
  if (!media.length) return null;
  return (
    <div className="public-knowledge-media" aria-label="公开宣传资料">
      {media.slice(0, 2).map((item) => {
        const src = publicMediaUrl(item?.url);
        if (!src) return null;
        const isPdf = item.type === "pdf";
        return (
          <button className="public-media-card" type="button" key={item.id || src} onClick={() => onPreview({ ...item, url:src })} title={`点击预览${isPdf ? " PDF" : "图片"}`}>
            {isPdf ? <span className="public-media-pdf" aria-hidden="true"><strong>PDF</strong><span>点击预览公开资料</span></span> : <img src={src} alt={item.alt || item.title || "公开宣传资料"} loading="lazy" />}
            <span className="public-media-caption">{item.title || "公开宣传资料"}{item.requires_verification ? <em>资料需核验</em> : null}</span>
          </button>
        );
      })}
    </div>
  );
}

function KnowledgeMediaPreview({ preview, onClose }) {
  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, onClose]);
  if (!preview?.url) return null;
  const isPdf = preview.type === "pdf";
  const title = preview.title || (isPdf ? "公开 PDF 资料" : "公开图片资料");
  return (
    <div className="knowledge-preview-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="knowledge-preview-dialog" role="dialog" aria-modal="true" aria-label={`${title}预览`}>
        <header className="knowledge-preview-header"><div><span>参考资料预览</span><strong>{title}</strong></div><button type="button" className="knowledge-preview-close" onClick={onClose} aria-label="关闭资料预览">×</button></header>
        <div className={`knowledge-preview-content ${isPdf ? "is-pdf" : "is-image"}`}>
          {isPdf ? <iframe src={preview.url} title={title} /> : <img src={preview.url} alt={preview.alt || title} />}
        </div>
        <footer className="knowledge-preview-footer">
          <span>{preview.requires_verification ? "该资料以院方当前审核版本为准" : "仅展示院方已审核的公开资料"}</span>
          <a href={preview.url} target="_blank" rel="noreferrer">在新窗口查看</a>
        </footer>
      </section>
    </div>
  );
}

function LeadCaptureCard({ prompt, status, error, result, onSubmit, handover }) {
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [serviceConsent, setServiceConsent] = useState(false);
  if (result) return (
    <section className="lead-capture-card lead-success" aria-live="polite">
      <div className="lead-success-mark">✓</div>
      <div>
        <strong>联系方式已保存</strong>
        <p>{result.message || "已提交人工咨询申请，顾问会基于本次咨询继续与您沟通。"}</p>
        <p className="lead-verification-note">手机号待顾问回电时人工核对。</p>
      </div>
    </section>
  );
  const submit = (event) => {
    event.preventDefault();
    // 提交前再归一一次，避免用户直接点提交（未触发失焦）时把 +86/0086 原样送出。
    const normalizedMobile = normalizeMobileInput(mobile);
    setMobile(normalizedMobile);
    onSubmit({ name:name.trim(), mobile:normalizedMobile, service_consent:serviceConsent });
  };
  const urgent = handover?.reason === "medical_emergency";
  const requiresHandover = handover?.required === true;
  const kicker = urgent ? "紧急处理" : requiresHandover ? "转由人工团队协助" : "继续由人工顾问协助";
  const title = urgent ? "请优先联系医院医务人员或急诊" : prompt.title;
  const description = urgent
    ? "如暂时无法接通，可留下手机号供人工团队回拨；提交回拨信息不能替代及时就医或拨打120。"
    : prompt.description;
  const submitLabel = urgent ? "提交回拨信息" : requiresHandover ? "提交人工协助申请" : "提交并建立咨询档案";
  const submittingLabel = urgent ? "正在提交回拨信息…" : "正在建立咨询档案…";
  return (
    <section className="lead-capture-card">
      <div className="lead-card-kicker">{kicker}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      <form className="lead-form" onSubmit={submit}>
        <label><span>怎么称呼您 <em>选填</em></span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" placeholder="您的称呼" /></label>
        <label><span>手机号</span><input value={mobile} onChange={(event) => setMobile(cleanMobileTyping(event.target.value))} onBlur={() => setMobile(normalizeMobileInput(mobile))} required maxLength={20} pattern="(?:00)?(?:\+?86)?1[3-9][0-9]{9}" inputMode="tel" autoComplete="tel" placeholder="11位手机号，可粘贴 +86 或 0086" aria-invalid={Boolean(error)} /></label>
        <label className="lead-consent"><input type="checkbox" checked={serviceConsent} onChange={(event) => setServiceConsent(event.target.checked)} required /><span>{prompt.consent_text || "请阅读并同意本次咨询联系授权"}</span></label>
        {error && <div className="lead-error" role="alert">{error}</div>}
        <button className="lead-submit" type="submit" disabled={status === "submitting" || !serviceConsent}>{status === "submitting" ? submittingLabel : submitLabel}</button>
      </form>
    </section>
  );
}

function AppointmentTimeFields({ value, onChange }) {
  const [recommendations, setRecommendations] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(joinBaseUrl(API_BASE_URL, "/api/public/appointment-dates"))
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!cancelled) setRecommendations(body); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const set = (patch) => onChange({ ...value, ...patch });
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return <>
    <label><span>期望到院日期（北京时间）</span><input type="date" required min={today} value={value.preferred_date} onChange={(e) => set({ preferred_date:e.target.value })} /></label>
    {recommendations?.available && <div className="appointment-recommendations">接下来两个工作日：{recommendations.dates.map((item) => <button type="button" key={item.date} onClick={() => set({ preferred_date:item.date })}>{item.label}</button>)}</div>}
    {!recommendations?.available && <p className="appointment-hint">请选择您方便到院的日期。</p>}
    <label><span>到院时间</span><select value={value.precision} onChange={(e) => set({ precision:e.target.value })}><option value="date">只确定日期</option><option value="period">上午 / 下午 / 晚上</option><option value="minute">具体钟点</option></select></label>
    {value.precision === "period" && <label><span>时段</span><select value={value.time_period} onChange={(e) => set({ time_period:e.target.value })}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}
    {value.precision === "minute" && <label><span>具体钟点（北京时间）</span><input type="time" required value={value.preferred_time} onChange={(e) => set({ preferred_time:e.target.value })} /></label>}
    {value.preferred_date === today && <p className="appointment-hint">今天到院需要选择尚未到达的具体钟点。</p>}
  </>;
}
const blankAppointmentTime = () => ({ preferred_date:"", precision:"date", time_period:"afternoon", preferred_time:"" });
const appointmentTimePayload = (value) => ({ preferred_date:value.preferred_date, preferred_time:value.precision === "minute" ? value.preferred_time : "", time_period:value.precision === "period" ? value.time_period : "" });

function AppointmentActionCard({ proposal, profileSignals, leadCaptured, state, onSubmit }) {
  const [time, setTime] = useState(blankAppointmentTime);
  const [confirmed, setConfirmed] = useState(false);
  if (!proposal || proposal.type !== "appointment_request" || state?.intake?.status === "registered") return null;
  const projects = profileSignals?.projects || [];
  const doctor = profileSignals?.doctors?.[0];
  const subjectReady = projects.length || doctor;
  return <section className="lead-capture-card appointment-action-card">
    <div className="lead-card-kicker">到院时间登记</div><h3>确认您希望到院的时间</h3>
    <p>院区：上海华美医疗美容医院<br />咨询内容：{projects.join("、") || "项目待补充"}{doctor ? ` · ${doctor}医生` : ""}</p>
    <p>{leadCaptured ? "使用本次咨询已保存的联系方式，顾问后续回电核对手机号与到院安排。" : "请先保存本次咨询的联系方式。"}</p>
    {!subjectReady && <p className="appointment-hint">请先在对话中确认想咨询的项目或医生。</p>}
    <form className="lead-form" onSubmit={(e) => { e.preventDefault(); if (confirmed) onSubmit(proposal, profileSignals, appointmentTimePayload(time)); }}>
      <AppointmentTimeFields value={time} onChange={(value) => { setTime(value); setConfirmed(false); }} />
      <label className="lead-consent"><input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>我确认以上院区、咨询内容和到院时间，并同意顾问使用已留联系方式跟进。本登记不代表指定医生或接诊名额已锁定。</span></label>
      {state?.error && state.actionId === proposal.id && <div className="lead-error" role="alert">{state.error}</div>}
      <button className="lead-submit" type="submit" disabled={!leadCaptured || !subjectReady || !confirmed || state?.status === "submitting"}>{state?.status === "submitting" ? "正在登记…" : "确认并登记到院时间"}</button>
    </form>
  </section>;
}

function AppointmentRegistrationCard({ state, onChange }) {
  const [action, setAction] = useState("");
  const [time, setTime] = useState(blankAppointmentTime);
  const [confirmed, setConfirmed] = useState(false);
  const intake = state?.intake;
  useEffect(() => { setAction(""); setConfirmed(false); }, [intake?.id, intake?.version]);
  if (!intake) return null;
  const editing = state.status === "submitting";
  return <section className="lead-capture-card appointment-registration-card" aria-label="我的到院登记">
    <div className="lead-card-kicker">我的到院登记 · {intake.status === "cancelled" ? "已取消" : "已登记"}</div>
    <h3>{intake.time_preference}</h3><p>{intake.branch} · {(intake.projects || []).join("、")}{intake.doctor ? ` · ${intake.doctor}医生` : ""}</p>
    <p className="appointment-number">登记号：{intake.appointment_no}</p>
    <p>{intake.status === "cancelled" ? "本次到院登记已取消，不再推进此登记的跟进。如有新的安排，您可以继续咨询。" : "联系方式已保存，待顾问回电核号。本登记不代表指定医生或接诊名额已锁定。"}</p>
    {state.message && <p role="status">{state.message}</p>}
    {intake.status === "registered" && <div className="appointment-recommendations"><button type="button" disabled={editing} onClick={() => { setAction("reschedule"); setTime({ ...blankAppointmentTime(), ...intake, precision:intake.time_precision, preferred_time:intake.preferred_time || "", time_period:intake.time_period || "afternoon" }); setConfirmed(false); }}>修改到院时间</button><button type="button" disabled={editing} onClick={() => { setAction("cancel"); setConfirmed(false); }}>取消登记</button></div>}
    {action && <form className="lead-form" onSubmit={(e) => { e.preventDefault(); if (confirmed) onChange(action, action === "reschedule" ? appointmentTimePayload(time) : {}); }}>
      {action === "reschedule" && <AppointmentTimeFields value={time} onChange={(value) => { setTime(value); setConfirmed(false); }} />}
      <label className="lead-consent"><input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>{action === "cancel" ? "确认取消本次到院登记" : "确认将期望到院时间更新为以上日期与时段"}</span></label>
      <button className="lead-submit" type="submit" disabled={!confirmed || editing}>{editing ? "正在保存…" : action === "cancel" ? "确认取消登记" : "确认改期"}</button>
      <button type="button" disabled={editing} onClick={() => setAction("")}>返回</button>
    </form>}
    {state.error && <div className="lead-error" role="alert">{state.error}</div>}
  </section>;
}

function ConversationFeedback({ feedback, onFeedback }) {
  const saving = feedback?.status === "saving";
  const saved = feedback?.status === "saved";
  if (saved) return <div className="assistant-feedback feedback-saved" role="status">{feedback.rating === "down" ? "已记录反馈，后续会用于优化对话。" : "感谢您的认可。"}</div>;
  return (
    <div className="assistant-feedback" aria-label="回答反馈">
      <span>这次回答有帮助吗？</span>
      <button type="button" className="feedback-button" disabled={saving} onClick={() => onFeedback("up")} aria-label="赞：回答有帮助"><FeedbackIcon type="up" />赞</button>
      <button type="button" className="feedback-button" disabled={saving} onClick={() => onFeedback("down")} aria-label="踩：回答不准确或不符合预期"><FeedbackIcon type="down" />踩</button>
      {feedback?.status === "error" && <em className="feedback-error">未能记录，请重试</em>}
    </div>
  );
}

function ChatMessage({ message, showLeadCapture, leadState, appointmentState, onLeadSubmit, onAppointmentSubmit, feedback, onFeedback, onPreview }) {
  if (message.role === "user") return <div className="user-message">{message.content}</div>;
  if (message.role === "staff") return (
    <article className="assistant-message human-agent-message">
      <div className="assistant-label"><span className="assistant-avatar">顾</span><span>人工顾问</span></div>
      <div className="assistant-copy">{message.content}</div>
    </article>
  );
  const medicalHandover = ["medical_emergency", "medical_safety", "medical_boundary"].includes(message.handover?.reason);
  return (
    <article className={`assistant-message ${message.isContinuation ? "continuation" : ""} ${message.status === "handover_required" ? "handover" : ""}`}>
      {!message.isContinuation && <div className="assistant-label"><span className="assistant-avatar">美</span><span>小美 · AI获客顾问</span></div>}
      <div className="assistant-copy">{message.content}</div>
      {message.isFinalSegment && message.status === "handover_required" && <div className="handover-note">{medicalHandover ? "该问题需要人工顾问或医生进一步协助，小美不会在线判断或提供医疗处置建议。" : "该问题已停止自动推进，需要由相关人工团队继续处理。"}</div>}
      <PublicKnowledgeMedia media={message.media} onPreview={onPreview} />
      <KnowledgeSources citations={message.citations} onPreview={onPreview} />
      {message.isFinalSegment && <ConversationFeedback feedback={feedback} onFeedback={onFeedback} />}
      {showLeadCapture && <LeadCaptureCard prompt={{ ...message.leadCapture, consent_text:leadState.consentText || message.leadCapture?.consent_text }} status={leadState.status} error={leadState.error} result={leadState.result} onSubmit={onLeadSubmit} handover={message.handover} />}
      {message.isFinalSegment && <AppointmentActionCard proposal={message.orchestration?.action_proposal} profileSignals={message.profileSignals} leadCaptured={Boolean(leadState.result)} state={appointmentState} onSubmit={onAppointmentSubmit} />}
    </article>
  );
}

export function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState(emptyConversation);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [leadState, setLeadState] = useState({ status:"idle", error:"", result:null, consentText:"" });
  const [appointmentState, setAppointmentState] = useState({ status:"idle", error:"", actionId:"", message:"" });
  const [feedbackByReply, setFeedbackByReply] = useState({});
  const [knowledgePreview, setKnowledgePreview] = useState(null);
  const inputRef = useRef(null);
  const questionInFlightRef = useRef(false);
  const messageScrollerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const sessionIdRef = useRef(createSessionId());
  const sessionTokenRef = useRef("");
  const sessionEpochRef = useRef(0);
  const publicSessionReadyRef = useRef(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const chatStarted = messages.length > 0 || isLoading || Boolean(appointmentState.intake);

  const statusText = useMemo(() => isLoading ? "正在为您整理相关项目信息…" : "", [isLoading]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    const scroller = messageScrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, isLoading]);

  const updateScrollAnchor = (event) => {
    const scroller = event.currentTarget;
    shouldStickToBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
  };

  const resetConversation = async () => {
    const epoch = ++sessionEpochRef.current;
    setRestoringSession(true);
    setInput("");
    setMessages(emptyConversation());
    setIsLoading(false);
    setError("");
    setLeadState({ status:"idle", error:"", result:null, consentText:"" });
    setAppointmentState({ status:"idle", error:"", actionId:"", message:"" });
    setFeedbackByReply({});
    setKnowledgePreview(null);
    shouldStickToBottomRef.current = true;
    sessionIdRef.current = createSessionId();
    sessionTokenRef.current = "";
    publicSessionReadyRef.current = false;
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/appointment-intakes/current"), { method:"POST", credentials:"include", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ session_id:sessionIdRef.current }) });
      const body = await response.json();
      if (epoch !== sessionEpochRef.current) return;
      if (!response.ok) throw new Error(body?.error?.message || "新对话暂时无法建立，请重试。");
      updateSessionCredential(body);
      publicSessionReadyRef.current = true;
    } catch (err) { if (epoch === sessionEpochRef.current) setError(err.message); }
    finally { if (epoch === sessionEpochRef.current) setRestoringSession(false); }
  };

  const updateSessionCredential = (body) => {
    if (body?.session_id) sessionIdRef.current = body.session_id;
    if (body?.session_token) sessionTokenRef.current = body.session_token;
  };

  const publicHeaders = () => ({
    "Content-Type":"application/json",
    ...(sessionTokenRef.current ? { "X-Huamei-Session-Token":sessionTokenRef.current } : {})
  });

  const submitLead = async (lead) => {
    setLeadState((current) => ({ ...current, status:"submitting", error:"", result:null }));
    const interests = [...new Set(messages.flatMap((message) => message.profileSignals?.projects || []))].slice(0, 8);
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-lead"), {
        method:"POST",
        credentials:"include",
        headers:publicHeaders(),
        body:JSON.stringify({
          ...lead,
          session_id:sessionIdRef.current,
          ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}),
          interests,
          messages:messages.map((message) => ({ id:message.id, role:message.role, content:message.content, at:message.at }))
        })
      });
      const body = await response.json();
      updateSessionCredential(body);
      if (!response.ok) throw new Error(body?.error?.message || "留资保存失败，请稍后重试");
      setLeadState({ status:"captured", error:"", result:body, consentText:"" });
    } catch (captureError) {
      setLeadState((current) => ({ ...current, status:"idle", error:captureError.message, result:null }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const epoch = sessionEpochRef.current;
    (async () => {
      let appointmentRestoreError = null;
      try {
        const currentResponse = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/appointment-intakes/current"), { method:"POST", credentials:"include", headers:{ "Content-Type":"application/json" }, body:"{}" });
        const current = await currentResponse.json();
        if (!currentResponse.ok) throw new Error(current?.error?.message || "无法恢复到院登记");
        if (!cancelled && epoch === sessionEpochRef.current) {
          updateSessionCredential(current);
          publicSessionReadyRef.current = true;
          if (current.intake) setAppointmentState({ status:"accepted", error:"", actionId:"", message:"", intake:current.intake });
        }
      } catch (err) {
        appointmentRestoreError = err;
      }
      try {
        const historyResponse = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-history"), { method:"GET", credentials:"include", headers:publicHeaders() });
        const history = await historyResponse.json();
        if (!historyResponse.ok) throw new Error(history?.error?.message || "无法恢复历史咨询，请刷新重试。");
        if (cancelled || epoch !== sessionEpochRef.current) return;
        updateSessionCredential(history);
        const restored = restoreConversationMessages(history.messages);
        if (restored.length) setMessages(restored);
      } catch (err) {
        if (!cancelled && epoch === sessionEpochRef.current) setError(err.message || appointmentRestoreError?.message || "无法恢复当前会话，请刷新重试。");
      } finally {
        if (!cancelled && epoch === sessionEpochRef.current) setRestoringSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The public client confirms delivery only after it has fetched the staff
  // message through its session-scoped history endpoint. This is not a read
  // receipt: the server keeps read_status as not_reported.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!publicSessionReadyRef.current) return;
      try {
        const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-history"), {
          method:"GET", credentials:"include", headers:publicHeaders()
        });
        const history = await response.json();
        if (!response.ok || cancelled) return;
        updateSessionCredential(history);
        const restored = restoreConversationMessages(history.messages);
        if (restored.length) setMessages((current) => mergeConversationMessages(current, restored));
        const pendingStaff = (history.messages || []).filter((message) =>
          message?.from === "staff" && message?.delivery?.delivery_status !== "delivered"
        );
        await Promise.all(pendingStaff.map(async (message) => {
          const deliveryResponse = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-deliveries"), {
            method:"POST",
            credentials:"include",
            headers:publicHeaders(),
            body:JSON.stringify({ message_id:message.id, session_id:sessionIdRef.current })
          });
          const delivery = await deliveryResponse.json();
          if (deliveryResponse.ok) updateSessionCredential(delivery);
        }));
      } catch {
        // Background delivery confirmation must never replace a usable chat UI
        // with an error. The next poll safely retries the idempotent receipt.
      }
    };
    const timer = window.setInterval(poll, 2_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const changeAppointment = async (action, time) => {
    const intake = appointmentState.intake;
    if (!intake || appointmentState.status === "submitting") return;
    const epoch = sessionEpochRef.current;
    const key = `apt-${intake.id}-${intake.version}-${action}-${time.preferred_date || ""}-${time.preferred_time || time.time_period || ""}`;
    setAppointmentState((current) => ({ ...current, status:"submitting", error:"" }));
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, `/api/public/appointment-intakes/${intake.id}/${action}`), { method:"POST", credentials:"include", headers:{ ...publicHeaders(), "Idempotency-Key":key }, body:JSON.stringify({ ...time, session_id:sessionIdRef.current, expected_version:intake.version, customer_confirmed:true }) });
      const body = await response.json();
      if (epoch !== sessionEpochRef.current) return;
      if (!response.ok) {
        if (response.status === 409) {
          const latest = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/appointment-intakes/current"), { method:"POST", credentials:"include", headers:publicHeaders(), body:JSON.stringify({ session_id:sessionIdRef.current }) });
          if (latest.ok) { const value = await latest.json(); if (epoch === sessionEpochRef.current) setAppointmentState((current) => ({ ...current, intake:value.intake || current.intake })); }
        }
        throw new Error(body?.error?.message || "更新失败，请稍后重试。");
      }
      setAppointmentState((current) => ({ ...current, status:"accepted", error:"", intake:body.intake, message:body.message }));
    } catch (err) { if (epoch === sessionEpochRef.current) setAppointmentState((current) => ({ ...current, status:"accepted", error:err.message })); }
  };

  const submitAppointment = async (proposal, profileSignals = {}, time = {}) => {
    if (!proposal?.id || appointmentState.status === "submitting") return;
    const epoch = sessionEpochRef.current;
    setAppointmentState((current) => ({ ...current, status:"submitting", error:"", actionId:proposal.id, message:"" }));
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/appointment-intakes"), {
        method:"POST",
        credentials:"include",
        headers:publicHeaders(),
        body:JSON.stringify({
          action_id:proposal.id,
          session_id:sessionIdRef.current,
          ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}),
          projects:Array.isArray(profileSignals.projects) ? profileSignals.projects : [],
          doctor:Array.isArray(profileSignals.doctors) ? profileSignals.doctors[0] : "",
          ...time,
          branch:"上海华美医疗美容医院",
          customer_confirmed:true
        })
      });
      const body = await response.json();
      updateSessionCredential(body);
      if (epoch !== sessionEpochRef.current) return;
      if (!response.ok) throw new Error(body?.error?.message || "到院登记暂时无法提交");
      setAppointmentState({ status:"accepted", error:"", actionId:proposal.id, intake:body.intake, message:body.message });
    } catch (appointmentError) {
      if (epoch === sessionEpochRef.current) setAppointmentState((current) => ({ ...current, status:"idle", error:appointmentError.message, actionId:proposal.id, message:"" }));
    }
  };

  const submitFeedback = async (message, rating) => {
    const replyId = message.groupId || message.id;
    if (!replyId || feedbackByReply[replyId]?.status === "saving") return;
    setFeedbackByReply((current) => ({ ...current, [replyId]:{ status:"saving", rating } }));
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-feedback"), {
        method:"POST",
        credentials:"include",
        headers:publicHeaders(),
        body:JSON.stringify({
          session_id:sessionIdRef.current,
          ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}),
          reply_id:replyId,
          rating,
          transcript:messages.slice(-24).map((item) => ({ id:item.id, role:item.role, content:item.content, at:item.at }))
        })
      });
      const body = await response.json();
      updateSessionCredential(body);
      if (!response.ok) throw new Error(body?.error?.message || "反馈暂时无法记录");
      setFeedbackByReply((current) => ({ ...current, [replyId]:{ status:"saved", rating, feedbackId:body.feedback?.id || "" } }));
    } catch {
      setFeedbackByReply((current) => ({ ...current, [replyId]:{ status:"error", rating } }));
    }
  };

  const submitQuestion = async (event) => {
    event.preventDefault();
    const question = input.trim();
    if (!question || isLoading || restoringSession || questionInFlightRef.current) return;
    questionInFlightRef.current = true;
    const idempotencyKey = `chat-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    inputRef.current?.focus({ preventScroll:true });
    // The server persists message_id verbatim. Reuse it locally so the history
    // poll reconciles this optimistic message instead of rendering it twice.
    setMessages((current) => [...current, { id:idempotencyKey, role:"user", content:question, at:new Date().toISOString(), optimistic:true }]);
    setInput("");
    setError("");
    setIsLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-chat"), {
        method:"POST",
        credentials:"include",
        headers:{ ...publicHeaders(), "Idempotency-Key":idempotencyKey },
        body:JSON.stringify({ message:question, message_id:idempotencyKey, session_id:sessionIdRef.current, ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}) }),
        signal:controller.signal
      });
      const body = await response.json();
      updateSessionCredential(body);
      if (!response.ok) throw new Error(body?.error?.message || "咨询服务暂时不可用");
      if (body.lead_receipt?.status === "accepted") setLeadState({status:"captured", error:"", result:body.lead_receipt, consentText:""});
      const segments = Array.isArray(body.reply_segments)
        ? body.reply_segments.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const replySegments = segments.length ? segments : [String(body.reply || "").trim()].filter(Boolean);
      const replyGroupId = body.run_id || `assistant-${Date.now()}`;
      const serverReplyId = String(body.assistant_message_id || `${idempotencyKey}:reply`);
      const serverReplyText = String(body.reply || replySegments.join("\n")).trim();
      const replyAt = new Date().toISOString();
      const presentationSegments = replySegments.map((content, index) => {
        const isFinalSegment = index === replySegments.length - 1;
        return {
          id:`${replyGroupId}-${index + 1}`,
          groupId:replyGroupId,
          serverReplyId,
          serverReplyText,
          role:"assistant",
          content,
          isContinuation:index > 0,
          isFinalSegment,
          citations:isFinalSegment ? body.citations || [] : [],
          media:isFinalSegment ? body.media || [] : [],
          status:body.status,
          handover:isFinalSegment ? body.handover : null,
          profileSignals:isFinalSegment ? body.profile_signals : null,
          leadCapture:isFinalSegment ? body.lead_capture : null,
          orchestration:isFinalSegment ? body.orchestration : null,
          at:replyAt
        };
      });
      setMessages((current) => mergeReplySegments(current, presentationSegments));
    } catch (requestError) {
      const message = requestError.name === "AbortError" ? "本次咨询响应时间较长，请稍后重新提问。" : requestError.message;
      setError(message);
      setMessages((current) => [...current, { id:`error-${Date.now()}`, role:"assistant", content:`抱歉，${message}`, status:"error", citations:[], isFinalSegment:true, at:new Date().toISOString() }]);
    } finally {
      window.clearTimeout(timer);
      setIsLoading(false);
      questionInFlightRef.current = false;
    }
  };

  const leadPromptMessageId = [...messages].reverse().find((message) => message.role === "assistant" && message.leadCapture?.should_prompt)?.id;

  return (
    <div className={`advisor-shell ${chatStarted ? "chat-mode" : "welcome-mode"}`}>
      {!chatStarted && (
        <section className="hero" aria-label="时代之美获客顾问">
          <img src={HERO_IMAGE_URL} alt="时代之美获客顾问" />
          <div className="hero-overlay" />
          <div className="hero-content">
            <h1>小美</h1>
            <p className="hero-subtitle">AI 获客顾问</p>
            <p className="hero-description">描述您的关注点与美丽期许<br />让小美为您讲解相关医美项目</p>
            <div className="quick-questions">
              {QUICK_QUESTIONS.map((question) => <button type="button" key={question} onClick={() => setInput(question)}>{question}</button>)}
            </div>
          </div>
          <div className="down-cue"><DownIcon /></div>
        </section>
      )}

      {chatStarted && (
        <header className="chat-header">
          <div className="brand-lockup"><span className="brand-avatar">美</span><span>AI获客顾问·小美</span></div>
          <button className="new-chat" type="button" onClick={resetConversation}><span>＋</span> 新对话</button>
        </header>
      )}

      <main className="advisor-workspace">
        <div className="message-scroller" aria-live="polite" ref={messageScrollerRef} onScroll={updateScrollAnchor}>
          {messages.map((message) => {
            const feedbackKey = message.groupId || message.id;
            return <ChatMessage key={message.id} message={message} showLeadCapture={message.id === leadPromptMessageId && !leadState.result} leadState={leadState} appointmentState={appointmentState} onLeadSubmit={submitLead} onAppointmentSubmit={submitAppointment} feedback={feedbackByReply[feedbackKey]} onFeedback={(rating) => submitFeedback(message, rating)} onPreview={setKnowledgePreview} />;
          })}
          {leadState.result && <LeadCaptureCard result={leadState.result} status={leadState.status} error="" prompt={{}} onSubmit={submitLead} />}
          <AppointmentRegistrationCard state={appointmentState} onChange={changeAppointment} />
          {isLoading && (
            <article className="assistant-message loading-message">
              <div className="assistant-label"><span className="assistant-avatar">美</span><span>小美 · AI获客顾问</span></div>
              <div className="loading-line"><span /><span /><span /></div>
              <div className="loading-copy">{statusText}</div>
            </article>
          )}
          {error && <span className="sr-only">{error}</span>}
        </div>
        <Composer value={input} onChange={setInput} onSubmit={submitQuestion} disabled={isLoading || restoringSession} restoringSession={restoringSession} inputRef={inputRef} />
      </main>
      <KnowledgeMediaPreview preview={knowledgePreview} onClose={() => setKnowledgePreview(null)} />
    </div>
  );
}
