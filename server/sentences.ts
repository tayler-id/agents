// What an agent's reply becomes before it is spoken: the words without the markdown, cut
// into sentences as the reply grows. Pure, so a reply that is still being written can be
// read again and again, and the sentences already spoken stay where they were.

const FENCE = '```'

// The words of markdown text, as a person would read them aloud. Code is not read: a fenced block
// is dropped, whole or still open at the end of the text, and inline code keeps its words.
export function speakable(markdown: string): string {
  let text = markdown
  for (;;) {
    const open = text.indexOf(FENCE)
    if (open === -1) break
    const close = text.indexOf(FENCE, open + FENCE.length)
    if (close === -1) {
      text = text.slice(0, open)
      break
    }
    text = text.slice(0, open) + text.slice(close + FENCE.length)
  }
  const lines = text.split('\n').map((line) => line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_(?=\S))/g, '')
    .trim())
  // A line that ends a thought without punctuation, such as a heading or a list item, ends a sentence when the next line starts.
  const finished = lines.map((line, i) => (line && i < lines.length - 1 && !/[.!?:]["'”’)\]]*$/.test(line) ? `${line}.` : line))
  return finished.filter(Boolean).join(' ')
}

// The sentences of `text` that are complete from offset `from`, and the offset after them. A sentence
// is complete when its end is followed by a space, since "3.5" and "e.g." are not ends. With `final` set the text will
// not grow, so what is left is a sentence too.
export function sentencesFrom(text: string, from: number, final: boolean): { sentences: string[]; next: number } {
  const sentences: string[] = []
  const end = /\S[\s\S]*?[.!?]+["'”’)\]]*(?=\s)/g
  end.lastIndex = from
  let next = from
  for (let match = end.exec(text); match; match = end.exec(text)) {
    sentences.push(match[0].trim())
    next = end.lastIndex
  }
  if (final) {
    const rest = text.slice(next).trim()
    if (rest) sentences.push(rest)
    next = text.length
  }
  return { sentences, next }
}
