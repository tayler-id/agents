// The desktop app: a window onto the team's server. It reaches the server over
// Tailscale, and Tailscale tells the server who you are. The server's own page
// also reaches this Mac's daemon, through preload.cjs and the daemon's socket,
// to list and connect the folders whose terminal sessions land in the record.
// Config, in ~/.agents-app/app.json or the environment:
//   server  AGENTS_SERVER  the server's tailnet address, e.g. http://agents-server.example.ts.net
//   proxy   AGENTS_PROXY   only on a Mac that runs Tailscale in userspace mode: http://127.0.0.1:1055
// The daemon's socket is in the daemon's home, AGENTS_HOME or ~/.agents-app.

const { app, BrowserWindow, session, shell } = require('electron')
const { readFileSync } = require('node:fs')
const { request } = require('node:http')
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

// daemon/app-socket.ts makes it, in a folder only this macOS user can open.
const DAEMON_SOCKET = join(process.env.AGENTS_HOME ?? join(homedir(), '.agents-app'), 'run', 'app.sock')
// What the page may ask the daemon, and nothing else.
const ASKS = new Map([
  ['list', { method: 'GET', path: '/folders' }],
  ['connect', { method: 'POST', path: '/folders/connect' }],
  ['disconnect', { method: 'POST', path: '/folders/disconnect' }],
])
// A connect waits for the team's server, which a slow tailnet can take a while to reach.
const DAEMON_TIMEOUT_MS = 30_000

// One ask of the daemon over its socket. The answer is the daemon's status and
// body, or 503 with the reason when the daemon can't be reached.
function askDaemon(route, body) {
  return new Promise((resolve) => {
    const unreachable = (why) => resolve({ status: 503, body: { error: `Agents can't reach this Mac's daemon at ${DAEMON_SOCKET}: ${why}.` } })
    const req = request({ socketPath: DAEMON_SOCKET, method: route.method, path: route.path, headers: { 'content-type': 'application/json' }, timeout: DAEMON_TIMEOUT_MS }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', (error) => unreachable(error.message))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          resolve({ status: 502, body: { error: `This Mac's daemon answered with something that is not JSON: ${error.message}` } })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`it gave no answer within ${DAEMON_TIMEOUT_MS / 1000} seconds`)))
    req.on('error', (error) => unreachable(error.code ?? error.message))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
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
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, 'preload.cjs') },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Only the server's own page reaches the daemon. A page the window was sent to on another site gets a refusal.
  const origin = new URL(server).origin
  window.webContents.ipc.handle('agents-mac', (event, ask, body) => {
    if (event.senderFrame?.origin !== origin) return { status: 403, body: { error: `Only the Agents page at ${origin} may reach this Mac's daemon.` } }
    const route = ASKS.get(ask)
    if (!route) return { status: 400, body: { error: `This Mac's daemon has nothing called ${String(ask)}.` } }
    return askDaemon(route, body)
  })
  await window.loadURL(server)
})

app.on('window-all-closed', () => app.quit())
