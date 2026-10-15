// The preview: this checkout's app on Vite's dev server, for working on its screens. A file saved under
// app/src shows in the open page within a second or two, with no build. The dev server stands where the
// people door stands for the built app. It hands /v1 to an instance's people door as one person, since a
// browser on this Mac can't set Tailscale-User-Login the way tailscale serve does on the server, and it
// serves that door only to pages of its own.

import { Console } from 'node:console'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import type { Logger, Plugin, ProxyOptions, ViteDevServer } from 'vite'
import { Refused } from '../shared/cli/output.ts'
import { hasCode } from '../shared/errors.ts'
import { MeView } from '../shared/onboarding.ts'
import { peopleOrigin, ROOT } from './config.ts'
import type { ReadyState } from './state.ts'

// The first port the preview tries, and how many it tries from there. They sit above every port the checks
// use, which end at 8119, and the instances' 8020 to 8039.
const FIRST_PORT = 8200
const PORT_TRIES = 100
// The preview listens on this address alone. A browser reaches it by this name or by localhost, and a page
// from either is the preview's own.
const HOST = '127.0.0.1'
const LOOPBACK_NAMES = [HOST, 'localhost']
// tailscale serve sets each header that starts with this itself, and drops the ones a caller sent.
const IDENTITY_PREFIX = 'tailscale-'
const LOGIN_HEADER = 'tailscale-user-login'
// What goes on to the instance. Everything else is the app, served from its source.
const API_PATHS = '^/v1/'
const NONCE_BYTES = 16
// Vite restarts its server when its config file or an env file changes, and each restart leaves another proxy
// upgrade listener on this server. With two, a refused WebSocket was ended twice, which stopped the server. So the
// preview watches neither, and a change to the config takes effect when the preview is started again.
const APP_CONFIG = join(ROOT, 'app', 'vite.config.ts')
// The page and /v1/me answer in well under a second. One that takes this long has hung.
const ANSWER_MS = 30_000

// The app's page carries a Content-Security-Policy meta tag, and this is how the tag is found and its text taken.
const POLICY_TAG = /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/i
const POLICY_TEXT = /(\bcontent\s*=\s*")([^"]*)(")/i

// The policy with what the dev server needs added to it. The built app's page needs none of this. The dev
// server starts React's refresh with an inline script and carries CSS changes in inline styles. Vite puts the
// nonce on each script and style it makes, so nothing else inline is allowed. Its update WebSocket goes to
// the page's own address, which 'self' already covers.
function relaxed(policy: string, nonce: string): string {
  const directives = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name, sources)
  }
  const fallback = directives.get('default-src') ?? []
  const add = (name: string, ...more: string[]) => { directives.set(name, [...(directives.get(name) ?? fallback), ...more]) }
  add('script-src', `'nonce-${nonce}'`)
  add('style-src', `'nonce-${nonce}'`)
  return [...directives].map(([name, sources]) => [name, ...sources].join(' ')).join('; ')
}

function policyPlugin(nonce: string): Plugin {
  return {
    name: 'agentsctl-preview-policy',
    transformIndexHtml(html) {
      const tag = POLICY_TAG.exec(html)?.[0]
      if (tag === undefined) return html
      if (!POLICY_TEXT.test(tag)) throw new Error('the Content-Security-Policy tag in app/index.html has no content="..." for the preview to add to')
      return html.replace(tag, tag.replace(POLICY_TEXT, (_whole, open: string, policy: string, close: string) => `${open}${relaxed(policy, nonce)}${close}`))
    },
  }
}

// Whether a request, or a WebSocket upgrade, may go on to the instance. Everything that passes is signed in
// as the person the preview was started for, so a page of any other origin is refused. It could otherwise act
// as that person from a tab open on this Mac. The origin is also what the API checks for a screen's
// WebSocket, which is why the proxy replaces it with one the API accepts. Like tailscale serve, this drops
// any identity header the caller sent, so the caller can't name someone else.
function admit(req: IncomingMessage, upgrade: boolean, own: ReadonlySet<string>, logger: Logger): boolean {
  for (const name of Object.keys(req.headers)) if (name.startsWith(IDENTITY_PREFIX)) delete req.headers[name]
  const origin = req.headers.origin
  // A WebSocket always sends the origin of its page. A request from a page of the preview's own may not.
  const admitted = origin === undefined ? !upgrade : own.has(origin)
  if (!admitted) logger.warn(`refused ${upgrade ? 'a WebSocket' : (req.method ?? 'a request')} to ${req.url ?? '/'} from ${origin ?? 'a caller with no origin'}`)
  return admitted
}

