// One seat's computer: TigerVNC's Xvnc, which is both the X display and the VNC
// server, JWM as the window manager with the seat's dock (daemon/dock.ts), and
// the seat's Chromium. The daemon starts all three for each seat
// (daemon/seats.ts), restarts any that exits, and stops them when the seat or
// the daemon stops. The design is docs/design/computers.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ScreenSize } from '../shared/screen.ts'
import { messageOf } from '../shared/errors.ts'
import { DOCK_BUTTONS, dockConfig, dockIcon, type DockButton } from './dock.ts'

// What the desktop's programs need from the daemon's environment: where programs
// are and the home folder. Never the rest of it, which holds the machine's token
// and the Claude token. The browser can show any file it can read, such as
// file:///proc/self/environ, and screenshots aren't scrubbed.
const DesktopProcessEnv = z.object({ PATH: z.string().min(1), HOME: z.string().min(1) })

export type DesktopConfig = {
  size: ScreenSize
  // The X display's number, which names its lock files too.
  display: number
  // The browser's DevTools port, on the computer's loopback only.
  cdpPort: number
  // Where the daemon keeps the screen's sockets, readable only by this user.
  runDir: string
  // The browser's profile, in the home volume so logins outlive the container.
  profileDir: string
  // Playwright's browsers folder, which holds the one Chromium the box uses.
  browsersPath: string
  // The whiteboard the dock opens (daemon/whiteboard.ts).
  whiteboardUrl: string
}

export type Desktop = {
  size: ScreenSize
  vncSocket: string
  cdpUrl: string
  // Resolves once Xvnc accepts connections and the browser answers on its DevTools port.
  ready: Promise<void>
  // Puts text on the screen's clipboard, as copying it in any app would.
  offerClipboard(text: string): Promise<ClipboardOffer>
  // How many times the browser has started, so a reader can tell a browser
  // that started again, with only what its profile kept.
  browserStarts(): number
  // Closes every window the dock opened outside the browser, such as terminals,
  // by stopping everything the window manager started.
  closeWindows(): Promise<void>
  stop(): Promise<void>
}

// Text on the clipboard. A paste is asynchronous. The app asks the clipboard's
// owner for the text after the key press, so the next paste or key has to wait
// until it has asked, or the app can lose the text.
export type ClipboardOffer = {
  // True once an app has asked for the text and stopped asking, false when none
  // asked within PASTE_WAIT_MS.
  taken(): Promise<boolean>
}

// A process that ran this long was healthy, so its next crash restarts it at once.
const HEALTHY_MS = 60_000
const RESTART_FIRST_MS = 1_000
const RESTART_MAX_MS = 30_000
// How long Xvnc and the browser get to come up before the box reports a problem.
const START_TIMEOUT_MS = 30_000
const POLL_MS = 100
// What a stopping process gets before it is killed.
const STOP_GRACE_MS = 5_000
// Stderr lines kept per process, to say why it exited.
const STDERR_LINES = 20
// xclip holds the clipboard about 4 ms after it starts.
const CLIPBOARD_TIMEOUT_MS = 2_000
// Chromium asks for pasted text within about 10 ms of the key press, in two
// requests 4 ms apart. A second with no request means nothing took the paste,
// and 50 ms with no more means the app has the text.
const PASTE_WAIT_MS = 1_000
const PASTE_QUIET_MS = 50
const PASTE_POLL_MS = 5

// The Chromium in Playwright's browsers folder. The image installs exactly one.
export function findChromium(browsersPath: string): string {
  const builds = readdirSync(browsersPath).filter((name) => /^chromium-[0-9]+$/.test(name))
  if (builds.length !== 1) throw new Error(`expected one Chromium in ${browsersPath}, found ${builds.length ? builds.join(', ') : 'none'}`)
  const build = join(browsersPath, builds.join(''))
  const platform = readdirSync(build).filter((name) => name.startsWith('chrome-linux'))
  const binary = platform.length === 1 ? join(build, platform.join(''), 'chrome') : null
  if (!binary || !existsSync(binary)) throw new Error(`no chrome binary in ${build}`)
  return binary
}

