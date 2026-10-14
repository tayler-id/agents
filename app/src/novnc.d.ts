// The part of noVNC 1.7.0's RFB client the Screen view uses. noVNC ships no
// types. Its API is docs/API.md in the package.
declare module '@novnc/novnc' {
  // A WebSocket, or anything shaped like one, which noVNC takes in place of a URL.
  export interface RfbChannel {
    binaryType: BinaryType
    readonly protocol: string
    readonly readyState: number
    onopen: ((event: Event) => void) | null
    onmessage: ((event: MessageEvent) => void) | null
    onclose: ((event: CloseEvent) => void) | null
    onerror: ((event: Event) => void) | null
    send(data: ArrayBufferLike | ArrayBufferView): void
    close(): void
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | RfbChannel, options?: { shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    background: string
    disconnect(): void
    focus(options?: FocusOptions): void
    blur(): void
  }
}
