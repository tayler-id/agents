// The prose lint, for documents, comments and UI strings: no em dash, none of
// the banned words, and headings in sentence case.

import type { Finding } from '../framework.ts'
import { readable } from './source.ts'

export type ProseRules = { banned: readonly string[]; properNouns: readonly string[] }

const EM_DASH = String.fromCharCode(0x2014)
// Words a sentence-case heading keeps lowercase after its first word.
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'over', 'per', 'the', 'to', 'via', 'with'])
// A heading with this many capitalized ordinary words after its first is in title case.
const TITLE_CASE_WORDS = 2

// A banned word and the forms it takes, with its plural, past tense, -ing and -ly endings.
function bannedPattern(words: readonly string[]): RegExp | null {
  if (!words.length) return null
  const forms = words.map((word) => {
    const w = word.toLowerCase()
    const stems = [w, w.endsWith('e') ? w.slice(0, -1) : null, w.endsWith('y') ? `${w.slice(0, -1)}i` : null].filter((s) => s !== null)
    return `(?:${stems.join('|')})(?:s|es|d|ed|ing|ly|ness|ation)?`
  })
  return new RegExp(`\\b(?:${forms.join('|')})\\b`, 'i')
}

// Why a heading reads as title case, or null when it is in sentence case.
export function titleCase(heading: string, properNouns: ReadonlySet<string>): string | null {
  const words = heading.replace(/^#+\s*/, '').replace(/[()[\]"',.!?]/g, ' ').split(/\s+/).filter(Boolean)
  const first = words.findIndex((w) => /[A-Za-z]/.test(w))
  const capitalized: string[] = []
  for (let i = first + 1; i < words.length && first >= 0; i++) {
    const word = words[i] ?? ''
    const afterColon = (words[i - 1] ?? '').endsWith(':')
    const ordinary = /^[A-Z][a-z]+$/.test(word.replace(/:$/, ''))
    if (afterColon || !ordinary || properNouns.has(word.replace(/:$/, ''))) continue
    if (SMALL_WORDS.has(word.toLowerCase())) return `"${word}" is capitalized`
    capitalized.push(word)
  }
  return capitalized.length >= TITLE_CASE_WORDS ? `${capitalized.join(', ')} are capitalized` : null
}

export function proseFindings(path: string, text: string, rules: ProseRules): Finding[] {
  const banned = bannedPattern(rules.banned)
  const nouns = new Set(rules.properNouns)
  const out: Finding[] = []
  for (const segment of readable(path, text)) {
    if (segment.text.includes(EM_DASH)) out.push({ path, line: segment.line, text: 'an em dash' })
    const word = banned?.exec(segment.text)?.[0]
    if (word) out.push({ path, line: segment.line, text: `the banned word "${word}"` })
    const heading = segment.kind === 'heading' ? titleCase(segment.text, nouns) : null
    if (heading) out.push({ path, line: segment.line, text: `a title-case heading: ${heading}` })
  }
  return out
}
