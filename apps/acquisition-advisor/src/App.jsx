import { useEffect, useMemo, useRef, useState } from "react";

const QUICK_QUESTIONS = [
  "脸部松弛，想了解抗初老项目",
  "热玛吉和线雕有什么区别？",
  "皮肤暗沉发黄，想提亮"
];

// 本机保存客户自己的会话凭证，用于刷新后回读服务端确认过的会话与人工消息。
const SESSION_STORAGE_KEY = "huamei.advisor.session.v1";

const emptyConversation = () => [];
const APPOINTMENT_LEAD_CAPTURE_PROMPT = Object.freeze({
  title:"请先保存联系方式",
  description:"为便于顾问与您确认到院安排，请留下本次咨询的联系方式。手机号将由顾问回电时人工核对。",
  consent_text:"我同意顾问仅为本次到院安排和咨询服务使用以上联系方式"
});
const appointmentLeadCaptureRequired = (message) => message?.orchestration?.action_proposal?.type === "appointment_request";
const appointmentProjectFromMessage = (value) => {
  const text = String(value || "").replace(/\s+/g, "").trim();
  const match = text.match(/(?:预约|约面诊|安排到院)(?:一下)?[，,：:]?([^，。！？!?]{2,24})/);
  return String(match?.[1] || "").replace(/(?:面诊|咨询|项目)$/g, "").trim().slice(0, 80);
};
// 与服务端同一套规范化：+86 / 0086 / 空格 / 短横线都归一为本地号码，并且按整串
// 处理。绝不能截断超过 11 位的输入，否则无效号码会被改写成有效号码后保存。只在离开输入框和提交时调用，
// 输入过程中不做整体重写，否则粘贴/快速输入会被 React 的受控更新吃掉字符。
const normalizeMobileInput = (value) => {
  const digits = String(value || "").normalize("NFKC").replace(/\D/g, "");
  const local = /^1[3-9]\d{9}$/.test(digits) ? digits : digits.replace(/^(?:00)?86/, "");
  return local;
};
const isValidMainlandMobileInput = (value) => /^1[3-9]\d{9}$/.test(normalizeMobileInput(value));

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
    // 本地客户消息（含已被流式回执确认、id 仍是本地生成的那种）都要参与历史回放去重：
    // 服务端给客户消息分配的是自己的 msg-<uuid>，与本地 messageKey 不同，
    // 只按 optimistic 判断会漏掉已确认的那条，于是同一句话被当作新消息再追加一次，
    // 表现为重复气泡和两次轮询之间的顺序来回跳。
    if (message?.role === "user" && (message?.optimistic || !/^msg-/u.test(String(message?.id || "")))) {
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

function Composer({ value, onChange, onSubmit, disabled, restoringSession, inputRef, onStop, waiting, uploadCapability, onUpload, uploadError, onRetryUpload }) {
  const filePickerRef = useRef(null);
  const canSend = value.trim() && !disabled;
  return (
    <div className="composer-area">
      <form className="composer" onSubmit={onSubmit}>
        {uploadCapability?.enabled && (
          <>
            <input
              ref={filePickerRef}
              type="file"
              className="composer-file"
              accept={(uploadCapability.accepted_types || []).join(",")}
              aria-label="添加图片或资料"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; onUpload?.(file); }}
            />
            <button type="button" className="attach-button" aria-label="添加图片或资料" onClick={() => filePickerRef.current?.click()}>
              +
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          aria-label="咨询内容"
          autoComplete="off"
          rows={1}
          disabled={restoringSession}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // 中文输入法组合态的回车只用于确认候选词，不发送消息。
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              event.preventDefault();
              return;
            }
            // Shift+Enter 在输入框内换行，回车才发送。
            if (event.shiftKey) return;
            event.preventDefault();
            if (!value.trim() || disabled) return;
            onSubmit({ preventDefault() {} });
          }}
          maxLength={1000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="描述您的关注点，例如：脸部松弛、肤色暗沉…"
          value={value}
        />
        <button className="send-button" type="submit" disabled={!canSend} aria-label="发送咨询">
          <SendIcon />
        </button>
      </form>
      {uploadError && (
        <div className="upload-status" role="alert">
          <span>{uploadError}</span>
          <button type="button" className="retry-button" onClick={() => onRetryUpload?.()} aria-label="重试上传">重试上传</button>
        </div>
      )}
      {waiting && (
        <div className="composer-waiting" role="status">
          <span>小美正在整理资料…</span>
          <button type="button" className="stop-button" onClick={onStop} aria-label="停止等待">
            停止等待
          </button>
        </div>
      )}
      <p className="compliance-note">时代之美 · AI获客顾问·小美 · 项目信息仅供参考，具体适用性请咨询专业医师</p>
    </div>
  );
}

