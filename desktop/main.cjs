// The desktop app: a window onto the team's server. It reaches the server over
// Tailscale, and Tailscale tells the server who you are.
// Config, in ~/.agents-app/app.json or the environment:
//   server  AGENTS_SERVER  the server's tailnet address, e.g. http://agents-server.example.ts.net
//   proxy   AGENTS_PROXY   only on a Mac that runs Tailscale in userspace mode: http://127.0.0.1:1055

const { app, BrowserWindow, session, shell } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

function config() {
  let file = {}
  try {
    file = JSON.parse(readFileSync(join(homedir(), '.agents-app', 'app.json'), 'utf8'))
  } catch {
    // No app.json: the environment, or the defaults below, say where the server is.
  }
  return {
    server: process.env.AGENTS_SERVER ?? file.server ?? 'http://127.0.0.1:7700',
    proxy: process.env.AGENTS_PROXY ?? file.proxy ?? null,
    // For checks against a test server on this machine only. A server reached
    // through tailscale serve replaces this header with the real login.
    devLogin: process.env.AGENTS_DEV_LOGIN ?? null,
  }
}

app.setName('Agents')

app.whenReady().then(async () => {
  const { server, proxy, devLogin } = config()
  if (proxy) await session.defaultSession.setProxy({ proxyRules: proxy })
  if (devLogin) {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, done) =>
      done({ requestHeaders: { ...details.requestHeaders, 'tailscale-user-login': devLogin } }))
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Agents',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  await window.loadURL(server)
})

app.on('window-all-closed', () => app.quit())
