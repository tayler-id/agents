// A secret value given in a command, a plugin's arguments or its address, found by the
// name it is given rather than its format. The scrubber (shared/scrub.ts) finds values
// in the known formats of keys, so a key with no known prefix, such as a hex token,
// passes it. The record keeps hook commands and plugin setups, and a recipe file carries
// them off the team, so the API refuses one that gives a key, a token or a password a
// value in a flag, a header, a query or an address's login.

import { MIN_SECRET_LENGTH } from './scrub.ts'

// One word of a flag, header or query name that says a secret follows: key, api_key,
// client-secret, access_token, authorization and the like. Whole words only, so
// --author or --max-tokens are not taken for one.
const SECRET_WORD = /^(api)?(key|keys|token|secret|password|passwd|pass|pwd|credential|credentials|auth|authorization)$/i
const namesSecret = (name: string) => name.split(/[-_.\s]+/).some((word) => SECRET_WORD.test(word))

// A value worth refusing: no shorter than the scrubber's shortest secret, one word, and not
// a number, a path or a reference to the environment, which the machine fills in.
const isValue = (value: string) =>
  value.length >= MIN_SECRET_LENGTH && !/\s/.test(value) && !/^\d+$/.test(value) && !/^[$~./]/.test(value)

const unquote = (value: string) => value.replace(/^["']|["']$/g, '')

// The words of a command as a shell splits them, near enough: on spaces, with quoted text kept as one word.
export function wordsOf(command: string): string[] {
  return [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

// What in the words gives a secret a value, named without the value, or null.
export function secretIn(words: readonly string[]): string | null {
  for (const [i, word] of words.entries()) {
    const assigned = /^(-{1,2}[A-Za-z0-9_.-]+)=(.*)$/s.exec(word)
    if (assigned?.[1] && namesSecret(assigned[1]) && isValue(unquote(assigned[2] ?? ''))) return `the ${assigned[1]} argument`
    const flag = /^-{1,2}[A-Za-z0-9_.-]+$/.exec(word)
    const next = words[i + 1]
    if (flag && namesSecret(word) && next !== undefined && isValue(unquote(next))) return `the ${word} argument`
    const header = /^([A-Za-z0-9_-]+):\s*(\S.*)$/s.exec(word)
    if (header?.[1] && !/^https?$|^wss?$/i.test(header[1]) && namesSecret(header[1]) && isValue(unquote(header[2]?.trim().split(/\s+/).pop() ?? ''))) {
      return `the ${header[1]} header`
    }
    if (/^(https?|wss?):\/\//i.test(word) && URL.canParse(word)) {
      const url = new URL(word)
      if (url.password !== '') return 'the login in an address'
      for (const [name, value] of url.searchParams) if (namesSecret(name) && isValue(value)) return `the ${name} query`
    }
  }
  return null
}
