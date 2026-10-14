// Which of the box's secrets the pages open in its browser show, read over the
// browser's DevTools port. A saved screenshot is never scrubbed, so the
// `computer` server saves none while a page shows one. Only text is read, so a
// secret drawn in an image, on a canvas or outside the browser's pages is not
// seen. The design is docs/design/computers.md.

import WebSocket from 'ws'
import { z } from 'zod'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'

// How long the browser may take to list its pages, and each page to give its
// text. A page that doesn't answer, such as one held by an alert, fails the
// read, since what it shows is unknown.
const READ_WAIT_MS = 5_000

// Each tab is a page. A frame from another site, which the browser runs in a
// process of its own, is an iframe. Workers and the browser's own targets show nothing.
const SHOWN_TYPES = new Set(['page', 'iframe'])
const Target = z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() })

// Runs in the page. Its address, title, rendered text and form fields, and the
// same for each frame from its own origin, since another origin's frame has no
// document here.
const PAGE_TEXT = `(() => {
  const texts = []
  const read = (doc) => {
    texts.push(doc.location.href, doc.title, doc.documentElement?.innerText ?? doc.documentElement?.textContent ?? '')
    for (const field of doc.querySelectorAll('input, textarea')) texts.push(field.value)
    for (const frame of doc.querySelectorAll('iframe, frame')) if (frame.contentDocument) read(frame.contentDocument)
  }
  read(document)
  return texts.join('\\n')
})()`

// Each connection sends one command, with id 1. Events carry no id.
const Reply = z.object({ id: z.literal(1) })
const Answer = z.union([
  z.object({ id: z.literal(1), result: z.object({ result: z.object({ type: z.literal('string'), value: z.string() }) }) }),
  z.object({ id: z.literal(1), result: z.object({ exceptionDetails: z.object({ text: z.string() }) }) }),
  z.object({ id: z.literal(1), error: z.object({ message: z.string() }) }),
])

function pageText(debuggerUrl: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const ws = new WebSocket(debuggerUrl)
  const timer = setTimeout(() => { reject(new Error(`a page in the browser gave no text within ${READ_WAIT_MS} ms`)) }, READ_WAIT_MS)
  ws.on('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: PAGE_TEXT, returnByValue: true } }))
  })
  ws.on('message', (data) => {
    const text = bytesOf(data).toString('utf8')
    if (!parseJson(Reply, text).ok) return
    const answer = parseJson(Answer, text)
    if (!answer.ok) reject(new Error(`a page in the browser answered something unexpected: ${answer.reason}`))
    else if ('error' in answer.value) reject(new Error(`a page in the browser gave no text: ${answer.value.error.message}`))
    else if ('exceptionDetails' in answer.value.result) reject(new Error(`reading a page in the browser failed: ${answer.value.result.exceptionDetails.text}`))
    else resolve(answer.value.result.result.value)
  })
  ws.on('error', reject)
  ws.on('close', () => { reject(new Error('a page in the browser closed its connection before giving its text')) })
  return promise.finally(() => {
    clearTimeout(timer)
    ws.terminate()
  })
}

// The names of the secrets that any page open in the browser shows now.
export async function secretsShown(cdpUrl: string, secrets: [name: string, value: string][]): Promise<string[]> {
  if (secrets.length === 0) return []
  const listed = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(READ_WAIT_MS) })
  if (!listed.ok) throw new Error(`the browser answered ${listed.status} for its list of pages`)
  // Every address is checked before any connection opens, so a failure here
  // leaves no read running that nobody waits for.
  const addresses = z.array(Target).parse(await listed.json()).filter((target) => SHOWN_TYPES.has(target.type)).map((target) => {
    if (target.webSocketDebuggerUrl === undefined) throw new Error(`the browser offers no connection to one of its ${target.type}s`)
    return target.webSocketDebuggerUrl
  })
  const texts = await Promise.all(addresses.map(pageText))
  return [...new Set(secrets.filter(([, value]) => texts.some((text) => text.includes(value))).map(([name]) => name))]
}
