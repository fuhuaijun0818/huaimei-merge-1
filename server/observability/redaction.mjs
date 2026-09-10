import { redactContactPii } from "../platform/contact-pii-redaction.mjs";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

const credentialKey = /(?:^|[_-])(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|token|api_key|apikey|akey|sign|signature|service_key|private_key|client_secret|access_key|session)(?:$|[_-])/i;
const piiKey = /(?:^|[_-])(?:phone|mobile|telephone|email|id_card|identity_card|national_id|passport|bank_card|credit_card|address|name|full_name|patient_name|customer_name|wechat|wecom|open_id|union_id|prompt|query|input|output|content|message|message_content|body|payload|profile|conversation|customer|patient|headers)(?:$|[_-])/i;

const credentialPatterns = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}\b/gi, "Basic [REDACTED]"],
  [/(?:sk|ak|key)[-_][A-Za-z0-9._-]{12,}/gi, "[REDACTED_CREDENTIAL]"],
  [/([?&](?:access_token|api_key|apikey|akey|key|secret|sign|signature|sig|token)=)[^&#\s]+/gi, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@"]
];

const piiPatterns = [
  [/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
  [/\b\d{17}[0-9Xx]\b/g, "[REDACTED_ID]"],
  [/\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b/g, "[REDACTED_ID]"],
  [/\b(?:\d[ -]?){15,19}\b/g, "[REDACTED_CARD]"]
];

const bounded = (value, maximum) => value.length <= maximum
  ? value
  : `${value.slice(0, maximum)}${TRUNCATED}`;

export function redactString(value, options = {}) {
  const maximum = Number.isInteger(options.maxStringLength) ? options.maxStringLength : 2_000;
  let output = redactContactPii(String(value ?? ""), { replacement:"[REDACTED_PHONE]" });
  for (const secret of options.secrets || []) {
    const normalized = String(secret || "");
    if (normalized.length >= 6) output = output.split(normalized).join(REDACTED);
  }
  for (const [pattern, replacement] of credentialPatterns) output = output.replace(pattern, replacement);
  for (const [pattern, replacement] of piiPatterns) output = output.replace(pattern, replacement);
  return bounded(output, maximum);
}

const redactKey = (key) => credentialKey.test(key) || piiKey.test(key);

export function redactForLog(value, options = {}) {
  const maximumDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  const maximumEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 100;
  const production = options.production !== false;
  const seen = new WeakSet();

  const visit = (current, depth, key = "") => {
    if (redactKey(key)) return REDACTED;
    if (current === null || current === undefined) return current ?? null;
    if (typeof current === "string") return redactString(current, options);
    if (["number", "boolean"].includes(typeof current)) return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "symbol" || typeof current === "function") return `[${typeof current}]`;
    if (Buffer.isBuffer(current)) return `[Buffer ${current.length} bytes]`;
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? "[Invalid Date]" : current.toISOString();
    if (depth >= maximumDepth) return "[MAX_DEPTH]";
    if (typeof current !== "object") return redactString(current, options);
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (current instanceof Error) {
      const safe = {
        name:redactString(current.name || "Error", options),
        code:redactString(current.code || "UNSPECIFIED", options),
        message:redactString(current.message || "Error", options)
      };
      if (!production && current.stack) safe.stack = redactString(current.stack, { ...options, maxStringLength:4_000 });
      seen.delete(current);
      return safe;
    }

    if (Array.isArray(current)) {
      const items = current.slice(0, maximumEntries).map((entry) => visit(entry, depth + 1));
      if (current.length > maximumEntries) items.push(`[${current.length - maximumEntries} MORE]`);
      seen.delete(current);
      return items;
    }

    const safe = {};
    const entries = Object.entries(current).slice(0, maximumEntries);
    for (const [entryKey, entryValue] of entries) safe[entryKey] = visit(entryValue, depth + 1, entryKey);
    if (Object.keys(current).length > maximumEntries) safe.__truncated_entries = Object.keys(current).length - maximumEntries;
    seen.delete(current);
    return safe;
  };

  return visit(value, 0);
}

export const REDACTED_VALUE = REDACTED;
