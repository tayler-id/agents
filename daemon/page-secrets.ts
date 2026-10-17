// Which of the box's secrets the pages open in its browser show, read over the
// browser's DevTools port. A saved screenshot is never scrubbed, so the
// `computer` server saves none while a page shows one, or while a page can't
// say what it shows. Only text is read, so a secret drawn in an image, on a
// canvas or outside the browser's pages is not seen. The design is
// docs/design/computers.md.

import { z } from 'zod'
import { MIN_SECRET_LENGTH } from '../shared/scrub.ts'
import { devtools, type Speaker } from './devtools.ts'

// How long the browser may take to list its pages, and each page to give its
// text. A page that doesn't answer, such as one held by an alert, fails the
// read, since what it shows is unknown.
const READ_WAIT_MS = 5_000

// Each tab is a page. A frame from another site, which the browser runs in a
// process of its own, is an iframe. Workers and the browser's own targets show nothing.
const SHOWN_TYPES = new Set(['page', 'iframe'])
const Target = z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() })

// A page's DOM as DevTools gives it with `pierce`, which goes into every frame
// the page's process runs, whatever its origin, and into shadow roots, closed
// ones included.
const DOCUMENT_NODE = 9
const DomNode = z.object({
  nodeId: z.int(),
  nodeType: z.int(),
  get children() { return z.array(DomNode).optional() },
  get shadowRoots() { return z.array(DomNode).optional() },
  get contentDocument() { return DomNode.optional() },
})
type DomNode = z.infer<typeof DomNode>

// Every document and shadow root at or under a node. Each holds its own text
// and fields, which a page's script can't reach in a closed shadow root or a
// frame from another origin.
function rootsIn(node: DomNode): number[] {
  return [
    ...(node.nodeType === DOCUMENT_NODE ? [node.nodeId] : []),
    ...(node.shadowRoots ?? []).flatMap((shadow) => [shadow.nodeId, ...rootsIn(shadow)]),
    ...(node.contentDocument ? rootsIn(node.contentDocument) : []),
    ...(node.children ?? []).flatMap(rootsIn),
  ]
}

// Runs on a document or a shadow root. A document gives its address, title and
// rendered text, a shadow root the rendered text of what it holds, and both the
// values of their own fields.
const ROOT_TEXT = `function () {
  const texts = this.nodeType === Node.DOCUMENT_NODE
    ? [this.URL, this.title, this.documentElement ? this.documentElement.innerText ?? this.documentElement.textContent : '']
    : Array.from(this.children, (child) => child.innerText ?? child.textContent)
  for (const field of this.querySelectorAll('input, textarea')) texts.push(field.value)
  return texts
}`

const DocumentReply = z.object({ root: DomNode })
const Resolved = z.object({ object: z.object({ objectId: z.string() }) })
const Called = z.union([
  z.object({ exceptionDetails: z.object({ text: z.string() }) }),
  z.object({ result: z.object({ value: z.array(z.string()) }) }),
])

// Failures name the page, and a page that doesn't answer in time.
const PAGE: Speaker = { what: 'a page in the browser', timedOut: `a page in the browser gave no text within ${READ_WAIT_MS} ms` }

// The address, titles, rendered text and field values of one page or frame,
// with every frame its process runs and every shadow root in it.
async function pageText(debuggerUrl: string): Promise<string[]> {
  const page = await devtools(debuggerUrl, AbortSignal.timeout(READ_WAIT_MS), PAGE)
  try {
    const { root } = DocumentReply.parse(await page.send('DOM.getDocument', { depth: -1, pierce: true }))
    const read = async (nodeId: number): Promise<string[]> => {
      const { object } = Resolved.parse(await page.send('DOM.resolveNode', { nodeId }))
      const called = Called.parse(await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ROOT_TEXT, returnByValue: true }))
      if ('exceptionDetails' in called) throw new Error(`reading a page in the browser failed: ${called.exceptionDetails.text}`)
      return called.result.value
    }
    return (await Promise.all(rootsIn(root).map(read))).flat()
  } finally {
    page.close()
  }
}

// Rendered text collapses each run of whitespace, so a value split over lines,
// such as a key shown in a div, shows with spaces. Both sides collapse the same
// way before they compare.
const collapsed = (text: string) => text.replace(/\s+/g, ' ').trim()

// The names of the secrets that any page open in the browser shows now.
export async function secretsShown(cdpUrl: string, secrets: [name: string, value: string][]): Promise<string[]> {
  // A value that is mostly whitespace would match nearly any page once collapsed.
  const sought = secrets.map(([name, value]) => [name, collapsed(value)] as const).filter(([, value]) => value.length >= MIN_SECRET_LENGTH)
  if (sought.length === 0) return []
  const listed = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(READ_WAIT_MS) })
  if (!listed.ok) throw new Error(`the browser answered ${listed.status} for its list of pages`)
  // Every address is checked before any connection opens, so a failure here
  // leaves no read running that nobody waits for.
  const addresses = z.array(Target).parse(await listed.json()).filter((target) => SHOWN_TYPES.has(target.type)).map((target) => {
    if (target.webSocketDebuggerUrl === undefined) throw new Error(`the browser offers no connection to one of its ${target.type}s`)
    return target.webSocketDebuggerUrl
  })
  const texts = (await Promise.all(addresses.map(pageText))).flat().map(collapsed)
  return [...new Set(sought.filter(([, value]) => texts.some((text) => text.includes(value))).map(([name]) => name))]
}
