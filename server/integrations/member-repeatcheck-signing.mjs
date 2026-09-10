import { createHash } from "node:crypto";

export const MEMBER_REPEATCHECK_SECRET_ENV = "HUAMEI_MEMBER_CHECK_SECRET";

const signatureError = () => Object.assign(new Error("Member query signing is unavailable"), {
  code:"SIGNATURE_UNAVAILABLE"
});
const validField = (value, { empty = false, limit = 4096 } = {}) => typeof value === "string"
  && (empty || value.length > 0) && value.length <= limit && !/[\s&]/u.test(value);

export function memberRepeatCheckSigningConfigured(env = process.env) {
  return validField(env[MEMBER_REPEATCHECK_SECRET_ENV]);
}

// Provider screenshot: UTF-8 MD5, lowercase 32-character hex, exact field order.
// token= stays in the string when empty. secret is never added to HTTP headers.
// This implements the supplied push-signature formula; live query acceptance
// still needs verification with the provider-issued secret.
export function memberRepeatCheckSigner(input = {}, { env = process.env } = {}) {
  const { akey, method, timestamp, token = "", nonce } = input;
  const secret = env[MEMBER_REPEATCHECK_SECRET_ENV];
  if (!memberRepeatCheckSigningConfigured(env)
      || !validField(akey) || !validField(method)
      || !validField(token, { empty:true })
      || typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp)
      || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(nonce)) throw signatureError();
  const material = `akey=${akey}&method=${method}&timestamp=${timestamp}&token=${token}&secret=${secret}&nonce=${nonce}`;
  return createHash("md5").update(material, "utf8").digest("hex");
}
