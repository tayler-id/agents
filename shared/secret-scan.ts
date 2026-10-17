// Whether a file's bytes hold a secret, whatever kind of file it is. The text
// scrubber looks at strings. A file may be binary or UTF-16, so this looks at
// the bytes, and at the text they make in the encodings a secret can hide in.

import { z } from 'zod'
import { PATTERNS } from './scrub.ts'

// What the daemon's guard answers a scan with.
export const ScanAnswer = z.object({ names: z.array(z.string()) })

// The names of the secrets whose values are in the bytes, and of the patterns they match.
export function secretsIn(bytes: Buffer, secrets: readonly (readonly [name: string, value: string])[]): string[] {
  const found = new Set<string>()
  for (const [name, value] of secrets) {
    if (bytes.includes(value) || bytes.includes(Buffer.from(value, 'utf16le'))) found.add(name)
  }
  // Latin-1 reads every byte as a character, so an ASCII token is found in UTF-8, binary and Latin-1 text.
  // UTF-16 text is read from either alignment.
  const views = [bytes.toString('latin1'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')]
  for (const [name, pattern] of PATTERNS) {
    if (views.some((view) => view.search(pattern) !== -1)) found.add(name)
  }
  return [...found]
}
