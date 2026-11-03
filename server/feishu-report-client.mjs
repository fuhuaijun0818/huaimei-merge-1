const DEFAULT_TIMEOUT_MS = 8_000;

const reportTitle = (report) => `${report.employee_name || report.account_id} ${report.period_label || "人事报告"}`;

export function getFeishuReportStatus(env = process.env) {
  const webhook = String(env.HUAMEI_FEISHU_REPORT_WEBHOOK || "").trim();
  let valid = false;
  try {
    const url = new URL(webhook);
    valid = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  } catch {}
  return {
    configured:Boolean(webhook && valid),
    mode:valid ? "server_webhook" : "not_configured"
  };
}

export async function deliverFeishuReport(report, {
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const webhook = String(env.HUAMEI_FEISHU_REPORT_WEBHOOK || "").trim();
  const status = getFeishuReportStatus(env);
  if (!status.configured) return { status:"not_configured", attempted_at:new Date().toISOString() };
  const timeoutMs = Math.max(2_000, Math.min(Number(env.HUAMEI_FEISHU_REPORT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), 20_000));
  const sections = (report.sections || []).flatMap((section) => [
    `**${section.title}**`,
    ...(section.items || []).map((item) => `- ${item}`)
  ]);
  const payload = {
    msg_type:"post",
    content:{
      post:{
        zh_cn:{
          title:reportTitle(report),
          content:[[
            { tag:"text", text:`统计周期：${new Date(report.range_start).toLocaleDateString("zh-CN")} - ${new Date(report.range_end).toLocaleDateString("zh-CN")}\n` },
            ...sections.map((line) => ({ tag:"text", text:`${line}\n` }))
          ]]
        }
      }
    }
  };
  try {
    const response = await fetchImpl(webhook, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (Number.isFinite(Number(body.code)) && Number(body.code) !== 0)) {
      return {
        status:"failed",
        attempted_at:new Date().toISOString(),
        error_code:body.code || `HTTP_${response.status}`
      };
    }
    return {
      status:"delivered",
      attempted_at:new Date().toISOString(),
      provider_request_id:String(body.data?.message_id || body.data?.request_id || "").slice(0, 160) || null
    };
  } catch (error) {
    return {
      status:"failed",
      attempted_at:new Date().toISOString(),
      error_code:String(error.code || error.name || "FEISHU_REPORT_DELIVERY_FAILED").slice(0, 100)
    };
  }
}
