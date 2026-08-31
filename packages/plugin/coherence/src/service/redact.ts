/**
 * Credential redaction for ingested transcripts. Applied at the durable ingest
 * boundary so no stored record or mirrored copy can carry a secret; the exact
 * pattern set is a security invariant, not a tunable.
 * @module dsh-coherence/src/service/redact
 */

/** Replace one recognized secret-bearing span. */
const RULES: Array<{ label: RegExp; replacement: (match: string) => string }> = [
  // `sk-...` API keys (OpenAI / DeepSeek style).
  { label: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: () => 'sk-[REDACTED]' },
  // `Bearer <token>`.
  { label: /\bBearer [\w.~+/=-]{16,}\b/g, replacement: match => `${match.split(' ')[0]} [REDACTED]` },
  // Common header values `x-api-key: <secret>`.
  { label: /\b(x-api-key)["']?\s*[:=]\s*["']?[\w.-]{8,}/gi, replacement: match => `${match.split(/[:=]/)[0]}: [REDACTED]` },
  // `key` / `token` / `secret` / `password` assignments.
  {
    label: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?\s*[:=]\s*["']?[\w.~+/=-]{8,}/gi,
    replacement: match => `${match.split(/[:=]/)[0]}= [REDACTED]`,
  },
  // Long base64-ish blobs (jwt / credentials).
  { label: /[A-Za-z0-9+/]{40,}={0,2}/g, replacement: () => '[REDACTED]' },
]

/**
 * Redact one string in place of every recognized secret pattern.
 * @param text - raw text that may contain credentials.
 * @returns the text with secret spans replaced by `[REDACTED]`.
 */
export function redactText(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.label, rule.replacement)
  }
  return out
}

/**
 * Recursively redact every string leaf of an unknown value (messages, meta,
 * tool arguments). Non-string leaves pass through unchanged.
 * @param value - the value to redact.
 * @returns a structurally equal value with secret strings replaced.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValue(child)
    }
    return out
  }
  return value
}
