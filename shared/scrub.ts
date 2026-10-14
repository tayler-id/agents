// Replaces secret values with [secret:<name>] before anything reaches the record.
// The daemon scrubs with its own environment's secrets plus the patterns. The API
// scrubs again with the patterns, since it never sees an instance's environment.

const PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['xai', /xai-[A-Za-z0-9]{32,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['tailscale', /\btskey-[a-z]+-[A-Za-z0-9-]{16,}/g],
  ['machine-token', /\bmachine_[A-Za-z0-9_-]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
]

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|DATABASE_URL/i
// Shorter values would match ordinary words.
export const MIN_SECRET_LENGTH = 8

export type Scrub = <T>(value: T) => T

// Secret values from an environment, longest first so a value that contains
// another is replaced whole.
export function envSecrets(env: NodeJS.ProcessEnv): [string, string][] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] =>
      SECRET_NAME.test(entry[0]) && (entry[1]?.length ?? 0) >= MIN_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)
}

export function makeScrub(secrets: [string, string][] = []): Scrub {
  const scrubText = (raw: string) => {
    // Postgres can't hold a NUL, and refuses JSON with a lone surrogate, so either
    // would fail the whole post. NULs go, and a lone surrogate becomes U+FFFD.
    let text = raw.replaceAll('\u0000', '').toWellFormed()
    for (const [name, value] of secrets) {
      if (text.includes(value)) text = text.replaceAll(value, `[secret:${name}]`)
    }
    for (const [name, pattern] of PATTERNS) text = text.replace(pattern, `[secret:${name}]`)
    return text
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubText(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrubText(k), walk(v)]))
    }
    return value
  }
  return <T>(value: T) => walk(value) as T
}