const publicMediaUrl = (value = "") => {
  const rawUrl = String(value || "");
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : joinBaseUrl(API_BASE_URL, rawUrl);
};

// A-025 AC4：链接失效时向客户说明原因（已撤回/已过期/不可公开发送），
// 而不是留一张破图。原因取自媒体端点的错误体，取不到时用兜底文案。
const mediaFailureReason = async (url) => {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.ok) return "";
    const body = await response.json().catch(() => null);
    return String(body?.error?.message || "");
  } catch {
    return "";
  }
};

function MediaUnavailable({ url, fallback = "该资料暂时无法预览" }) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    let cancelled = false;
    mediaFailureReason(url).then((message) => { if (!cancelled && message) setReason(message); });
    return () => { cancelled = true; };
  }, [url]);
  return <span className="public-media-unavailable" role="status">{fallback}{reason ? `：${reason}` : "，请联系顾问获取最新版本"}</span>;
}

function KnowledgeSources({ citations = [], onPreview }) {
  if (!citations.length) return null;
  return (
    <div className="knowledge-sources" aria-label="参考资料">
      <span>参考资料</span>
      {citations.slice(0, 6).map((citation) => {
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
      {citations.length > 6 && <span className="source-more">另有 {citations.length - 6} 条资料</span>}
    </div>
  );
}

function PublicMediaCard({ item, src, onPreview }) {
  const [failed, setFailed] = useState(false);
  const isPdf = item.type === "pdf";
  return (
    <button className="public-media-card" type="button" onClick={() => onPreview({ ...item, url:src })} title={`点击预览${isPdf ? " PDF" : "图片"}`}>
      {isPdf
        ? <span className="public-media-pdf" aria-hidden="true"><strong>PDF</strong><span>点击预览公开资料</span></span>
        : failed
          ? <MediaUnavailable url={src} fallback="该资料链接已失效" />
          : <img src={src} alt={item.alt || item.title || "公开宣传资料"} loading="lazy" onError={() => setFailed(true)} />}
      <span className="public-media-caption">{item.title || "公开宣传资料"}{item.requires_verification ? <em>资料需核验</em> : null}</span>
    </button>
  );
}

function PublicKnowledgeMedia({ media = [], onPreview }) {
  if (!media.length) return null;
  return (
    <div className="public-knowledge-media" aria-label="公开宣传资料">
      {media.slice(0, 2).map((item) => {
        const src = publicMediaUrl(item?.url);
        if (!src) return null;
        return <PublicMediaCard item={item} src={src} key={item.id || src} onPreview={onPreview} />;
      })}
    </div>
  );
}

function KnowledgeMediaPreview({ preview, onClose }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, onClose]);
  useEffect(() => { setFailed(false); }, [preview?.url]);
  if (!preview?.url) return null;
  const isPdf = preview.type === "pdf";
  const title = preview.title || (isPdf ? "公开 PDF 资料" : "公开图片资料");
  return (
    <div className="knowledge-preview-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="knowledge-preview-dialog" role="dialog" aria-modal="true" aria-label={`${title}预览`}>
        <header className="knowledge-preview-header"><div><span>参考资料预览</span><strong>{title}</strong></div><button type="button" className="knowledge-preview-close" onClick={onClose} aria-label="关闭资料预览">×</button></header>
        <div className={`knowledge-preview-content ${isPdf ? "is-pdf" : "is-image"}`}>
          {failed
            ? <p className="public-media-unavailable" role="status"><MediaUnavailable url={preview.url} fallback="该资料链接已失效" /></p>
            : isPdf
              ? <iframe src={preview.url} title={title} />
              : <img src={preview.url} alt={preview.alt || title} onError={() => setFailed(true)} />}
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
  const [mobileError, setMobileError] = useState("");
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
    if (!isValidMainlandMobileInput(mobile)) {
      setMobileError("请输入有效的11位中国大陆手机号");
      return;
    }
    setMobileError("");
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
      <form className="lead-form" onSubmit={submit} noValidate>
        <label><span>怎么称呼您 <em>选填</em></span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" placeholder="您的称呼" /></label>
        <label><span>手机号</span><input value={mobile} onChange={(event) => { setMobile(cleanMobileTyping(event.target.value)); setMobileError(""); }} onBlur={() => setMobile(normalizeMobileInput(mobile))} required maxLength={20} pattern="(?:00)?(?:\+?86)?1[3-9][0-9]{9}" inputMode="tel" autoComplete="tel" placeholder="11位手机号，可粘贴 +86 或 0086" aria-invalid={Boolean(error || mobileError)} aria-describedby={mobileError ? "lead-mobile-error" : undefined} /></label>
        <label className="lead-consent"><input type="checkbox" checked={serviceConsent} onChange={(event) => setServiceConsent(event.target.checked)} required /><span>{prompt.consent_text || "请阅读并同意本次咨询联系授权"}</span></label>
        {mobileError && <div id="lead-mobile-error" className="lead-error" role="alert">{mobileError}</div>}
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

function AppointmentActionCard({ proposal, profileSignals, leadCaptured, state, onSubmit, allowSubjectEntry = false }) {
  const [time, setTime] = useState(blankAppointmentTime);
  const [confirmed, setConfirmed] = useState(false);
  const [subject, setSubject] = useState("");
  if (!proposal || proposal.type !== "appointment_request" || state?.intake?.status === "registered") return null;
  const projects = Array.isArray(profileSignals?.projects) ? profileSignals.projects.filter(Boolean) : [];
  const doctor = profileSignals?.doctors?.[0];
  const selectedProjects = projects.length ? projects : subject.trim() ? [subject.trim()] : [];
  const subjectReady = selectedProjects.length || doctor;
  return <section className="lead-capture-card appointment-action-card">
    <div className="lead-card-kicker">到院时间登记</div><h3>确认您希望到院的时间</h3>
    <p>院区：上海华美医疗美容医院<br />咨询内容：{selectedProjects.join("、") || "项目待补充"}{doctor ? ` · ${doctor}医生` : ""}</p>
    <p>{leadCaptured ? "使用本次咨询已保存的联系方式，顾问后续回电核对手机号与到院安排。" : "请先保存本次咨询的联系方式。"}</p>
    {!subjectReady && !allowSubjectEntry && <p className="appointment-hint">请先在对话中确认想咨询的项目或医生。</p>}
    <form className="lead-form" onSubmit={(e) => { e.preventDefault(); if (confirmed) onSubmit(proposal, { ...profileSignals, projects:selectedProjects }, appointmentTimePayload(time)); }}>
      {allowSubjectEntry && !projects.length && !doctor && <label><span>咨询项目或医生</span><input required maxLength={80} value={subject} onChange={(event) => { setSubject(event.target.value); setConfirmed(false); }} placeholder="例如：热玛吉" /></label>}
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

const shouldApplyAppointmentResponse = (current, submitted, incoming) => {
  if (!incoming || current?.id !== submitted?.id) return false;
  const currentVersion = Number(current.version) || 0;
  const incomingVersion = Number(incoming.version) || 0;
  if (incomingVersion < currentVersion) return false;
  return current.status !== "cancelled" || incoming.status === "cancelled";
};

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

function ChatMessage({ message, showLeadCapture, leadState, appointmentState, onLeadSubmit, onAppointmentSubmit, feedback, onFeedback, onPreview, onRetry }) {
  if (message.role === "user") return (
    <div className={`user-message ${message.status ? `is-${message.status}` : ""}`}>
      <span className="user-message-text">{message.content}</span>
      {message.attachment && (
        <em className="attachment-state">
          附件已在本地保存（{Math.max(1, Math.round(message.attachment.size / 1024))} KB）· 仅客户侧可见
        </em>
      )}
      {message.status === "sending" && <em className="message-state">发送中…</em>}
      {message.status === "stopped" && <em className="message-state">已停止等待</em>}
      {message.status === "failed" && (
        <em className="message-state">
          未送达
          <button type="button" className="retry-button" onClick={() => onRetry?.(message)} aria-label="重试发送这条消息">重试</button>
        </em>
      )}
    </div>
  );
  // 历史回读里的人工顾问回复（B 的会话留档）：与 AI 气泡分开显示，
  // 客户能一眼看出哪一条是人发的。
  if (message.role === "staff") return (
    <article className="assistant-message human-agent-message">
      <div className="assistant-label"><span className="assistant-avatar">顾</span><span>人工顾问</span></div>
      <div className="assistant-copy">{message.content}</div>
    </article>
  );
  const medicalHandover = ["medical_emergency", "medical_safety", "medical_boundary"].includes(message.handover?.reason);
  const source = message.source || "ai";
  const sourceLabel = source === "human" ? "人工顾问" : source === "system" ? "系统提示" : "小美 · AI获客顾问";
  const sourceAvatar = source === "human" ? "顾" : source === "system" ? "系" : "美";
  // 预约提案会先要求联系方式；B 的专用留资提示与提案一起渲染。
  const leadPrompt = appointmentLeadCaptureRequired(message)
    ? { ...APPOINTMENT_LEAD_CAPTURE_PROMPT, ...(message.leadCapture || {}) }
    : message.leadCapture;
  return (
    <article className={`assistant-message source-${source} ${message.isContinuation ? "continuation" : ""} ${message.status === "handover_required" ? "handover" : ""}`}>
      {!message.isContinuation && <div className="assistant-label"><span className="assistant-avatar">{sourceAvatar}</span><span>{sourceLabel}</span></div>}
      <div className="assistant-copy">{message.content}</div>
      {message.generating && <div className="stream-state" role="status">正在生成…</div>}
      {message.aborted && !message.generating && (
        <div className="stream-state aborted">已中止（这段内容未提交）</div>
      )}
      {message.isFinalSegment && message.status === "handover_required" && <div className="handover-note">{medicalHandover ? "该问题需要人工顾问或医生进一步协助，小美不会在线判断或提供医疗处置建议。" : "该问题已停止自动推进，需要由相关人工团队继续处理。"}</div>}
      <PublicKnowledgeMedia media={message.media} onPreview={onPreview} />
      <KnowledgeSources citations={message.citations} onPreview={onPreview} />
      {message.isFinalSegment && <ConversationFeedback feedback={feedback} onFeedback={onFeedback} />}
      {showLeadCapture && <LeadCaptureCard prompt={{ ...leadPrompt, consent_text:leadState.consentText || leadPrompt?.consent_text }} status={leadState.status} error={leadState.error} result={leadState.result} onSubmit={onLeadSubmit} handover={message.handover} />}
      {message.isFinalSegment && <AppointmentActionCard proposal={message.orchestration?.action_proposal} profileSignals={message.profileSignals} leadCaptured={Boolean(leadState.result)} state={appointmentState} onSubmit={onAppointmentSubmit} allowSubjectEntry={message.handover?.required === true} />}
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
  const sessionIdRef = useRef(createSessionId());
  const sessionTokenRef = useRef("");
  const sessionEpochRef = useRef(0);
  const activeRequestRef = useRef(null);
  const stoppedByUserRef = useRef(false);
  const scrollerRef = useRef(null);
  const atBottomRef = useRef(true);
  // 公开会话凭证就绪后才开始历史轮询与送达确认，避免首次加载时打空请求。
  const publicSessionReadyRef = useRef(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [uploadCapability, setUploadCapability] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef(null);
  const pendingUploadRef = useRef(null);
  const chatStarted = messages.length > 0 || isLoading || Boolean(appointmentState.intake);

  const statusText = useMemo(() => isLoading ? "正在为您整理相关项目信息…" : "", [isLoading]);

  // 恢复会话时保持客户原来的阅读位置：只有本来就贴在底部时才自动滚动，
  // 客户主动上滑看历史时改为提示有新消息。
  const stickToBottom = (behavior = "smooth") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    atBottomRef.current = true;
    setUnseenCount(0);
  };

  useEffect(() => {
    if (atBottomRef.current) stickToBottom();
    else setUnseenCount((current) => current + 1);
  }, [messages, isLoading]);

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
    setUnseenCount(0);
    setRestoreFailed(false);
    clearPersistedSessionCredential();
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
    persistSessionCredential();
  };

  // 会话凭证保存在浏览器本地，刷新后才能带着同一凭证回读服务端确认过的会话。
  const persistSessionCredential = () => {
    try {
      globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        session_id: sessionIdRef.current,
        session_token: sessionTokenRef.current
      }));
    } catch {}
  };

  const clearPersistedSessionCredential = () => {
    try { globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY); } catch {}
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

  const readStoredSessionCredential = () => {
    try {
      const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.session_id ? parsed : null;
    } catch {
      return null;
    }
  };

  // A-025：上传等能力位由服务端下发。这个接口同时会按本机保存的会话凭证续签
  // 本机会话，因此刷新后仍能拿到同一会话的能力开关；取不到时按"未启用上传"处理。
  const loadUploadCapability = async () => {
    const epoch = sessionEpochRef.current;
    const stored = readStoredSessionCredential();
    if (stored) {
      sessionIdRef.current = stored.session_id;
      sessionTokenRef.current = stored.session_token || "";
    }
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-conversation"), {
        method:"POST",
        credentials:"include",
        headers:{ ...publicHeaders(), "Content-Type":"application/json" },
        body:JSON.stringify({
          session_id:sessionIdRef.current,
          ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}),
          limit:1
        })
      });
      const body = await response.json();
      if (epoch !== sessionEpochRef.current) return;
      if (!response.ok) return;
      updateSessionCredential(body);
      if (body?.capabilities?.customer_upload) setUploadCapability(body.capabilities.customer_upload);
    } catch {
      // 能力位取不到时按"上传未启用"处理，不阻塞对话本身。
    }
  };

  // 历史回读：客户与 AI 消息来自会话存储，人工顾问回复来自留档，由服务端合并后
  // 一并返回。首次加载失败时页面给出重试入口，绝不把旧消息挂到新客户身上。
  const reloadHistory = async () => {
    const epoch = sessionEpochRef.current;
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-history"), {
        method:"GET",
        credentials:"include",
        headers:publicHeaders()
      });
      const body = await response.json();
      if (epoch !== sessionEpochRef.current) return;
      if (!response.ok) throw new Error(body?.error?.message || "无法恢复上次的咨询记录");
      updateSessionCredential(body);
      const restored = restoreConversationMessages(body.messages);
      if (restored.length) setMessages(restored);
      setRestoreFailed(false);
    } catch (restoreError) {
      if (epoch !== sessionEpochRef.current) return;
      setRestoreFailed(true);
      setError(restoreError.message || "无法恢复当前会话，请刷新重试。");
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
      // 能力位与历史回读都不阻塞“恢复到院登记”的结果：能力位失败只影响上传按钮。
      if (!cancelled && epoch === sessionEpochRef.current) await loadUploadCapability();
      if (!cancelled && epoch === sessionEpochRef.current) await reloadHistory();
      if (cancelled || epoch !== sessionEpochRef.current) return;
      if (appointmentRestoreError) setError(appointmentRestoreError.message);
      setRestoringSession(false);
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
      setAppointmentState((current) => {
        if (!shouldApplyAppointmentResponse(current.intake, intake, body.intake)) return current;
        return { ...current, status:"accepted", error:"", intake:body.intake, message:body.message };
      });
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
    event?.preventDefault?.();
    if (isLoading || restoringSession || questionInFlightRef.current) return;
    const question = input.trim();
    if (!question) return;
    await sendQuestion({ question });
  };

  // 客户端消息标识随消息一起发给服务端，并用同一个标识做幂等键：重试不会
  // 增加重复对话、客户或预约记录；成功回执只更新原来那条消息。
  const parseSseChunk = (chunk = "") => {
    let event = "message";
    const dataLines = [];
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    let data = null;
    if (dataLines.length) {
      try { data = JSON.parse(dataLines.join("\n")); } catch { data = null; }
    }
    return { event, data };
  };

  // A-005：分片推送 + 最终回执。重复片段按序号丢弃，断线时带 since_seq 只补缺失片段。
  const streamReply = async ({ question, messageKey, controller }) => {
    const streamId = `stream-${messageKey}`;
    let sinceSeq = 0;
    let text = "";
    const applyDelta = (delta) => {
      if (!delta) return;
      const seq = Number(delta.seq) || 0;
      if (seq && seq <= sinceSeq) return;
      sinceSeq = Math.max(sinceSeq, seq);
      text += String(delta.text || "");
      setMessages((current) => current.some((item) => item.id === streamId)
        ? current.map((item) => item.id === streamId ? { ...item, content:text, seq:sinceSeq, generating:true } : item)
        : [...current, {
            id:streamId, groupId:streamId, role:"assistant", source:"ai",
            content:text, seq:sinceSeq, generating:true,
            citations:[], isFinalSegment:false, at:new Date().toISOString()
          }]);
    };
    const open = (since) => fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-chat/stream"), {
      method:"POST",
      credentials:"include",
      headers:{ ...publicHeaders(), "Content-Type":"application/json", "Idempotency-Key":messageKey },
      body:JSON.stringify({
        message:question,
        client_message_id:messageKey,
        message_id:messageKey,
        since_seq:since,
        session_id:sessionIdRef.current,
        ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {})
      }),
      signal:controller.signal
    });
    let receipt = null;
    for (let attempt = 0; attempt < 2 && !receipt; attempt += 1) {
      const response = await open(sinceSeq);
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null);
        // 流式通道不可用时回落到普通接口，客户照样能拿到回执。
        if (attempt === 0 && sinceSeq === 0) return requestReplyReceipt({ question, messageKey, controller });
        throw new Error(detail?.error?.message || "咨询服务暂时不可用");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream:true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const { event, data } = parseSseChunk(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (event === "delta") applyDelta(data);
          else if (event === "final") receipt = data;
          else if (event === "error") throw new Error(data?.message || "咨询服务暂时不可用");
        }
      }
    }
    if (!receipt) throw new Error("本次咨询响应中断，请稍后重试");
    return receipt;
  };

  const requestReplyReceipt = async ({ question, messageKey, controller }) => {
    const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-chat"), {
      method:"POST",
      credentials:"include",
      headers:{ ...publicHeaders(), "Idempotency-Key":messageKey },
      body:JSON.stringify({ message:question, client_message_id:messageKey, message_id:messageKey, session_id:sessionIdRef.current, ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {}) }),
      signal:controller.signal
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || "咨询服务暂时不可用");
    return body;
  };

  // 最终回执为准：未提交的流式片段在这里被丢弃，替换成服务端确认过的分段答复。
  // 同时保留 B 的“服务端整段答复 ↔ 本地分段气泡”对账信息，历史轮询命中同一轮
  // 时替换而不是重复渲染。
  const applyReplyReceipt = (body, messageKey, question = "") => {
    updateSessionCredential(body);
    if (body.lead_receipt?.status === "accepted") setLeadState({ status:"captured", error:"", result:body.lead_receipt, consentText:"" });
    const segments = Array.isArray(body.reply_segments)
      ? body.reply_segments.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const replySegments = segments.length ? segments : [String(body.reply || "").trim()].filter(Boolean);
    // 预约提案可能带“先留联系方式”的要求一起回来；项目名按客户原话兜底。
    const bookingProject = appointmentProjectFromMessage(question);
    const responseProfileSignals = {
      ...(body.profile_signals || {}),
      projects:bookingProject ? [bookingProject] : (body.profile_signals?.projects || [])
    };
    const handoverAppointmentProposal = body.delivery?.suppress_ai === true && body.orchestration?.action_proposal?.type === "appointment_request"
      ? body.orchestration.action_proposal : null;
    if (handoverAppointmentProposal) {
      setAppointmentState((current) => ({
        ...current,
        proposal:handoverAppointmentProposal,
        profileSignals:responseProfileSignals
      }));
    }
    const replyGroupId = body.run_id || `assistant-${Date.now()}`;
    const serverReplyId = String(body.assistant_message_id || `${messageKey}:reply`);
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
        source:body.handover?.required ? "system" : "ai",
        content,
        isContinuation:index > 0,
        isFinalSegment,
        citations:isFinalSegment ? body.citations || [] : [],
        media:isFinalSegment ? body.media || [] : [],
        status:body.status,
        handover:isFinalSegment ? body.handover : null,
        profileSignals:isFinalSegment ? responseProfileSignals : null,
        leadCapture:isFinalSegment ? body.lead_capture : null,
        orchestration:isFinalSegment ? body.orchestration : null,
        at:replyAt
      };
    });
    setMessages((current) => {
      const confirmed = current
        .filter((item) => item.id !== `stream-${messageKey}`)
        .map((item) => item.clientMessageId === messageKey
          ? { ...item, status:"confirmed", runId:replyGroupId, confirmedAt:replyAt, optimistic:false }
          : item);
      return mergeReplySegments(confirmed, presentationSegments);
    });
  };

  // A-025 AC2：客户上传图片/资料（受服务端能力位控制；失败可重试，客户附件不进知识引用）。
  const submitUpload = async (file) => {
    if (!file || typeof file === "undefined") return;
    const accepted = uploadCapability?.accepted_types || ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    const maxBytes = file.type === "application/pdf"
      ? (uploadCapability?.max_pdf_bytes || 32 * 1024 * 1024)
      : (uploadCapability?.max_image_bytes || 64 * 1024 * 1024);
    pendingUploadRef.current = file;
    setUploadError("");
    if (!accepted.includes(file.type)) {
      setUploadError("仅支持 jpg、png、webp 图片或 pdf 资料");
      return;
    }
    if (file.size > maxBytes) {
      setUploadError(`文件超出体积上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
      return;
    }
    const dataBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(file);
    });
    try {
      const response = await fetch(joinBaseUrl(API_BASE_URL, "/api/public/acquisition-upload"), {
        method:"POST",
        credentials:"include",
        headers:{ ...publicHeaders(), "Idempotency-Key":`upload-${file.name}-${file.size}-${file.lastModified}` },
        body:JSON.stringify({
          file_name:file.name,
          mime_type:file.type,
          data_base64:dataBase64,
          session_id:sessionIdRef.current,
          ...(sessionTokenRef.current ? { session_token:sessionTokenRef.current } : {})
        })
      });
      const body = await response.json();
      updateSessionCredential(body);
      if (!response.ok) throw new Error(body?.error?.message || "上传失败，请稍后重试");
      pendingUploadRef.current = null;
      setMessages((current) => [...current, {
        id:`upload-${body.upload_id}`,
        role:"user",
        content:`[附件] ${file.name}`,
        attachment:{ name:file.name, mime:file.type, size:file.size, uploadId:body.upload_id, status:"uploaded" },
        at:new Date().toISOString()
      }]);
    } catch (error) {
      setUploadError(error.message);
    }
  };

  const sendQuestion = async ({ question, clientMessageId, retryOfId }) => {
    const messageKey = clientMessageId || globalThis.crypto?.randomUUID?.() || `web-msg-${Date.now()}`;
    questionInFlightRef.current = true;
    inputRef.current?.focus({ preventScroll:true });
    setMessages((current) => retryOfId
      ? current.map((item) => item.id === retryOfId ? { ...item, status:"sending", error:"" } : item)
      // 本地消息 id 与服务端 message_id 用同一个标识：历史轮询回来时是替换
      // 这条乐观消息，而不是再追加一遍。
      : [...current, { id:messageKey, clientMessageId:messageKey, role:"user", content:question, at:new Date().toISOString(), status:"sending", error:"", optimistic:true }]);
    if (!retryOfId) setInput("");
    setError("");
    setIsLoading(true);
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 45_000);
    try {
      let receipt = null;
      try {
        receipt = await streamReply({ question, messageKey, controller });
      } catch (streamError) {
        if (streamError.name === "AbortError") throw streamError;
        // 流式通道不可用时回落到普通接口，保证客户仍能拿到回执。
        receipt = await requestReplyReceipt({ question, messageKey, controller });
      }
      applyReplyReceipt(receipt, messageKey, question);
    } catch (requestError) {
      const stopped = stoppedByUserRef.current;
      const timedOut = requestError.name === "AbortError" && !stopped;
      // 对客文案分类：网络失败、业务失败（4xx）、服务不可用（5xx）分别提示，
      // 不再把浏览器的内部错误（如 "Failed to fetch"）直接展示给客户。
      const rawMessage = String(requestError?.message || "").trim();
      const networkFailure = /Failed to fetch|NetworkError|Load failed|network error/i.test(rawMessage)
        || requestError?.name === "TypeError";
      const status = Number(requestError?.status ?? requestError?.statusCode ?? NaN);
      const businessFailure = Number.isFinite(status) && status >= 400 && status < 500;
      const serverFailure = (Number.isFinite(status) && status >= 500) || /服务暂时|不可用|503/.test(rawMessage);
      const failure = stopped
        ? "已停止等待本次回复，您可以继续提问。"
        : timedOut
          ? "本次咨询响应时间较长，请稍后重新提问。"
          : networkFailure
            ? "网络连接异常，请检查网络后重试。"
            : businessFailure
              ? (rawMessage || "提交未通过校验，请修改后重试。")
              : serverFailure
                ? "服务暂时不可用，请稍后重试。"
                : (rawMessage || "发送失败，请重试。");
      setMessages((current) => current.map((item) => item.clientMessageId === messageKey
        ? { ...item, status:stopped ? "stopped" : "failed", error:stopped ? "" : failure }
        : item));
      if (stopped) setError("");
      else {
        setError(failure);
        setMessages((current) => [...current, { id:`error-${Date.now()}`, role:"assistant", source:"system", content:`抱歉，${failure}`, status:"error", citations:[], isFinalSegment:true, at:new Date().toISOString() }]);
      }
      // 已经显示出来的流式片段按“中止”处理：不谎称已完成，也不静默丢失。
      setMessages((current) => current
        .map((item) => item.id === `stream-${messageKey}` ? { ...item, generating:false, aborted:true, abortReason:stopped ? "stopped" : "failed" } : item)
        .filter((item) => !(item.id === `stream-${messageKey}` && !String(item.content || "").trim())));
    } finally {
      window.clearTimeout(timer);
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      stoppedByUserRef.current = false;
      setIsLoading(false);
      questionInFlightRef.current = false;
    }
  };

  // 停止等待只结束这一轮回复，不代表撤销已保存的联系方式或已提交的到院登记。
  const stopWaiting = () => {
    stoppedByUserRef.current = true;
    activeRequestRef.current?.abort();
    setIsLoading(false);
  };

  const retryQuestion = (message) => {
    if (!message || isLoading) return;
    stoppedByUserRef.current = false;
    void sendQuestion({ question:message.content, clientMessageId:message.clientMessageId, retryOfId:message.id });
  };

  const leadPromptMessageId = [...messages].reverse().find((message) => message.role === "assistant"
    && (message.leadCapture?.should_prompt || appointmentLeadCaptureRequired(message)))?.id;

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
        <div
          className="message-scroller"
          aria-live="polite"
          ref={scrollerRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            atBottomRef.current = atBottom;
            if (atBottom) setUnseenCount(0);
          }}
        >
          {messages.map((message) => {
            const feedbackKey = message.groupId || message.id;
            return <ChatMessage key={message.id} message={message} showLeadCapture={message.id === leadPromptMessageId && !leadState.result} leadState={leadState} appointmentState={appointmentState} onLeadSubmit={submitLead} onAppointmentSubmit={submitAppointment} feedback={feedbackByReply[feedbackKey]} onFeedback={(rating) => submitFeedback(message, rating)} onPreview={setKnowledgePreview} onRetry={retryQuestion} />;
          })}
          {leadState.result && <LeadCaptureCard result={leadState.result} status={leadState.status} error="" prompt={{}} onSubmit={submitLead} />}
          {appointmentState.proposal && !appointmentState.intake && <AppointmentActionCard proposal={appointmentState.proposal} profileSignals={appointmentState.profileSignals} leadCaptured={Boolean(leadState.result)} state={appointmentState} onSubmit={submitAppointment} allowSubjectEntry />}
          <AppointmentRegistrationCard state={appointmentState} onChange={changeAppointment} />
          {restoreFailed && (
            <div className="restore-failed" role="alert">
              <p>上次的咨询记录暂时无法恢复，可以重试或直接开始新的咨询。</p>
              <div className="restore-actions">
                <button type="button" onClick={() => { setRestoringSession(true); void reloadHistory().finally(() => setRestoringSession(false)); }}>重试恢复</button>
                <button type="button" onClick={resetConversation}>开始新对话</button>
              </div>
            </div>
          )}
          {unseenCount > 0 && (
            <button type="button" className="unseen-hint" onClick={() => stickToBottom()}>
              有 {unseenCount} 条新消息
            </button>
          )}
          {isLoading && (
            <article className="assistant-message loading-message">
              <div className="assistant-label"><span className="assistant-avatar">美</span><span>小美 · AI获客顾问</span></div>
              <div className="loading-line"><span /><span /><span /></div>
              <div className="loading-copy">{statusText}</div>
            </article>
          )}
          {error && <span className="sr-only">{error}</span>}
        </div>
        <Composer value={input} onChange={setInput} onSubmit={submitQuestion} disabled={isLoading || restoringSession} restoringSession={restoringSession} inputRef={inputRef} onStop={stopWaiting} waiting={isLoading} uploadCapability={uploadCapability} onUpload={submitUpload} uploadError={uploadError} onRetryUpload={() => submitUpload(pendingUploadRef.current)} />
      </main>
      <KnowledgeMediaPreview preview={knowledgePreview} onClose={() => setKnowledgePreview(null)} />
    </div>
  );
}
