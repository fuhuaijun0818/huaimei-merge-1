import { readFileSync } from "node:fs";

const invalid = (code, message) => Object.assign(new Error(message), { code, status:400 });
export const shanghaiDate = (now = Date.now()) => new Date(Number(now) + 8 * 3_600_000).toISOString().slice(0, 10);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value) {
  return datePattern.test(String(value)) && Number.isFinite(Date.parse(`${value}T00:00:00+08:00`))
    && shanghaiDate(Date.parse(`${value}T00:00:00+08:00`)) === value;
}

export function normalizeAppointmentTime(payload, now = Date.now()) {
  const date = String(payload.preferred_date || "").trim();
  const time = String(payload.preferred_time || "").trim();
  const period = String(payload.time_period || "").trim();
  if (!validDate(date)) throw invalid("APPOINTMENT_DATE_REQUIRED", "请选择完整的到院日期，含糊的时间需先确认。");
  if (period && !["morning", "afternoon", "evening"].includes(period)) throw invalid("APPOINTMENT_TIME_INVALID", "请选择有效的到院时段。");
  if (time && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || period)) throw invalid("APPOINTMENT_TIME_INVALID", "具体时间需为24小时制，且不能同时指定半日时段。");
  if (date < shanghaiDate(now)) throw invalid("APPOINTMENT_TIME_PAST", "该到院日期已经过去，请重新选择。");
  if (date === shanghaiDate(now) && !time) throw invalid("APPOINTMENT_TODAY_TIME_REQUIRED", "今天到院需要确认尚未到达的具体钟点。");
  if (time && Date.parse(`${date}T${time}:00+08:00`) <= now) throw invalid("APPOINTMENT_TIME_PAST", "该到院时间已经过去，请重新选择。");
  const suffix = time || ({ morning:"上午", afternoon:"下午", evening:"晚上" }[period] || "");
  return { preferred_date:date, preferred_time:time || null, time_period:period || null,
    time_precision:time ? "minute" : period ? "period" : "date", time_preference:`${date}${suffix ? ` ${suffix}` : ""}`,
    timezone:"Asia/Shanghai" };
}

// Calendar data must be maintained from an identified source. Missing or
// expired coverage never silently turns ordinary weekdays into workdays.
export function appointmentDateRecommendations({ now = Date.now(), calendar } = {}) {
  if (calendar === undefined && process.env.HUAMEI_WORKDAY_CALENDAR_FILE) {
    try { calendar = JSON.parse(readFileSync(process.env.HUAMEI_WORKDAY_CALENDAR_FILE, "utf8")); } catch { calendar = null; }
  }
  const unavailable = { available:false, dates:[], calendar_version:null, reason:"工作日日历暂不可用，请自主选择期望到院日期。" };
  const today = shanghaiDate(now);
  if (!calendar?.version || !calendar.source || !calendar.maintained_by
    || !validDate(calendar.coverage_start) || !validDate(calendar.coverage_end)
    || calendar.coverage_start > today || calendar.coverage_end < today
    || !(Date.parse(calendar.expires_at) > now)) return unavailable;
  const overrides = calendar.overrides || {};
  if (Object.entries(overrides).some(([date, workday]) => !validDate(date) || typeof workday !== "boolean")) return unavailable;
  const dates = [];
  for (let offset = 1; offset <= 60 && dates.length < 2; offset++) {
    const ms = Date.parse(`${today}T00:00:00+08:00`) + offset * 86_400_000;
    const date = shanghaiDate(ms);
    if (date > calendar.coverage_end) return unavailable;
    const weekday = new Date(ms + 8 * 3_600_000).getUTCDay();
    if (overrides[date] ?? (weekday >= 1 && weekday <= 5)) dates.push({ date, label:`${date} 星期${"日一二三四五六"[weekday]}` });
  }
  return dates.length === 2 ? { available:true, dates, calendar_version:calendar.version, source:calendar.source, computed_for:today } : unavailable;
}
