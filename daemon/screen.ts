// The box's screen service, inside the daemon. It holds who controls the screen,
// runs agents' actions on it one at a time over its own VNC connection, and
// answers the `computer` MCP servers on a Unix socket. The design is
// docs/design/computers.md.

import { chmodSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ActRequest, AGENT_HOLDS, type ActDone, type ComputerAction, type ScreenControl, type ScreenStatus,
} from '../shared/screen.ts'
import { keyEvent, pointerEvent } from '../shared/rfb.ts'
import { messageOf } from '../shared/errors.ts'
import { parseJson } from '../shared/json.ts'
import type { ClipboardOffer, Desktop } from './desktop.ts'
import { BadAction, plan, type Pointer, type Step } from './actions.ts'
import { RfbClient } from './rfb.ts'
import { encodePng } from './png.ts'

// The pause after an action before its screenshot, for the page to react. The
// studied app settles for 500 ms too.
const SETTLE_MS = 500
// An action request is a little JSON. This stops a bad caller from holding the
// daemon's memory.
const MAX_REQUEST_BYTES = 64 * 1024

export type ScreenService = {
  // Who holds the screen, as the API last said.
  setControl(control: ScreenControl): void
  stop(): Promise<void>
}

class Refused extends Error {
  readonly control: ScreenControl
  constructor(control: ScreenControl) {
    super('a person holds the screen')
    this.control = control
  }
}

export function startScreenService(config: { desktop: Desktop; socketPath: string }): ScreenService {
  const { desktop } = config
  let control: ScreenControl = AGENT_HOLDS
  // Counts changes of control, so a session can tell someone used the screen
  // since its own last action.
  let epoch = 0
  let lastPerson: string | null = null
  let running: AbortController | null = null
  let queue: Promise<unknown> = Promise.resolve()
  // Where the agents' pointer is and what their connection holds down. A
  // person's own pointer moves don't change it: an agent's next action puts the
  // pointer back where the agent left it.
  let pointer: Pointer = { x: Math.floor(desktop.size.width / 2), y: Math.floor(desktop.size.height / 2), buttons: 0 }
  const heldKeys = new Set<number>()
  let rfb: RfbClient | null = null

  const screen = async (): Promise<RfbClient> => {
    if (rfb && !rfb.closed) return rfb
    const client = await RfbClient.connect(connect(desktop.vncSocket))
    const { width, height } = desktop.size
    if (client.width !== width || client.height !== height) {
      client.close()
      throw new Error(`the screen is ${client.width}x${client.height}, not the ${width}x${height} the box was set up with`)
    }
    rfb = client
    return client
  }

  async function execute(client: RfbClient, steps: Step[], signal: AbortSignal) {
    let offer: ClipboardOffer | null = null
    for (const step of steps) {
      if (signal.aborted) throw new Refused(control)
      switch (step.kind) {
        case 'pointer':
          client.send(pointerEvent(step.pointer.x, step.pointer.y, step.pointer.buttons))
          pointer = step.pointer
          break
        case 'key':
          client.send(keyEvent(step.keysym, step.down))
          if (step.down) heldKeys.add(step.keysym)
          else heldKeys.delete(step.keysym)
          break
        case 'wait':
          await sleep(step.ms, undefined, { signal })
          break
        case 'clipboard':
          offer = await desktop.offerClipboard(step.text)
          break
        case 'pasted':
          if (!offer) throw new Error('a paste was planned with nothing on the clipboard')
          // When nothing asked for the text, no field had focus. The screenshot
          // after the action shows the agent so.
          await offer.taken()
          offer = null
          break
      }
    }
  }

  // Lets go of anything the agents' connection holds, so a person who takes over
  // never inherits a pressed button or modifier.
  function release(client: RfbClient) {
    for (const keysym of heldKeys) client.send(keyEvent(keysym, false))
    heldKeys.clear()
    if (pointer.buttons) {
      pointer = { ...pointer, buttons: 0 }
      client.send(pointerEvent(pointer.x, pointer.y, 0))
    }
  }

  async function act(action: ComputerAction): Promise<ActDone> {
    if (control.holder === 'person') throw new Refused(control)
    const client = await screen()
    const steps = plan(action, pointer, desktop.size)
    const abort = new AbortController()
    running = abort
    try {
      await execute(client, steps.steps, abort.signal)
      if (steps.settle) await sleep(SETTLE_MS, undefined, { signal: abort.signal })
    } catch (error) {
      // A person took over mid-action. setControl has already let go of the keys.
      if (abort.signal.aborted) throw new Refused(control)
      throw error
    } finally {
      running = null
    }
    await client.refresh(false)
    const { width, height } = desktop.size
    return {
      shot: { png: encodePng(width, height, client.frame()).toString('base64'), width, height },
      cursor: { x: pointer.x, y: pointer.y }, epoch, lastPerson,
    }
  }

  // Actions from every session on the box run one at a time, in order.
  function enqueue(action: ComputerAction): Promise<ActDone> {
    const before = queue
    const run = (async () => {
      await Promise.allSettled([before])
      return act(action)
    })()
    queue = run
    return run
  }

  function setControl(next: ScreenControl) {
    const unchanged = next.holder === 'agent'
      ? control.holder === 'agent'
      : control.holder === 'person' && control.personId === next.personId
    if (unchanged) return
    epoch += 1
    if (next.holder === 'person') lastPerson = next.login
    control = next
    if (next.holder === 'person') {
      running?.abort()
      if (rfb && !rfb.closed) release(rfb)
    }
  }

  const status = (): ScreenStatus => ({ control, size: desktop.size, epoch, lastPerson })

  // The `computer` MCP servers' side door.
  async function answer(req: IncomingMessage, res: ServerResponse) {
    const reply = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
    try {
      if (req.method === 'GET' && req.url === '/status') return reply(200, status())
      if (req.method !== 'POST' || req.url !== '/act') return reply(404, { error: 'no such route' })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) throw new Error('a request body arrived as something other than bytes')
        size += chunk.length
        if (size > MAX_REQUEST_BYTES) return reply(413, { error: 'request too large' })
        chunks.push(chunk)
      }
      const request = parseJson(ActRequest, Buffer.concat(chunks).toString('utf8'))
      if (!request.ok) return reply(400, { error: request.reason })
      reply(200, await enqueue(request.value.action))
    } catch (error) {
      if (error instanceof Refused) return reply(409, { control: error.control })
      if (error instanceof BadAction) return reply(400, { error: error.message })
      console.error('screen action:', messageOf(error))
      reply(500, { error: messageOf(error) })
    }
  }
  const local = createServer((req, res) => { void answer(req, res) })
  rmSync(config.socketPath, { force: true })
  local.listen(config.socketPath, () => { chmodSync(config.socketPath, 0o600) })

  return {
    setControl,
    async stop() {
      rfb?.close()
      await new Promise<void>((resolve) => { local.close(() => { resolve() }) })
    },
  }
}
