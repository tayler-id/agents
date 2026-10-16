// The whiteboard on every seat's dock: Excalidraw, served by the daemon from the
// box itself, on its loopback, so it opens with no network and no account. The
// image puts Excalidraw's browser build, its fonts and React in one folder,
// AGENTS_WHITEBOARD (box/Dockerfile). A drawing stays in the browser that drew
// it, in the page's local storage, so each seat keeps its own.

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'

// The whiteboard's port on the box's loopback. Nothing else in a box uses it.
export const WHITEBOARD_PORT = 8400
export const WHITEBOARD_URL = `http://127.0.0.1:${WHITEBOARD_PORT}/`
// Where the page keeps the drawing in local storage.
export const DRAWING_KEY = 'whiteboard'

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
// The names the folder's files have: Excalidraw's chunks, fonts and locales.
// Anything else, such as an encoded name or a step up with "..", is not served.
const FILE_NAME = /^\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
const LONGEST_NAME = 200

// The page. Excalidraw finds its fonts under EXCALIDRAW_ASSET_PATH, and keeps
// what is drawn in local storage, so a reload or a new window shows it again.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Whiteboard</title>
<style>html,body,#board{margin:0;height:100%}</style>
<script>window.EXCALIDRAW_ASSET_PATH = '/'</script>
<script src="/react.production.min.js"></script>
<script src="/react-dom.production.min.js"></script>
<script src="/excalidraw.production.min.js"></script>
</head><body><div id="board"></div><script>
const KEY = '${DRAWING_KEY}'
const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
const board = React.createElement(ExcalidrawLib.Excalidraw, {
  initialData: saved ? { elements: saved.elements, appState: { viewBackgroundColor: saved.background } } : null,
  onChange: (elements, appState) => {
    localStorage.setItem(KEY, JSON.stringify({ elements: elements.filter((element) => !element.isDeleted), background: appState.viewBackgroundColor }))
  },
})
ReactDOM.createRoot(document.getElementById('board')).render(board)
</script></body></html>
`

export type Whiteboard = { stop(): Promise<void> }

// Serves the page and the files in `dir`, and nothing outside it.
export function serveWhiteboard(dir: string): Promise<Whiteboard> {
  const root = resolve(dir)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE)
      return
    }
    const file = join(root, path)
    const type = TYPES[extname(file)]
    if (path.length > LONGEST_NAME || !FILE_NAME.test(path) || type === undefined || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': type })
    // A file gone since the check above ends the answer early.
    createReadStream(file).on('error', () => { res.destroy() }).pipe(res)
  })
  return new Promise((done, failed) => {
    server.once('error', failed)
    server.listen(WHITEBOARD_PORT, '127.0.0.1', () => {
      done({
        stop: () => new Promise((closed) => {
          server.close(() => { closed() })
          // The browser keeps its connections open, and close waits for them.
          server.closeAllConnections()
        }),
      })
    })
  })
}
