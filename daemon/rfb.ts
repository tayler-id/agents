// A small VNC (RFB 3.8) client. The box's screen service uses it to take
// screenshots and send agents' clicks and keys to Xvnc, and checks use it to
// watch a screen through the API. It asks only for raw pixels, which cost
// nothing to decode, since it talks to Xvnc over a Unix socket in the same box.

import type { Duplex } from 'node:stream'
import {
  ClientMessage, ENCODING_RAW, RFB_VERSION, SECURITY_NONE, SECURITY_RESULT_OK, ServerMessage,
} from '../shared/rfb.ts'

export type Rect = { x: number; y: number; width: number; height: number }

// Four bytes per pixel, blue, green, red, then one unused: little-endian 32-bit
// pixels with red in bits 16 to 23, as SetPixelFormat asks below.
const BYTES_PER_PIXEL = 4
const PIXEL_FORMAT = [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]
// Extended clipboard messages mark their length by setting its top bit.
const EXTENDED_LENGTH = 0x80000000

// Bytes from the stream, read in exact amounts. Chunks are joined only when the
// first one can't meet a read, so a screen's worth of pixels arriving in many
// small chunks is copied once.
class Reader {
  private chunks: Buffer[] = []
  private length = 0
  private waiting: { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void } | null = null
  private failure: Error | null = null

  constructor(stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.length += chunk.length
      this.settle()
    })
    stream.on('error', (error: Error) => { this.fail(error) })
    stream.on('close', () => { this.fail(new Error('the screen connection closed')) })
  }

  read(size: number): Promise<Buffer> {
    if (this.waiting) throw new Error('one read at a time')
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve, reject }
      this.settle()
    })
  }

  private settle() {
    const waiting = this.waiting
    if (!waiting || this.length < waiting.size) return
    this.waiting = null
    const first = this.chunks[0]
    const fits = first !== undefined && first.length >= waiting.size
    const head = fits ? first : Buffer.concat(this.chunks, this.length)
    const rest = head.subarray(waiting.size)
    const after = fits ? this.chunks.slice(1) : []
    this.chunks = rest.length ? [rest, ...after] : after
    this.length -= waiting.size
    waiting.resolve(head.subarray(0, waiting.size))
  }

  private fail(error: Error) {
    this.failure ??= error
    const waiting = this.waiting
    this.waiting = null
    waiting?.reject(this.failure)
  }
}

export class RfbClient {
  readonly width: number
  readonly height: number
  readonly name: string
  private readonly stream: Duplex
  private readonly reader: Reader
  private readonly framebuffer: Uint8Array
  // Each FramebufferUpdateRequest gets one FramebufferUpdate, in order.
  private readonly waiting: { resolve: (rects: Rect[]) => void; reject: (error: Error) => void }[] = []
  private failure: Error | null = null

  private constructor(stream: Duplex, reader: Reader, width: number, height: number, name: string) {
    this.stream = stream
    this.reader = reader
    this.width = width
    this.height = height
    this.name = name
    this.framebuffer = new Uint8Array(width * height * BYTES_PER_PIXEL)
  }

  // Shakes hands as a shared client with no password, then asks for raw pixels.
  static async connect(stream: Duplex): Promise<RfbClient> {
    const reader = new Reader(stream)
    const version = (await reader.read(RFB_VERSION.length)).toString('latin1')
    if (!version.startsWith('RFB 003.')) throw new Error(`not a VNC server: it greeted with ${JSON.stringify(version)}`)
    stream.write(RFB_VERSION)
    const count = (await reader.read(1)).readUInt8(0)
    if (count === 0) throw new Error(`the VNC server refused: ${await readReason(reader)}`)
    const types = [...(await reader.read(count))]
    if (!types.includes(SECURITY_NONE)) throw new Error(`the VNC server wants a password (it offers ${types.join(', ')})`)
    stream.write(Buffer.from([SECURITY_NONE]))
    if ((await reader.read(4)).readUInt32BE(0) !== SECURITY_RESULT_OK) throw new Error(`the VNC server refused: ${await readReason(reader)}`)
    stream.write(Buffer.from([1]))
    const init = await reader.read(24)
    const width = init.readUInt16BE(0)
    const height = init.readUInt16BE(2)
    const name = (await reader.read(init.readUInt32BE(20))).toString('utf8')
    const client = new RfbClient(stream, reader, width, height, name)
    client.send(Uint8Array.from([ClientMessage.setPixelFormat, 0, 0, 0, ...PIXEL_FORMAT]))
    const encodings = Buffer.alloc(8)
    encodings.writeUInt8(ClientMessage.setEncodings, 0)
    encodings.writeUInt16BE(1, 2)
    encodings.writeInt32BE(ENCODING_RAW, 4)
    client.send(encodings)
    void client.listen()
    return client
  }

