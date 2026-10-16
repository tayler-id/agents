// The page's one way to this Mac's daemon, for the Terminal folders page: list
// the folders Claude Code ran in on this Mac, and connect, change or disconnect
// one. main.cjs passes each ask to the daemon's socket, and only from the
// server's own page. The page's code comes from the server, so a change goes
// through only right after the person clicked or pressed a key on the page.

const { contextBridge, ipcRenderer } = require('electron')

const unasked = () => Promise.resolve({ status: 403, body: { error: 'A folder is connected or disconnected only when you choose it on the page.' } })
const change = (ask, body) => (navigator.userActivation.isActive ? ipcRenderer.invoke('agents-mac', ask, body) : unasked())

contextBridge.exposeInMainWorld('agentsMac', {
  list: () => ipcRenderer.invoke('agents-mac', 'list'),
  connect: (path, visibility, confirmed) => change('connect', { path, visibility, confirmed }),
  disconnect: (path) => change('disconnect', { path }),
})
