// What the voice checks share: an API of their own on their own ports, a team with one
// person on it, and the stand-in for tailscale serve that takes people to the API's socket.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// How long the API may take to start listening: it migrates the test database and starts its stream store.
const START_MS = 30_000
const STOP_MS = 10_000

export type VoiceApi = { people: string; stop: () => Promise<void> }

export type ApiPorts = { machines: number; people: number; streams: number }

// An API with no runner and no GitHub worker, its stream store in `work`, and speech pointed at `speechUrl`
// or nowhere. The people port is the stand-in for serve, which sets nothing: each request sets its own login.
export async function startApi(work: string, ports: ApiPorts, speechUrl: string | undefined): Promise<VoiceApi> {
  const peopleSocket = join(work, `people-${ports.people}.sock`)
  const proxy = await servePeople(ports.people, peopleSocket)
  const env: NodeJS.ProcessEnv = {
    ...process.env, AGENTS_RUNNER: 'off', AGENTS_API_PORT: String(ports.machines), AGENTS_PEOPLE_SOCKET: peopleSocket,
    AGENTS_STREAMS_PORT: String(ports.streams), AGENTS_STREAMS_DIR: join(work, `streams-${ports.streams}`),
  }
  if (speechUrl) env.AGENTS_SPEECH_URL = speechUrl
  else delete env.AGENTS_SPEECH_URL
  delete env.AGENTS_MACHINE_HOST
  const child: ChildProcess = spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] })
  // Made now, since a process killed by a signal keeps a null exitCode and has already sent 'exit'.
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  const people = `http://127.0.0.1:${ports.people}`
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline && !(await fetch(`${people}/v1/me`).then(() => true, () => false))) await sleep(250)
  return {
    people,
    stop: async () => {
      child.kill('SIGTERM')
      await Promise.race([exited, sleep(STOP_MS)])
      proxy.close()
    },
  }
}

const adminEnv = () => ({ ...process.env })
export function migrate() {
  execFileSync(process.execPath, ['server/migrate.ts'], { cwd: ROOT, env: adminEnv(), stdio: 'ignore' })
}
export function addTeam(team: string, login: string) {
  execFileSync(process.execPath, ['server/admin.ts', 'add-team', team, login], { cwd: ROOT, env: adminEnv(), stdio: 'ignore' })
}
export function addPerson(team: string, login: string) {
  execFileSync(process.execPath, ['server/admin.ts', 'add-person', team, login], { cwd: ROOT, env: adminEnv(), stdio: 'ignore' })
}

export async function dropTeam(team: string) {
  const db = new pg.Client({ connectionString: must(process.env.DATABASE_URL, 'DATABASE_URL') })
  await db.connect()
  try {
    await db.query('delete from teams where name = $1', [team])
  } finally {
    await db.end()
  }
}
