// Finding a comment's quote in a rendered document, as DOM ranges the browser
// can highlight without the page being rewritten. Runs of white space match
// loosely, since the rendered text and the quote may break lines differently,
// and blocks such as paragraphs and list items count as separated by a space.

const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,tr,div'

type Piece = { node: Text; start: number }

// The element's visible text, with each text node's place in it. Line numbers
// beside code are hidden from readers, so they are left out here too.
function textOf(root: Element): { text: string; pieces: Piece[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const pieces: Piece[] = []
  let text = ''
  let block: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue
    const own = node.parentElement?.closest(BLOCKS) ?? null
    if (pieces.length && own !== block) text += ' '
    block = own
    pieces.push({ node, start: text.length })
    text += node.data
  }
  return { text, pieces }
}

// The text node and offset at a place in the text. A place in the space between
// two blocks belongs to the start of the next block, or the end of the last one.
function pointAt(pieces: Piece[], at: number, end: boolean): [Text, number] | null {
  for (const piece of pieces) {
    const length = piece.node.data.length
    if (at < piece.start) return [piece.node, 0]
    if (at < piece.start + length || (end && at === piece.start + length)) return [piece.node, at - piece.start]
  }
  const last = pieces.at(-1)
  return last ? [last.node, last.node.data.length] : null
}

const pattern = (quote: string) => new RegExp(quote.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g')

// Every match of the quote in the element, in order.
export function findQuotes(root: Element, quote: string): Range[] {
  if (!quote.trim()) return []
  const { text, pieces } = textOf(root)
  const ranges: Range[] = []
  for (const match of text.matchAll(pattern(quote))) {
    const start = pointAt(pieces, match.index, false)
    const end = pointAt(pieces, match.index + match[0].length, true)
    if (!start || !end) continue
    const range = document.createRange()
    range.setStart(...start)
    range.setEnd(...end)
    ranges.push(range)
  }
  return ranges
}

// Which match of its own text a selection inside the element is, or null when it
// is not one of them.
export function occurrenceOf(root: Element, selection: Range): number | null {
  // The match that starts at or after the selection's start and before its end.
  const at = findQuotes(root, selection.toString()).findIndex((range) =>
    range.compareBoundaryPoints(Range.START_TO_START, selection) >= 0 && range.compareBoundaryPoints(Range.END_TO_START, selection) < 0)
  return at === -1 ? null : at
}