function toInstance(state: ReadyState, login: string, own: ReadonlySet<string>, logger: Logger): ProxyOptions {
  return {
    target: `http://127.0.0.1:${String(state.ports.people)}`,
    ws: true,
    headers: { [LOGIN_HEADER]: login },
    bypass: (req, res) => (admit(req, res === undefined, own, logger) ? undefined : false),
    // The API lets only the origins it started with open a screen's WebSocket, and the preview's is not one.
    configure: (proxy) => {
      proxy.on('proxyReqWs', (proxyReq) => { proxyReq.setHeader('origin', peopleOrigin(state.ports.people)) })
    },
  }
}

// Vite's messages go to a file in the instance's evidence folder. The terminal is for the command's own results.
const fileSink = (file: string) => new Writable({
  write(chunk: Buffer, _encoding, done) {
    appendFileSync(file, stripVTControlCharacters(chunk.toString('utf8')))
    done()
  },
})

// Listens on the first free port from FIRST_PORT, and says which.
async function listen(server: Server): Promise<number> {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES; port++) {
    const taken = await new Promise<boolean>((resolve, reject) => {
      const failed = (error: Error) => { if (hasCode(error, 'EADDRINUSE')) resolve(true); else reject(error) }
      server.once('error', failed)
      server.listen(port, HOST, () => {
        server.off('error', failed)
        resolve(false)
      })
    })
    if (!taken) return port
  }
  throw new Refused(`no port from ${String(FIRST_PORT)} to ${String(FIRST_PORT + PORT_TRIES - 1)} is free for the preview`, ['Stop the programs holding them, then run the preview again'])
}

export type Preview = {
  // The one address to open.
  url: string
  // Who the page is signed in as, read back through the preview.
  me: MeView
  // Where Vite's messages go.
  log: string
  stop: () => Promise<void>
}

// Serves the app on 127.0.0.1 only, signed in to the instance as `login`. It answers a request before it returns.
export async function startPreview({ state, login }: { state: ReadyState; login: string }): Promise<Preview> {
  const { createLogger, createServer } = await import('vite')
  const log = join(state.evidence, 'preview.log')
  const logger = createLogger('info', { allowClearScreen: false, console: new Console({ stdout: fileSink(log) }) })
  const http = createHttpServer()
  const sockets = new Set<Socket>()
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    // A page that goes away mid-way resets its connection, which must not stop the server.
    socket.on('error', (error) => { logger.warn(`a connection to the preview failed: ${error.message}`) })
  })
  let vite: ViteDevServer | null = null
  let stopping: Promise<void> | null = null
  // A WebSocket and a long read are open for as long as their page, so they are ended, not waited for.
  const stop = () => (stopping ??= (async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([vite?.close(), new Promise<void>((resolve) => { http.close(() => { resolve() }) })])
  })())
  try {
    const port = await listen(http)
    http.on('error', (error) => { logger.error(`the preview's server failed: ${error.message}`) })
    const own = new Set(LOOPBACK_NAMES.map((name) => `http://${name}:${String(port)}`))
    const nonce = randomBytes(NONCE_BYTES).toString('base64')
    vite = await createServer({
      configFile: APP_CONFIG,
      envDir: false,
      customLogger: logger,
      clearScreen: false,
      html: { cspNonce: nonce },
      plugins: [policyPlugin(nonce)],
      server: {
        // Vite serves through the server made above, and leaves signals and the end of stdin to this command.
        middlewareMode: { server: http },
        ws: { server: http },
        host: HOST,
        port,
        // A page of another origin gets no CORS answer, so a browser won't let it read the API through here.
        cors: false,
        proxy: { [API_PATHS]: toInstance(state, login, own, logger) },
        watch: { ignored: [APP_CONFIG] },
      },
    })
    http.on('request', vite.middlewares)
    const url = `http://${HOST}:${String(port)}/`
    const page = await fetch(url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(ANSWER_MS) })
    if (page.status !== 200) throw new Error(`GET / through the preview answered ${String(page.status)}. Its log, ${log}, says why`)
    const reply = await fetch(`${url}v1/me`, { signal: AbortSignal.timeout(ANSWER_MS) })
    if (reply.status !== 200) throw new Error(`GET /v1/me through the preview answered ${String(reply.status)}. The instance's people door, 127.0.0.1:${String(state.ports.people)}, did not take ${login}`)
    return { url, me: MeView.parse(await reply.json()), log, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

// Who a preview is signed in as, in words.
export function signedInAs(me: MeView): string {
  switch (me.kind) {
    case 'member': return `${me.person.login}, ${me.person.role} of ${me.team.name}`
    case 'invited': return `${me.login}, who is on no team and has an invite`
    case 'waiting': return `${me.login}, who is on no team, so the app asks to join`
  }
}