  send(message: Uint8Array) {
    if (this.failure) throw this.failure
    this.stream.write(message)
  }

  // Asks for the screen, or only for what changed since the last update, and
  // resolves with the rectangles the update covered once they are applied.
  refresh(incremental: boolean): Promise<Rect[]> {
    if (this.failure) return Promise.reject(this.failure)
    const request = Buffer.alloc(10)
    request.writeUInt8(ClientMessage.framebufferUpdateRequest, 0)
    request.writeUInt8(incremental ? 1 : 0, 1)
    request.writeUInt16BE(this.width, 6)
    request.writeUInt16BE(this.height, 8)
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject })
      this.send(request)
    })
  }

  // A copy of the screen as last updated.
  frame(): Uint8Array {
    return this.framebuffer.slice()
  }

  pixel(x: number, y: number): { r: number; g: number; b: number } {
    const view = new DataView(this.framebuffer.buffer)
    const at = (y * this.width + x) * BYTES_PER_PIXEL
    return { r: view.getUint8(at + 2), g: view.getUint8(at + 1), b: view.getUint8(at) }
  }

  close() {
    this.stream.destroy()
  }

  get closed(): Error | null {
    return this.failure
  }

  private async listen() {
    try {
      for (;;) {
        const type = (await this.reader.read(1)).readUInt8(0)
        if (type === ServerMessage.framebufferUpdate) {
          const rects = await this.readUpdate()
          this.waiting.shift()?.resolve(rects)
        } else if (type === ServerMessage.bell) {
          // A bell carries nothing more.
        } else if (type === ServerMessage.serverCutText) {
          const head = await this.reader.read(7)
          const length = head.readUInt32BE(3)
          await this.reader.read(length & EXTENDED_LENGTH ? 0x100000000 - length : length)
        } else {
          throw new Error(`the VNC server sent message type ${type}, which this client never asked for`)
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      for (const waiting of this.waiting.splice(0)) waiting.reject(this.failure)
      this.stream.destroy()
    }
  }

  private async readUpdate(): Promise<Rect[]> {
    const count = (await this.reader.read(3)).readUInt16BE(1)
    const rects: Rect[] = []
    for (let i = 0; i < count; i++) {
      const head = await this.reader.read(12)
      const rect = { x: head.readUInt16BE(0), y: head.readUInt16BE(2), width: head.readUInt16BE(4), height: head.readUInt16BE(6) }
      const encoding = head.readInt32BE(8)
      if (encoding !== ENCODING_RAW) throw new Error(`the VNC server sent encoding ${encoding}, and this client asked only for raw pixels`)
      if (rect.x + rect.width > this.width || rect.y + rect.height > this.height) throw new Error('the VNC server sent pixels outside the screen')
      const pixels = await this.reader.read(rect.width * rect.height * BYTES_PER_PIXEL)
      for (let row = 0; row < rect.height; row++) {
        const from = row * rect.width * BYTES_PER_PIXEL
        this.framebuffer.set(pixels.subarray(from, from + rect.width * BYTES_PER_PIXEL), ((rect.y + row) * this.width + rect.x) * BYTES_PER_PIXEL)
      }
      rects.push(rect)
    }
    return rects
  }
}

async function readReason(reader: Reader): Promise<string> {
  const length = (await reader.read(4)).readUInt32BE(0)
  return (await reader.read(length)).toString('utf8')
}
