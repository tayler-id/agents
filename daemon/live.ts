// A session's live token stream. Tokens are scrubbed before they leave the
// machine. A secret can arrive split across chunks, so each block's text is
// scrubbed as a whole and its last stretch is held back until the block ends or
// enough text follows it. An unfinished private key is held back entirely.

import { randomUUID } from 'node:crypto'
import { DurableStream, IdempotentProducer } from '@durable-streams/client'
import type { Scrub } from '../shared/scrub.ts'
import type { LiveDelta } from '../shared/types.ts'

type Block = { raw: string; sent: number; delta: LiveDelta }

export class LiveScrubber {
  private blocks = new Map<string, Block>()
  private scrub: Scrub
  private hold: number

  constructor(scrub: Scrub, hold: number) {
    this.scrub = scrub
    this.hold = hold
  }

  // Takes raw deltas and returns the scrubbed text that is safe to send now.
  push(deltas: LiveDelta[]): LiveDelta[] {
    const out: LiveDelta[] = []
    for (const delta of deltas) {
      const key = `${delta.m}:${delta.b}`
      const block = this.blocks.get(key) ?? { raw: '', sent: 0, delta }
      block.raw += delta.d
      const ready = this.release(block, Boolean(delta.end))
      if (ready) out.push(ready)
      if (delta.end) this.blocks.delete(key)
      else this.blocks.set(key, block)
    }
    return out
  }

  // Everything still held back, for when the session ends.
  flush(): LiveDelta[] {
    const rest = [...this.blocks.values()].map((block) => this.release(block, true)).filter((d) => d !== null)
    this.blocks.clear()
    return rest
  }

  private release(block: Block, ended: boolean): LiveDelta | null {
    const clean = this.scrub(block.raw)
    let safe = ended ? clean.length : clean.length - this.hold
    const key = clean.indexOf('-----BEGIN', block.sent)
    if (!ended && key !== -1 && !clean.includes('-----END', key)) safe = Math.min(safe, key)
    if (safe <= block.sent) return null
    const text = clean.slice(block.sent, safe)
    block.sent = safe
    return { m: block.delta.m, b: block.delta.b, k: block.delta.k, d: text, p: block.delta.p }
  }
}

export class LiveStream {
  private producer: Promise<IdempotentProducer> | null = null
  private scrubber: LiveScrubber
  private url: string
  private headers: Record<string, string>
  private producerId: string

  constructor(options: { url: string; token: string; name: string; scrub: Scrub; hold: number }) {
    this.url = options.url
    this.headers = { authorization: `Bearer ${options.token}` }
    // Each instance is a new producer. The stream server keeps a producer's last
    // sequence number for a week and silently drops anything at or below it, so a
    // restarted process that reused an id would lose its text.
    this.producerId = `${options.name}-${randomUUID()}`
    this.scrubber = new LiveScrubber(options.scrub, options.hold)
  }

  push(deltas: LiveDelta[]) {
    this.append(this.scrubber.push(deltas))
  }

  private append(items: LiveDelta[]) {
    if (!items.length) return
    this.producer ??= this.open()
    void this.producer
      .then((producer) => { for (const item of items) producer.append(JSON.stringify(item)) })
      .catch((error: unknown) => { console.error('live stream:', error instanceof Error ? error.message : String(error)) })
  }

  private async open(): Promise<IdempotentProducer> {
    const stream = await DurableStream.create({ url: this.url, headers: this.headers, contentType: 'application/json' })
      .catch(() => DurableStream.connect({ url: this.url, headers: this.headers }))
    return new IdempotentProducer(stream, this.producerId, {
      autoClaim: true,
      lingerMs: 25,
      onError: (error) => console.error('live stream:', error.message),
    })
  }

  // Sends whatever was held back, then waits for everything to land.
  async close() {
    this.append(this.scrubber.flush())
    if (this.producer) await (await this.producer).flush().catch(() => {})
  }
}