type Supervised = {
  // The running process's id, or null between runs.
  pid(): number | null
  stop(): Promise<void>
}

type Apps = { windowManager: Supervised; browser: Supervised }

type Program = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; beforeStart: () => void }

// Runs a process, and runs it again whenever it exits or can't start, waiting
// longer after each quick failure.
function supervise(name: string, program: Program): Supervised {
  let running: ChildProcess | null = null
  // Set by stop() while the loop below waits, so the loop reads it through a function.
  const state = { stopping: false }
  const stopping = () => state.stopping
  let delay = RESTART_FIRST_MS
  const stderr: string[] = []
  // Resolves with why the process ended.
  const runOnce = async (): Promise<string> => {
    program.beforeStart()
    const child = spawn(program.command, program.args, { env: program.env, cwd: program.cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    running = child
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr.push(...text.split('\n').filter(Boolean))
      stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES))
    })
    return new Promise<string>((resolve) => {
      child.on('exit', (code, signal) => { resolve(signal ?? `code ${String(code)}`) })
      child.on('error', (error) => { resolve(error.message) })
    })
  }
  const done = (async () => {
    while (!stopping()) {
      const started = Date.now()
      // A failure to start is retried like an exit, and logged below with its reason.
      const ended = await runOnce().catch((error: unknown) => `could not start: ${messageOf(error)}`)
      running = null
      if (stopping()) return
      delay = Date.now() - started > HEALTHY_MS ? RESTART_FIRST_MS : Math.min(RESTART_MAX_MS, delay * 2)
      console.error(`desktop: ${name} ended (${ended}), starting it again in ${delay / 1000}s${stderr.length ? `\n  ${stderr.slice(-5).join('\n  ')}` : ''}`)
      stderr.length = 0
      await sleep(delay)
    }
  })()
  return {
    pid: () => running?.pid ?? null,
    async stop() {
      state.stopping = true
      const child = running
      if (!child) return
      child.kill('SIGTERM')
      const killer = setTimeout(() => { child.kill('SIGKILL') }, STOP_GRACE_MS)
      await done
      clearTimeout(killer)
    },
  }
}

// A process's parent and state letter from /proc, or null once it has gone.
function procStat(pid: number): { parent: number; state: string } | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return null
    throw error
  }
  // The command's name is in parentheses and may hold spaces, so fields count from its end.
  const [state = '', parent = ''] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return { parent: Number(parent), state }
}

// Every process descended from `pid`: the programs a window manager started,
// and everything they started.
function descendantsOf(pid: number): number[] {
  const children = new Map<number, number[]>()
  for (const name of readdirSync('/proc').filter((entry) => /^[0-9]+$/.test(entry))) {
    const stat = procStat(Number(name))
    if (stat) children.set(stat.parent, [...(children.get(stat.parent) ?? []), Number(name)])
  }
  const found: number[] = []
  const queue = [pid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

// A process that has exited but not been reaped yet counts as gone.
const alive = (pid: number) => {
  const stat = procStat(pid)
  return stat !== null && stat.state !== 'Z'
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch (error) {
    // It ended since it was found.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

const accepts = (socketPath: string) => new Promise<boolean>((resolve) => {
  const socket = connect(socketPath)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => { resolve(false) })
})

// A fetch to a port nobody listens on yet.
const refused = (error: unknown) =>
  error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ECONNREFUSED'

async function waitFor(what: string, test: () => Promise<boolean>) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`${what} did not come up within ${START_TIMEOUT_MS / 1000}s`)
    await sleep(POLL_MS)
  }
}

