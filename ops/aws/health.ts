// Every minute on each host (agents-health.timer): disk and memory use, and on
// the server whether the API, Electric and the forge answer and how old the last
// good backup is, sent to CloudWatch for the alarms in ops/aws/stack.ts.
//   node --env-file=.env ops/aws/health.ts server [--dry-run]
//   node ops/aws/health.ts boxes [--dry-run]
// A dry run measures and prints what it would send, and sends nothing.

import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { request } from 'node:http'
import { freemem, homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum, type StandardUnit } from '@aws-sdk/client-cloudwatch'
import { z } from 'zod'
import { BACKUP_STATE, BackupState, MACHINE_PORT, METRICS_NAMESPACE, Port, Role, settingsFrom } from './config.ts'
import { isDryRun } from './steps.ts'

// What the server's report reads, from its .env. The box host reports disk and memory only, and reads none of it.
const ServerSettings = z.object({
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
  AGENTS_PEOPLE_SOCKET: z.string().startsWith('/'),
  ELECTRIC_URL: z.url().default('http://127.0.0.1:3000'),
  AGENTS_FORGE_URL: z.url().default('http://127.0.0.1:3001'),
  AGENTS_HOME: z.string().min(1).default(join(homedir(), '.agents-app')),
})
// A service that has not answered in this long counts as down.
const PROBE_MS = 5000
const HOUR_MS = 60 * 60 * 1000
// Not an instance token. The machine port answers 401 only after Postgres has
// looked it up, so that answer shows the API and the database both work.
const PROBE_TOKEN = 'health-probe'

// Whether a request gets the status a healthy service gives. A refused or timed
// out connection is what a down service looks like, so it is a no, not an error.
async function answers(url: string, expected: number, init: RequestInit = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_MS) })
    await res.body?.cancel()
    return res.status === expected
  } catch {
    return false
  }
}

// Whether a GET on the people socket gets the status a healthy API gives. As with
// answers(), no connection or no answer in time is a no.
function answersOnSocket(socketPath: string, path: string, expected: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path, method: 'GET', timeout: PROBE_MS }, (res) => {
      res.resume()
      resolve(res.statusCode === expected)
    })
    req.once('timeout', () => { req.destroy() })
    req.once('error', () => { resolve(false) })
    req.end()
  })
}

function diskUsedPercent(): number {
  const disk = statfsSync('/')
  const used = disk.blocks - disk.bfree
  return (100 * used) / (used + disk.bavail)
}

async function measure(role: Role): Promise<[string, number, StandardUnit][]> {
  const shared: [string, number, StandardUnit][] = [
    ['DiskUsedPercent', diskUsedPercent(), 'Percent'],
    ['MemoryUsedPercent', 100 * (1 - freemem() / totalmem()), 'Percent'],
  ]
  if (role === 'boxes') return shared
  const settings = settingsFrom(ServerSettings, 'the health settings')
  const machine = answers(`http://127.0.0.1:${settings.AGENTS_API_PORT}/v1/instance/heartbeat`, 401, {
    method: 'POST', headers: { authorization: `Bearer ${PROBE_TOKEN}`, 'content-type': 'application/json' }, body: '{}',
  })
  // Without a Tailscale login the people socket answers 401, which shows the API serves people there.
  const people = answersOnSocket(settings.AGENTS_PEOPLE_SOCKET, '/v1/me', 401)
  const [machineUp, peopleUp, electricUp, forgeUp] = await Promise.all([
    machine, people, answers(new URL('/v1/health', settings.ELECTRIC_URL).toString(), 200), answers(new URL('/api/healthz', settings.AGENTS_FORGE_URL).toString(), 200),
  ])
  const server: [string, number, StandardUnit][] = [
    ['ApiUp', machineUp && peopleUp ? 1 : 0, 'Count'],
    ['ElectricUp', electricUp ? 1 : 0, 'Count'],
    ['ForgeUp', forgeUp ? 1 : 0, 'Count'],
  ]
  // No state file means no backup has finished. Nothing is sent, and the alarm
  // treats the missing value as a failure.
  const stateFile = join(settings.AGENTS_HOME, BACKUP_STATE)
  if (existsSync(stateFile)) {
    const state = BackupState.parse(JSON.parse(readFileSync(stateFile, 'utf8')))
    server.push(['BackupAgeHours', (Date.now() - Date.parse(state.lastSuccess)) / HOUR_MS, 'None'])
  }
  return [...shared, ...server]
}

const role = Role.parse(process.argv[2])
const metrics = await measure(role)
const data: MetricDatum[] = metrics.map(([name, value, unit]) => ({ MetricName: name, Value: value, Unit: unit, Dimensions: [{ Name: 'Host', Value: role }] }))
const summary = metrics.map(([name, value]) => `${name}=${Math.round(value * 10) / 10}`).join(' ')
if (isDryRun()) {
  console.log(`would send to ${METRICS_NAMESPACE} for Host=${role}: ${summary}`)
} else {
  await new CloudWatchClient({}).send(new PutMetricDataCommand({ Namespace: METRICS_NAMESPACE, MetricData: data }))
  console.log(`sent ${summary}`)
}
