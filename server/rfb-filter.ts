// What a person's Screen view sends toward a box, read message by message. Keys
// and clicks pass only while that person holds the screen. Clipboard pastes,
// desktop resizes and power requests never pass, from anyone, so nothing enters
// a box from a viewer except typed and clicked input. The handshake is forced to
// share the screen, so no viewer can push the others off. Anything this filter
// can't read ends the connection, since a message it can't measure would leave
// it unable to find where the next one starts.

import {
  ClientMessage, ClientMessageSize, POINTER_EXTENDED_MARKER, QEMU_EXTENDED_KEY_EVENT, RFB_VERSION, SECURITY_NONE,
  keyEvent, pointerEvent,
} from '../shared/rfb.ts'

// The spec caps a fence's payload at 64 bytes.
const MAX_FENCE_PAYLOAD = 64
// Clipboard text is dropped, but its bytes still have to be read past. This
// bounds how much one viewer can make the API hold.
const MAX_CUT_TEXT = 1024 * 1024
// The top bit of a ClientCutText length marks the extended clipboard format,
// whose length is the negative of the rest.
const EXTENDED_LENGTH = 0x80000000

export class RfbFilterError extends Error {}

type Phase = 'version' | 'security' | 'init' | 'messages'

type QemuKey = { keysym: number; keycode: number }

export class RfbInputFilter {
  private phase: Phase = 'version'
  private pending = Buffer.alloc(0)
  private allowInput: boolean
  // What this viewer holds down, so control can't move away mid-press.
  private readonly keys = new Set<number>()
  private readonly qemuKeys = new Map<number, QemuKey>()
  private pointer = { x: 0, y: 0, buttons: 0 }

  constructor(allowInput: boolean) {
    this.allowInput = allowInput
  }

  // Turns input on or off for this viewer. Turning it off returns the messages
  // that let go of anything they hold, for the caller to send to the box.
  setAllowInput(allowed: boolean): Uint8Array[] {
    const releases: Uint8Array[] = []
    if (this.allowInput && !allowed) {
      for (const keysym of this.keys) releases.push(keyEvent(keysym, false))
      for (const key of this.qemuKeys.values()) releases.push(qemuKeyEvent(key, false))
      if (this.pointer.buttons) releases.push(pointerEvent(this.pointer.x, this.pointer.y, 0))
      this.keys.clear()
      this.qemuKeys.clear()
      this.pointer.buttons = 0
    }
    this.allowInput = allowed
    return releases
  }

