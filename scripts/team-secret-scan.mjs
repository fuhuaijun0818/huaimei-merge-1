import {createHash} from 'node:crypto';
export const fingerprint=value=>createHash('sha256').update(value).digest('hex');
export function candidateSecrets(text) {
  const patterns=[/\bsk-[A-Za-z0-9_-]{24,}/g,/\bAKIA[A-Z0-9]{16}\b/g,/(?:akey|api_key|apiKey|password|secret|token)\s*[:=]\s*["']([A-Za-z0-9_!./+=-]{12,})["']/gi,/^[A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*=([A-Za-z0-9+/_=.-]{14,})$/gm];
  return [...new Set(patterns.flatMap(re=>[...String(text).matchAll(re)].map(m=>m[1]||m[0])))];
}
export function secretFindings(text,allowed=[]) {
  const permitted=new Set(allowed);
  return {private_key:/^-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\s*$/m.test(text),new_credentials:candidateSecrets(text).filter(v=>!permitted.has(fingerprint(v))).length};
}
