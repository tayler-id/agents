// The page's one way to this Mac's daemon, for the Terminal folders page: list
// the folders Claude Code ran in on this Mac, and connect, change or disconnect
// one. main.cjs passes each ask to the daemon's socket, and only from the
// server's own page. The page's code comes from the server, so each change
// answers one click or key press of the person's on the page, made in the 5
// seconds before it. The press is spent on that change, and the next change
// needs another. The list needs none: the page reads it every 10 seconds to show
// the folders Claude Code just ran in, and any press on the page, such as the
// one that opens Terminal folders, would let the page's code read it anyway.

const { contextBridge, ipcRenderer } = require('electron')

// Whether the person pressed on the page since the last change. Only events the
// browser made from their input are trusted, which page code can't fake, and
// these listeners run before any of the page's, since this script runs first.
let pressed = false
const press = (event) => { if (event.isTrusted && !event.repeat) pressed = true }
globalThis.addEventListener('pointerdown', press, true)
globalThis.addEventListener('keydown', press, true)

const unasked = () => Promise.resolve({ status: 403, body: { error: 'A folder is connected or disconnected only when you choose it on the page.' } })
const change = (ask, body) => {
  if (!pressed || !navigator.userActivation.isActive) return unasked()
  pressed = false
  return ipcRenderer.invoke('agents-mac', ask, body)
}

contextBridge.exposeInMainWorld('agentsMac', {
  list: () => ipcRenderer.invoke('agents-mac', 'list'),
  connect: (path, visibility, confirmed) => change('connect', { path, visibility, confirmed }),
  disconnect: (path) => change('disconnect', { path }),
})
