// Contact values are intentionally disclosed only by the contact-vault reveal
// endpoint. Every other free-text boundary must collapse recognizable mainland
// mobile formats to a masked representation before persistence, audit or logs.
//
// The candidate is deliberately strict about the 11 mobile digits and numeric
// boundaries, while accepting the separators people commonly type in chat.
const SEPARATOR_CLASS = "\\s\\-‐‑‒–—";
const MAINLAND_MOBILE_CANDIDATE = new RegExp(
  `(?<!\\d)(?:(?:\\+|00)?86[${SEPARATOR_CLASS}]*)?(?:[（(]\\s*)?1[3-9]\\d(?:\\s*[）)])?(?:[${SEPARATOR_CLASS}]*\\d){8}(?!\\d)`,
  "gu"
);
const PRECEDING_NUMERIC_RUN = new RegExp(`\\d[${SEPARATOR_CLASS}]*$`, "u");
const FOLLOWING_NUMERIC_RUN = new RegExp(`^[${SEPARATOR_CLASS}]*\\d`, "u");

const normalizedCandidate = (value) => {
  let digits = String(value || "").replace(/\D/gu, "");
  if (digits.length === 15 && digits.startsWith("0086")) digits = digits.slice(4);
  else if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2);
  return /^1[3-9]\d{9}$/.test(digits) ? digits : "";
};

const maskedMobile = (mobile, replacement) => typeof replacement === "function"
  ? String(replacement(mobile))
  : replacement === undefined
    ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}`
    : String(replacement);

export function redactContactPii(value, options = {}) {
  const input = String(value ?? "");
  return input.replace(MAINLAND_MOBILE_CANDIDATE, (candidate, offset) => {
    const mobile = normalizedCandidate(candidate);
    if (!mobile) return candidate;
    // Do not peel eleven digits out of a longer formatted numeric identifier.
    // Immediate text labels still work; only adjacent digit/separator runs are
    // treated as one ordinary number.
    const before = input.slice(0, offset);
    const after = input.slice(offset + candidate.length);
    if (PRECEDING_NUMERIC_RUN.test(before) || FOLLOWING_NUMERIC_RUN.test(after)) {
      return candidate;
    }
    return maskedMobile(mobile, options.replacement);
  });
}

export function containsContactPii(value) {
  let found = false;
  redactContactPii(value, { replacement:() => { found = true; return ""; } });
  return found;
}

export function redactContactPiiDeep(value, options = {}, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return redactContactPii(value, options);
  if (value === null || value === undefined || ["number", "boolean"].includes(typeof value)) return value;
  if (depth > 16 || typeof value !== "object") return value;
  if (options.preserveEncryptedEnvelopes === true
      && typeof value._encrypted === "string"
      && /^huamei\.(?:field|contact-vault)\.a256gcm\.v\d+$/u.test(value._encrypted)) {
    return value;
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const redacted = Array.isArray(value)
    ? value.slice(0, 500).map((item) => redactContactPiiDeep(item, options, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).slice(0, 500)
      .map(([key, item]) => [key, redactContactPiiDeep(item, options, depth + 1, seen)]));
  seen.delete(value);
  return redacted;
}
