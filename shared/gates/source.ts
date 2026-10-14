// Reads the parts of a file that people read: a document's text outside code,
// a program's comments, and its string literals and JSX text. The lints that
// judge prose, warning comments and suppressions all start here.

import ts from 'typescript'

export type Segment = {
  line: number
  text: string
  kind: 'text' | 'heading' | 'comment' | 'string'
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
}
const HASH_COMMENTS = /(^|\/)(Dockerfile|\.gitignore|\.dockerignore)$|\.(sh|yaml|yml)$/

export const extensionOf = (path: string) => /(\.[a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
export const isScript = (path: string) => extensionOf(path) in SCRIPT_KINDS

export function parseScript(path: string, text: string): ts.SourceFile {
  const kind = SCRIPT_KINDS[extensionOf(path)]
  if (kind === undefined) throw new Error(`${path} is not a script`)
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
}

// Splits a span of text into one segment per line, numbered from `line`.
function lines(text: string, line: number, kind: Segment['kind']): Segment[] {
  return text.split('\n').map((part, i) => ({ line: line + i, text: part, kind }))
}

// The line a position is on, counting LF alone, as git does. TypeScript also
// ends a line at a lone CR, U+2028 and U+2029, so its own numbers drift from
// the diff's on a file holding one, and a finding would miss its added line.
const lineStarts = new WeakMap<ts.SourceFile, number[]>()
export function lineOf(file: ts.SourceFile, pos: number): number {
  let starts = lineStarts.get(file)
  if (!starts) {
    const text = file.getFullText()
    starts = [0]
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
    lineStarts.set(file, starts)
  }
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((starts[mid] ?? 0) <= pos) low = mid
    else high = mid - 1
  }
  return low + 1
}

// Every comment in a script, once each. Tokens are visited too, since a
// comment can sit before a closing brace that is no node of its own.
export function scriptComments(file: ts.SourceFile): Segment[] {
  const text = file.getFullText()
  const seen = new Map<number, Segment[]>()
  const visit = (node: ts.Node) => {
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      if (!seen.has(range.pos)) seen.set(range.pos, lines(text.slice(range.pos, range.end), lineOf(file, range.pos), 'comment'))
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)
  return [...seen.entries()].sort(([a], [b]) => a - b).flatMap(([, segments]) => segments)
}

// String literals and JSX text, as written in the source.
function scriptStrings(file: ts.SourceFile): Segment[] {
  const out: Segment[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      out.push(...lines(node.getText(file), lineOf(file, node.getStart(file)), 'string'))
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)
  return out
}

// A document's lines outside code blocks, with inline code and link targets removed.
function markdown(text: string): Segment[] {
  const out: Segment[] = []
  let fence: string | null = null
  text.split('\n').forEach((raw, i) => {
    const marker = /^\s*(```|~~~)/.exec(raw)?.[1]
    if (marker !== undefined) {
      fence = fence === null ? marker : fence === marker ? null : fence
      return
    }
    if (fence !== null) return
    const plain = raw.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '')
    out.push({ line: i + 1, text: plain, kind: /^#{1,6}\s/.test(raw) ? 'heading' : 'text' })
  })
  return out
}

// Block comments, kept on their lines.
function blockComments(text: string): Segment[] {
  const out: Segment[] = []
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const line = text.slice(0, match.index).split('\n').length
    out.push(...lines(match[0], line, 'comment'))
  }
  return out
}

function lineComments(text: string, marker: RegExp): Segment[] {
  return text.split('\n').flatMap((raw, i) => {
    const at = raw.search(marker)
    return at < 0 ? [] : [{ line: i + 1, text: raw.slice(at), kind: 'comment' as const }]
  })
}

export function readable(path: string, text: string): Segment[] {
  const ext = extensionOf(path)
  if (isScript(path)) {
    const file = parseScript(path, text)
    return [...scriptComments(file), ...scriptStrings(file)]
  }
  if (ext === '.md') return markdown(text)
  if (ext === '.css') return blockComments(text)
  if (ext === '.sql') return [...blockComments(text), ...lineComments(text, /--/)]
  if (HASH_COMMENTS.test(path)) return lineComments(text, /(^|\s)#/)
  if (ext === '.html') return text.split('\n').map((raw, i) => ({ line: i + 1, text: raw.replace(/<[^>]*>/g, ' '), kind: 'text' }))
  return []
}
