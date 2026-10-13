// The box's computer: TigerVNC's Xvnc, which is both the X display and the VNC
// server, matchbox as the window manager, and the box's Chromium. The daemon
// starts all three, restarts any that exits, and stops them when it stops.
// The design is docs/design/computers.md.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ScreenSize } from '../shared/screen.ts'
import { messageOf } from '../shared/errors.ts'

export type DesktopConfig = {
  size: ScreenSize
  // Where the daemon keeps the screen's sockets, readable only by this user.
  runDir: string
  // The browser's profile, in the home volume so logins outlive the container.
  profileDir: string
  // Playwright's browsers folder, which holds the one Chromium the box uses.
  browsersPath: string
}

export type Desktop = {
  size: ScreenSize
  vncSocket: string
  cdpUrl: string
  // Resolves once Xvnc accepts connections and the browser answers on its DevTools port.
  ready: Promise<void>
  stop(): Promise<void>
}

const DISPLAY = ':1'
// Chrome's usual DevTools port, on the box's loopback only.
const CDP_PORT = 9222
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

type Supervised = { stop(): Promise<void> }

// Runs a process, and runs it again whenever it exits or can't start, waiting
// longer after each quick failure.
function supervise(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, beforeStart: () => void): Supervised {
  let kill: ((signal: NodeJS.Signals) => void) | null = null
  // Set by stop() while the loop below waits, so the loop reads it through a function.
  const state = { stopping: false }
  const stopping = () => state.stopping
  let delay = RESTART_FIRST_MS
  const stderr: string[] = []
  // Resolves with why the process ended.
  const runOnce = async (): Promise<string> => {
    beforeStart()
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    kill = (signal) => child.kill(signal)
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
      kill = null
      if (stopping()) return
      delay = Date.now() - started > HEALTHY_MS ? RESTART_FIRST_MS : Math.min(RESTART_MAX_MS, delay * 2)
      console.error(`desktop: ${name} ended (${ended}), starting it again in ${delay / 1000}s${stderr.length ? `\n  ${stderr.slice(-5).join('\n  ')}` : ''}`)
      stderr.length = 0
      await sleep(delay)
    }
  })()
  return {
    async stop() {
      state.stopping = true
      const stopNow = kill
      if (!stopNow) return
      stopNow('SIGTERM')
      const killer = setTimeout(() => { stopNow('SIGKILL') }, STOP_GRACE_MS)
      await done
      clearTimeout(killer)
    },
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
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`
  const chromium = findChromium(config.browsersPath)
  const env = { ...process.env, DISPLAY }
  const { width, height } = config.size

  const xvnc = supervise('Xvnc', 'Xvnc', [
    DISPLAY, '-geometry', `${width}x${height}`, '-depth', '24', '-desktop', 'Agents box',
    // Viewers come only through the daemon's tunnels, over this socket. No TCP at all.
    '-rfbunixpath', vncSocket, '-rfbunixmode', '0600', '-rfbport', '-1', '-nolisten', 'tcp',
    // The daemon's own connection and every viewer's share the screen. None is a
    // reason to drop another, and nobody resizes it under the agent's coordinates.
    '-SecurityTypes', 'None', '-AlwaysShared', '-DisconnectClients=0', '-AcceptSetDesktopSize=0',
    // Nothing on this screen uses GLX, and leaving it out keeps Mesa unloaded.
    '-extension', 'GLX',
  ], env, () => {
    // A container restart leaves the last run's lock and socket behind, and Xvnc
    // refuses to start while they exist. Only this daemon runs an X server here.
    rmSync('/tmp/.X1-lock', { force: true })
    rmSync('/tmp/.X11-unix/X1', { force: true })
    rmSync(vncSocket, { force: true })
    mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 })
  })
  const startApps = (): Supervised[] => [
    supervise('matchbox', 'matchbox-window-manager', ['-use_titlebar', 'no'], env, () => undefined),
    supervise('Chromium', chromium, [
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
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${config.profileDir}`,
      '--window-position=0,0', `--window-size=${width},${height}`, '--start-maximized', 'about:blank',
    ], env, () => {
      // A recreated container has a new hostname, and Chromium won't open a profile
      // its old self still seems to hold.
      for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(config.profileDir, lock), { force: true })
    }),
  ]

  const state: { apps: Supervised[]; stopped: boolean } = { apps: [], stopped: false }
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
    size: config.size, vncSocket, cdpUrl, ready,
    async stop() {
      state.stopped = true
      await Promise.all(state.apps.map((app) => app.stop()))
      await xvnc.stop()
    },
  }
}