  // Takes bytes from the viewer and returns the ones to pass to the box.
  push(bytes: Uint8Array): Uint8Array[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes)
    const out: Uint8Array[] = []
    for (;;) {
      const size = this.nextSize()
      if (size === null || this.pending.length < size) return out
      const message = this.pending.subarray(0, size)
      this.pending = this.pending.subarray(size)
      const passed = this.take(message)
      if (passed) out.push(passed)
    }
  }

  // The size of the next whole message, or null until enough has arrived to tell.
  private nextSize(): number | null {
    const head = this.pending
    switch (this.phase) {
      case 'version': return RFB_VERSION.length
      case 'security': return 1
      case 'init': return 1
      case 'messages': break
    }
    if (head.length < 1) return null
    const type = head.readUInt8(0)
    switch (type) {
      case ClientMessage.setPixelFormat: return ClientMessageSize.setPixelFormat
      case ClientMessage.framebufferUpdateRequest: return ClientMessageSize.framebufferUpdateRequest
      case ClientMessage.keyEvent: return ClientMessageSize.keyEvent
      case ClientMessage.enableContinuousUpdates: return ClientMessageSize.enableContinuousUpdates
      case ClientMessage.xvp: return ClientMessageSize.xvp
      case ClientMessage.pointerEvent:
        if (head.length < 2) return null
        if (head.readUInt8(1) & POINTER_EXTENDED_MARKER) throw new RfbFilterError('an extended pointer event, which the box never offered')
        return ClientMessageSize.pointerEvent
      case ClientMessage.setEncodings:
        if (head.length < ClientMessageSize.setEncodingsHead) return null
        return ClientMessageSize.setEncodingsHead + 4 * head.readUInt16BE(2)
      case ClientMessage.clientCutText: {
        if (head.length < ClientMessageSize.clientCutTextHead) return null
        const raw = head.readUInt32BE(4)
        const length = raw & EXTENDED_LENGTH ? 0x100000000 - raw : raw
        if (length > MAX_CUT_TEXT) throw new RfbFilterError(`clipboard text of ${length} bytes`)
        return ClientMessageSize.clientCutTextHead + length
      }
      case ClientMessage.fence: {
        if (head.length < ClientMessageSize.fenceHead) return null
        const length = head.readUInt8(8)
        if (length > MAX_FENCE_PAYLOAD) throw new RfbFilterError(`a fence with ${length} bytes of payload`)
        return ClientMessageSize.fenceHead + length
      }
      case ClientMessage.setDesktopSize:
        if (head.length < ClientMessageSize.setDesktopSizeHead) return null
        return ClientMessageSize.setDesktopSizeHead + ClientMessageSize.setDesktopSizeScreen * head.readUInt8(6)
      case ClientMessage.qemu:
        if (head.length < 2) return null
        if (head.readUInt8(1) !== QEMU_EXTENDED_KEY_EVENT) throw new RfbFilterError(`QEMU message ${head.readUInt8(1)}`)
        return ClientMessageSize.qemuExtendedKeyEvent
      default:
        throw new RfbFilterError(`message type ${type}`)
    }
  }

  // One whole message: what to pass on, or null to drop it.
  private take(message: Buffer): Uint8Array | null {
    switch (this.phase) {
      case 'version':
        // The box speaks 3.8, and only 3.8's handshake has the steps this filter expects.
        if (message.toString('latin1') !== RFB_VERSION) throw new RfbFilterError('a handshake other than RFB 3.8')
        this.phase = 'security'
        return message
      case 'security':
        if (message.readUInt8(0) !== SECURITY_NONE) throw new RfbFilterError('a security type the box never offered')
        this.phase = 'init'
        return message
      case 'init':
        this.phase = 'messages'
        // Shared, whatever the viewer asked, so it can't disconnect the others.
        return Uint8Array.of(1)
      case 'messages':
        return this.message(message)
    }
  }

  private message(message: Buffer): Uint8Array | null {
    switch (message.readUInt8(0)) {
      case ClientMessage.keyEvent: {
        if (!this.allowInput) return null
        const keysym = message.readUInt32BE(4)
        if (message.readUInt8(1)) this.keys.add(keysym)
        else this.keys.delete(keysym)
        return message
      }
      case ClientMessage.qemu: {
        if (!this.allowInput) return null
        const key = { keysym: message.readUInt32BE(4), keycode: message.readUInt32BE(8) }
        if (message.readUInt16BE(2)) this.qemuKeys.set(key.keycode, key)
        else this.qemuKeys.delete(key.keycode)
        return message
      }
      case ClientMessage.pointerEvent:
        if (!this.allowInput) return null
        this.pointer = { buttons: message.readUInt8(1), x: message.readUInt16BE(2), y: message.readUInt16BE(4) }
        return message
      case ClientMessage.clientCutText:
      case ClientMessage.setDesktopSize:
      case ClientMessage.xvp:
        return null
      default:
        return message
    }
  }
}

function qemuKeyEvent(key: QemuKey, down: boolean): Uint8Array {
  const message = new Uint8Array(ClientMessageSize.qemuExtendedKeyEvent)
  const view = new DataView(message.buffer)
  view.setUint8(0, ClientMessage.qemu)
  view.setUint8(1, QEMU_EXTENDED_KEY_EVENT)
  view.setUint16(2, down ? 1 : 0)
  view.setUint32(4, key.keysym)
  view.setUint32(8, key.keycode)
  return message
}
