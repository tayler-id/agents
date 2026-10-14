// The parts of the VNC protocol (RFB 3.8, RFC 6143, plus the TigerVNC and QEMU
// extensions noVNC uses) that the box's own client and the API's input filter
// both speak.

export const RFB_VERSION = 'RFB 003.008\n'
// The box's Xvnc offers no password. It listens only on a Unix socket inside
// the box, and every viewer reaches it through the API, which checks who they are.
export const SECURITY_NONE = 1
export const SECURITY_RESULT_OK = 0

export const ClientMessage = {
  setPixelFormat: 0,
  setEncodings: 2,
  framebufferUpdateRequest: 3,
  keyEvent: 4,
  pointerEvent: 5,
  clientCutText: 6,
  enableContinuousUpdates: 150,
  fence: 248,
  xvp: 250,
  setDesktopSize: 251,
  qemu: 255,
} as const

export const ServerMessage = {
  framebufferUpdate: 0,
  setColourMapEntries: 1,
  bell: 2,
  serverCutText: 3,
} as const

export const ENCODING_RAW = 0
// The one subtype of the QEMU client message that noVNC sends, a key event that
// carries the key's scan code as well as its keysym.
export const QEMU_EXTENDED_KEY_EVENT = 0
// A pointer event with this bit set in its button mask is the ExtendedMouseButtons
// form, one byte longer. The box's TigerVNC 1.12 never offers it.
export const POINTER_EXTENDED_MARKER = 0x80

export const ClientMessageSize = {
  setPixelFormat: 20,
  setEncodingsHead: 4,
  framebufferUpdateRequest: 10,
  keyEvent: 8,
  pointerEvent: 6,
  clientCutTextHead: 8,
  enableContinuousUpdates: 10,
  fenceHead: 9,
  xvp: 4,
  setDesktopSizeHead: 8,
  setDesktopSizeScreen: 16,
  qemuExtendedKeyEvent: 12,
} as const

// Pointer button bits in a pointer event's mask.
export const Button = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64 } as const

export function keyEvent(keysym: number, down: boolean): Uint8Array {
  const message = new Uint8Array(ClientMessageSize.keyEvent)
  const view = new DataView(message.buffer)
  view.setUint8(0, ClientMessage.keyEvent)
  view.setUint8(1, down ? 1 : 0)
  view.setUint32(4, keysym)
  return message
}

export function pointerEvent(x: number, y: number, buttons: number): Uint8Array {
  const message = new Uint8Array(ClientMessageSize.pointerEvent)
  const view = new DataView(message.buffer)
  view.setUint8(0, ClientMessage.pointerEvent)
  view.setUint8(1, buttons)
  view.setUint16(2, x)
  view.setUint16(4, y)
  return message
}