export function startDesktop(config: DesktopConfig): Desktop {
  mkdirSync(config.runDir, { recursive: true, mode: 0o700 })
  mkdirSync(config.profileDir, { recursive: true, mode: 0o700 })
  const vncSocket = join(config.runDir, 'vnc.sock')
  const cdpUrl = `http://127.0.0.1:${config.cdpPort}`
  const chromium = findChromium(config.browsersPath)
  const { PATH, HOME } = DesktopProcessEnv.parse(process.env)
  const display = `:${config.display}`
  const env = { PATH, HOME, DISPLAY: display }
  const { width, height } = config.size

  // The dock's configuration and icons, in the seat's own folder.
  const iconOf = (button: DockButton) => join(config.runDir, `${button.toLowerCase()}.svg`)
  for (const button of DOCK_BUTTONS) writeFileSync(iconOf(button), dockIcon(button))
  const jwmrc = join(config.runDir, 'jwmrc')
  writeFileSync(jwmrc, dockConfig({ cdpUrl, whiteboardUrl: config.whiteboardUrl, iconOf }))

  const xvnc = supervise('Xvnc', { command: 'Xvnc', env, cwd: HOME, args: [
    display, '-geometry', `${width}x${height}`, '-depth', '24', '-desktop', 'Agents box',
    // Viewers come only through the daemon's tunnels, over this socket. No TCP at all.
    '-rfbunixpath', vncSocket, '-rfbunixmode', '0600', '-rfbport', '-1', '-nolisten', 'tcp',
    // X clients reach the display only through its socket file in this container's
    // /tmp. Xvnc's abstract socket belongs to the network namespace, so boxes on
    // the host's network, as step 12c runs them, would fight over their displays.
    '-nolisten', 'local',
    // The daemon's own connection and every viewer's share the screen. None is a
    // reason to drop another, and nobody resizes it under the agent's coordinates.
    '-SecurityTypes', 'None', '-AlwaysShared', '-DisconnectClients=0', '-AcceptSetDesktopSize=0',
    // The clipboard stays in the box. Viewers neither read it nor set it.
    '-SendCutText=0', '-AcceptCutText=0',
    // Nothing on this screen uses GLX, and leaving it out keeps Mesa unloaded.
    '-extension', 'GLX',
  ], beforeStart: () => {
    // A container restart leaves the last run's lock and socket behind, and Xvnc
    // refuses to start while they exist. Only this daemon runs X servers here.
    rmSync(`/tmp/.X${config.display}-lock`, { force: true })
    rmSync(`/tmp/.X11-unix/X${config.display}`, { force: true })
    rmSync(vncSocket, { force: true })
    mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 })
  } })
  // A terminal the dock opens starts in the home folder, as the window manager does.
  const startApps = (): Apps => ({
    windowManager: supervise('JWM', { command: 'jwm', args: ['-f', jwmrc], env, cwd: HOME, beforeStart: () => undefined }),
    browser: supervise('Chromium', { command: chromium, env, cwd: HOME, args: [
      // The container is the sandbox. Chromium's own needs user namespaces that
      // Docker doesn't grant, and --test-type hides the warning bar that brings.
      '--no-sandbox', '--test-type',
      // The "for automated testing only" bar would take 56 pixels off every screenshot.
      '--disable-infobars',
      '--no-first-run', '--no-default-browser-check', '--password-store=basic',
      // A box browser does what the agent asks and nothing else: no update checks,
      // field trials or sync.
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      // No GPU in a box. SwiftShader renders, rather than Chromium retrying EGL.
      '--use-angle=swiftshader', '--disable-dev-shm-usage',
      `--remote-debugging-port=${config.cdpPort}`, `--user-data-dir=${config.profileDir}`,
      '--window-position=0,0', `--window-size=${width},${height}`, '--start-maximized', 'about:blank',
    ], beforeStart: () => {
      // A recreated container has a new hostname, and Chromium won't open a profile
      // its old self still seems to hold.
      for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(config.profileDir, lock), { force: true })
      state.browserStarts += 1
    } }),
  })

  const state: { apps: Apps | null; stopped: boolean; clipboard: ChildProcess | null; browserStarts: number } = {
    apps: null, stopped: false, clipboard: null, browserStarts: 0,
  }

  // What the clipboard holds now, as an app pasting would get it. Empty when it
  // holds nothing, which xclip reports by failing.
  const readClipboard = () => new Promise<string>((resolve, reject) => {
    const xclip = spawn('xclip', ['-selection', 'clipboard', '-out'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let held = ''
    xclip.stdout.setEncoding('utf8').on('data', (chunk: string) => { held += chunk })
    xclip.on('error', reject)
    xclip.on('exit', (code) => { resolve(code === 0 ? held : '') })
  })

  // xclip with -verbose stays in the foreground and says each time an app asks
  // it for the text. It exits when something else takes the clipboard, such as
  // the next offer's xclip.
  const offerClipboard = async (text: string): Promise<ClipboardOffer> => {
    const xclip = spawn('xclip', ['-selection', 'clipboard', '-in', '-verbose'], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    state.clipboard = xclip
    const asked: number[] = []
    let partial = ''
    xclip.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = partial + chunk
      const end = lines.lastIndexOf('\n')
      partial = lines.slice(end + 1)
      for (const line of lines.slice(0, Math.max(0, end)).split('\n')) {
        const request = /Waiting for selection request number ([0-9]+)/.exec(line)
        if (request && Number(request[1]) > 1) asked.push(Date.now())
      }
    })
    // Set by xclip's listeners while the loop below waits, so read through a function.
    const problem: { error: Error | null } = { error: null }
    const failure = () => problem.error
    xclip.on('error', (error) => { problem.error = error })
    // xclip exiting before it has read the text closes its input early.
    xclip.stdin.on('error', (error) => { problem.error = error })
    xclip.stdin.end(text)
    // xclip takes the clipboard a moment before the X server has seen it, and a
    // paste in between asks the last owner, which is just letting go, so the text
    // is lost, as 2 of 72 pastes were in a box. Reading the clipboard back until
    // it has the text proves the X server agrees.
    const deadline = Date.now() + CLIPBOARD_TIMEOUT_MS
    while ((await readClipboard()) !== text) {
      const error = failure()
      if (error) throw error
      if (Date.now() > deadline) {
        xclip.kill()
        throw new Error(`the clipboard did not take the text within ${CLIPBOARD_TIMEOUT_MS} ms`)
      }
      await sleep(PASTE_POLL_MS)
    }
    // The reads above asked xclip too. Only requests after them are the paste's.
    const before = asked.length
    return {
      async taken() {
        const until = Date.now() + PASTE_WAIT_MS
        for (;;) {
          const last = asked.length > before ? asked.at(-1) : undefined
          if (last !== undefined && Date.now() - last >= PASTE_QUIET_MS) return true
          if (last === undefined && Date.now() > until) return false
          await sleep(PASTE_POLL_MS)
        }
      },
    }
  }
  const ready = (async () => {
    await waitFor('Xvnc', () => accepts(vncSocket))
    // The window manager and the browser need the display, so they start once it answers.
    if (state.stopped) return
    state.apps = startApps()
    await waitFor('the browser', async () => {
      const answer = await fetch(`${cdpUrl}/json/version`).catch((error: unknown) => {
        if (refused(error)) return null
        throw error
      })
      return answer !== null && answer.ok
    })
  })()
  return {
    size: config.size, vncSocket, cdpUrl, ready, offerClipboard, browserStarts: () => state.browserStarts,
    async closeWindows() {
      const windowManager = state.apps?.windowManager.pid() ?? null
      if (windowManager === null) return
      const opened = descendantsOf(windowManager)
      for (const pid of opened) signal(pid, 'SIGTERM')
      // An interactive shell ignores SIGTERM, and goes when its terminal closes.
      const deadline = Date.now() + STOP_GRACE_MS
      while (opened.some(alive) && Date.now() < deadline) await sleep(POLL_MS)
      for (const pid of opened.filter(alive)) signal(pid, 'SIGKILL')
    },
    async stop() {
      state.stopped = true
      state.clipboard?.kill()
      if (state.apps) await Promise.all([state.apps.windowManager.stop(), state.apps.browser.stop()])
      await xvnc.stop()
    },
  }
}
