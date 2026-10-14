// Syntax highlighting for the file viewer. It marks keywords, strings, comments
// and numbers, which the styles show by weight and tone, never by hue, since the
// app spends color only on live state. A family of languages shares one set of
// rules, picked by the file's extension. It reads the whole text at once, so a
// comment or string that runs over several lines stays one token.

export type TokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'plain'
export type Token = { kind: TokenKind; text: string }

const words = (list: string) => new Set(list.split(' '))
const C_LIKE = words('abstract as async await break case catch class const continue debugger default defer delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface let match mod mut new nil null package private protected pub public readonly return select self static struct super switch this throw throws trait true try type typeof undefined use var void where while with yield')
const HASH = words('alias and as assert begin break case class continue def del do done elif else elsif end ensure esac except export fi finally for from function global if import in is lambda local module nil None nonlocal not or pass raise rescue return self then True False unless until when while with yield')
const SQL = words('add all alter and as asc begin by cascade check commit constraint create default delete desc distinct drop else end exists foreign from group having in index inner insert into is join key left like limit not null on or order outer primary references returning right rollback select set table then transaction union unique update using values when where with')

// Each opener's whole token: to the end of the line, or to its closer or the end of the text.
const COMMENTS = {
  '//': '//[^\\n]*', '#': '#[^\\n]*', '--': '--[^\\n]*',
  '/*': '/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))', '<!--': '<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))',
}
const STRINGS = {
  '"': '"(?:\\\\.|[^"\\\\\\n])*"?', "'": "'(?:\\\\.|[^'\\\\\\n])*'?", '`': '`(?:\\\\[\\s\\S]|[^`\\\\])*`?',
  '"""': '"""[\\s\\S]*?(?:"""|(?![\\s\\S]))', "'''": "'''[\\s\\S]*?(?:'''|(?![\\s\\S]))",
}
const NUMBER = '\\b(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b'
const WORD = '[A-Za-z_$][\\w$]*'
const TAG = '</?[A-Za-z][\\w:-]*'

type Rules = { comments: (keyof typeof COMMENTS)[]; strings: (keyof typeof STRINGS)[]; keywords: Set<string>; caseless: boolean; tags: boolean }

const FAMILIES = {
  script: { comments: ['//', '/*'], strings: ['"', "'", '`'], keywords: C_LIKE, caseless: false, tags: false },
  native: { comments: ['//', '/*'], strings: ['"', "'"], keywords: C_LIKE, caseless: false, tags: false },
  style: { comments: ['/*'], strings: ['"', "'"], keywords: words('important media import keyframes supports'), caseless: false, tags: false },
  data: { comments: [], strings: ['"'], keywords: words('true false null'), caseless: false, tags: false },
  hash: { comments: ['#'], strings: ['"""', "'''", '"', "'"], keywords: HASH, caseless: false, tags: false },
  sql: { comments: ['--', '/*'], strings: ["'"], keywords: SQL, caseless: true, tags: false },
  markup: { comments: ['<!--'], strings: ['"', "'"], keywords: new Set<string>(), caseless: false, tags: true },
} satisfies Record<string, Rules>

const BY_EXTENSION: Partial<Record<string, keyof typeof FAMILIES>> = {
  js: 'script', jsx: 'script', mjs: 'script', cjs: 'script', ts: 'script', tsx: 'script', mts: 'script', cts: 'script', go: 'script',
  java: 'native', kt: 'native', kts: 'native', scala: 'native', swift: 'native', rs: 'native', c: 'native', h: 'native', cc: 'native',
  cpp: 'native', hpp: 'native', cs: 'native', dart: 'native', php: 'native',
  css: 'style', scss: 'style', less: 'style',
  json: 'data', jsonc: 'data',
  py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', yaml: 'hash', yml: 'hash', toml: 'hash', ini: 'hash', r: 'hash',
  pl: 'hash', ex: 'hash', exs: 'hash', conf: 'hash', cfg: 'hash', dockerfile: 'hash', makefile: 'hash', gitignore: 'hash', env: 'hash',
  sql: 'sql',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
}

// The rules for a path, by its extension, or its name when it has none.
function rulesFor(path: string): Rules | null {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const family = BY_EXTENSION[name.split('.').pop() ?? name]
  return family ? FAMILIES[family] : null
}

function tokens(text: string, rules: Rules): Token[] {
  const candidates: { kind: TokenKind | 'word'; source: string }[] = [
    { kind: 'comment', source: rules.comments.map((open) => COMMENTS[open]).join('|') },
    { kind: 'string', source: rules.strings.map((quote) => STRINGS[quote]).join('|') },
    { kind: 'keyword', source: rules.tags ? TAG : '' },
    { kind: 'number', source: NUMBER },
    { kind: 'word', source: WORD },
  ]
  const parts = candidates.filter((part) => part.source)
  const pattern = new RegExp(parts.map((part) => `(${part.source})`).join('|'), 'g')
  const out: Token[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const [whole] = match
    if (match.index > last) out.push({ kind: 'plain', text: text.slice(last, match.index) })
    // A group that took no part in the match is undefined, though TypeScript types every group as a string.
    const found = parts[match.slice(1).findIndex((group: string | undefined) => group !== undefined)]
    if (!found) throw new Error(`the highlighter matched ${JSON.stringify(whole)} with no rule`)
    const keyword = rules.keywords.has(rules.caseless ? whole.toLowerCase() : whole)
    out.push({ kind: found.kind === 'word' ? (keyword ? 'keyword' : 'plain') : found.kind, text: whole })
    last = match.index + whole.length
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) })
  return out
}

// The text as lines of tokens. A file this has no rules for is plain text.
export function highlight(path: string, text: string): Token[][] {
  const rules = rulesFor(path)
  const lines: Token[][] = [[]]
  for (const token of rules ? tokens(text, rules) : [{ kind: 'plain' as const, text }]) {
    token.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1]?.push({ kind: token.kind, text: part })
    })
  }
  // A file that ends with a newline has no line after it.
  if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop()
  return lines
}
