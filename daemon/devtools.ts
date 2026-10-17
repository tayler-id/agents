// One connection to a browser's DevTools port, for the daemon's own reads and
// changes: the text a page shows (daemon/page-secrets.ts), the logins seats
// share (daemon/logins.ts) and the pages a seat closes for its next agent
// (daemon/seats.ts).

import WebSocket from 'ws'
import { z } from 'zod'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'

// A command's reply. Events carry no id.
const Reply = z.union([
  z.object({ id: z.int(), error: z.object({ message: z.string() }) }),
  z.object({ id: z.int(), result: z.unknown() }),
])

export type Devtools = { send(method: string, params: Record<string, unknown>): Promise<unknown>; close(): void }

// What failures say: what was connected to, such as "a page in the browser",
// and what it means when `signal` fires first.
export type Speaker = { what: string; timedOut: string }

// One DevTools connection, matching each reply to its command by id. When
// `signal` fires the connection closes, which fails every command still
// waiting and every one sent after.
export function devtools(debuggerUrl: string, signal: AbortSignal, speaker: Speaker): Promise<Devtools> {
  const ws = new WebSocket(debuggerUrl)
  const waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  let lastId = 0
  const ended = () => new Error(signal.aborted ? speaker.timedOut : `${speaker.what} closed its DevTools connection`)
  const failAll = (error: Error) => {
    for (const command of waiting.values()) command.reject(error)
    waiting.clear()
  }
  signal.addEventListener('abort', () => { ws.terminate() }, { once: true })
  ws.on('message', (data) => {
    const reply = parseJson(Reply, bytesOf(data).toString('utf8'))
    if (!reply.ok) return
    const command = waiting.get(reply.value.id)
    if (!command) return
    waiting.delete(reply.value.id)
    if ('error' in reply.value) command.reject(new Error(`${speaker.what} refused a DevTools command: ${reply.value.error.message}`))
    else command.resolve(reply.value.result)
  })
  ws.on('close', () => { failAll(ended()) })
  const send = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(ended())
      return
    }
    lastId += 1
    waiting.set(lastId, { resolve, reject })
    ws.send(JSON.stringify({ id: lastId, method, params }))
  })
  return new Promise((resolve, reject) => {
    ws.once('open', () => { resolve({ send, close: () => { ws.terminate() } }) })
    ws.on('error', (error) => {
      reject(signal.aborted ? ended() : error)
      failAll(error)
    })
  })
}

const Version = z.object({ webSocketDebuggerUrl: z.string().min(1) })

// The browser's own DevTools connection, for what belongs to the whole
// browser: its cookies and its pages.
export async function browserDevtools(cdpUrl: string, signal: AbortSignal): Promise<Devtools> {
  const answer = await fetch(`${cdpUrl}/json/version`, { signal })
  if (!answer.ok) throw new Error(`the browser answered ${answer.status} for its DevTools address`)
  const { webSocketDebuggerUrl } = Version.parse(await answer.json())
  return devtools(webSocketDebuggerUrl, signal, { what: 'the browser', timedOut: 'the browser did not answer its DevTools commands in time' })
}

// How long the daemon's own changes to a browser may take.
const CHANGE_WAIT_MS = 5_000
const Created = z.object({ targetId: z.string() })
const Targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })) })

// Closes every page the browser has open and leaves one blank one. A browser
// on a screen quits when its last window closes, so the blank page opens first.
export async function closePages(cdpUrl: string): Promise<void> {
  const browser = await browserDevtools(cdpUrl, AbortSignal.timeout(CHANGE_WAIT_MS))
  try {
    const open = Targets.parse(await browser.send('Target.getTargets', {})).targetInfos.filter((target) => target.type === 'page')
    const { targetId: blank } = Created.parse(await browser.send('Target.createTarget', { url: 'about:blank' }))
    for (const page of open) if (page.targetId !== blank) await browser.send('Target.closeTarget', { targetId: page.targetId })
  } finally {
    browser.close()
  }
}
