// Renders the markdown agents write: headings, paragraphs, lists, quotes, code
// blocks, tables, inline code, bold, italic and links. It builds React elements,
// never raw HTML, and only follows http and https links, so nothing an agent
// writes can run in the page.

import type { ReactNode } from 'react'

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)<]+)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(INLINE)) {
    const token = m[0]
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1]) out.push(<code key={key++}>{token.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key++}>{inline(token.slice(2, -2))}</strong>)
    else if (m[3]) out.push(<em key={key++}>{inline(token.slice(1, -1))}</em>)
    else if (m[4] && m[5]) out.push(<a key={key++} href={m[5]} target="_blank" rel="noreferrer">{token.slice(1, token.indexOf(']'))}</a>)
    else out.push(<a key={key++} href={token} target="_blank" rel="noreferrer">{token}</a>)
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LIST = /^\s*([-*+]|\d+[.)])\s+/

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  const peek = (): string | undefined => lines[i]
  const take = (test: (line: string) => boolean) => {
    const out: string[] = []
    for (let line = peek(); line !== undefined && test(line); line = peek()) {
      out.push(line)
      i++
    }
    return out
  }
  for (let line = peek(); line !== undefined; line = peek()) {
    const key = blocks.length
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      i++
      const code = take((l) => !l.startsWith('```'))
      i++
      blocks.push(<pre key={key} className="md-code"><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      i++
      const [, marks = '#', title = ''] = heading
      // A document's headings sit under the page's own, so they start at h3.
      const Tag = `h${Math.min(marks.length + 2, 6)}` as 'h3'
      blocks.push(<Tag key={key} className="md-heading">{inline(title)}</Tag>)
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      i++
      blocks.push(<hr key={key} />)
      continue
    }
    if (line.startsWith('>')) {
      const quote = take((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, ''))
      blocks.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>)
      continue
    }
    if (line.trimStart().startsWith('|')) {
      blocks.push(<pre key={key} className="md-table">{take((l) => l.trimStart().startsWith('|')).join('\n')}</pre>)
      continue
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line)
      // A list item's continuation lines are indented; each joins the item above it.
      const items: string[] = []
      for (const l of take((l) => LIST.test(l) || (l.startsWith('  ') && l.trim() !== ''))) {
        if (LIST.test(l) || !items.length) items.push(l.replace(LIST, ''))
        else items.push(`${items.pop() ?? ''}\n${l.trim()}`)
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={key}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</List>)
      continue
    }
    const paragraph = take((l) => l.trim() !== '' && !l.startsWith('```') && !/^#{1,6}\s/.test(l) && !LIST.test(l) && !l.startsWith('>'))
    if (!paragraph.length) {
      paragraph.push(line)
      i++
    }
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>)
  }
  return <div className="markdown">{blocks}</div>
}
