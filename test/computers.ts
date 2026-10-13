// What the agent computer checks, step 15 and 15b, share: the box they build,
// the page its browser shows, the environment their API and box run with, and
// the agent's computer tools, started the way Claude Code starts them.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const ROOT = new URL('..', import.meta.url).pathname
export const IMAGE = 'agents-box:computers'
// The box firewall lets containers reach only 7700 and this port on the Mac, so
// both checks use it, one at a time, holding ~/.agents-app/checks/run.lock.
export const MACHINE_PORT = 7701
export const SCREEN = { width: 1280, height: 800 }

// The page the agent checks: an input that echoes what is typed, and a square
// that F2 turns from black to white and back, for timing a key press.
export const SQUARE = { left: 600, top: 300, size: 80 }
export const INPUT = { left: 100, top: 120, width: 400, height: 32 }
const PAGE = `<!doctype html><title>Agents check page</title>
<style>body{margin:0;font:16px sans-serif;background:#fff}#square{position:fixed;left:${SQUARE.left}px;top:${SQUARE.top}px;width:${SQUARE.size}px;height:${SQUARE.size}px;background:#000}</style>
<h1>Agents check page</h1>
<input id="name" aria-label="Name" style="position:fixed;left:${INPUT.left}px;top:${INPUT.top}px;width:${INPUT.width}px;height:${INPUT.height}px">
<p id="out" style="position:fixed;left:100px;top:170px">typed:</p>
<div id="square"></div>
<script>
const field = document.getElementById('name'), out = document.getElementById('out'), square = document.getElementById('square')
field.addEventListener('input', () => { out.textContent = 'typed:' + field.value })
let dark = true
addEventListener('keydown', (e) => { if (e.key === 'F2') { dark = !dark; square.style.background = dark ? '#000' : '#fff'; e.preventDefault() } })
</script>`
export const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`
export const F2 = 0xffbf

export async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(300)
  }
  return false
}

export const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
export const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  } catch {
    // A missing file or container, which the caller reports as what it checks.
    return null
  }
}

// The API's and the box's environment for a check's team: its own people and
// streams ports, the box image, and the stand-in for Claude mounted in the box.
// Box mounts come from the colima VM, which sees only the home folder, so `work`
// must be under it.
export function boxCheckEnv(team: string, work: string, peoplePort: number, streamsPort: number): Record<string, string> {
  return {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(MACHINE_PORT), AGENTS_PEOPLE_PORT: String(peoplePort),
    AGENTS_STREAMS_PORT: String(streamsPort), AGENTS_STREAMS_DIR: join(work, 'streams'),
    AGENTS_BOX_IMAGE: IMAGE, AGENTS_BOX_API: `http://host.docker.internal:${MACHINE_PORT}`,
    AGENTS_BOX_DOCKER_ARGS: JSON.stringify([
      '-v', `${join(ROOT, 'test/fake-claude.ts')}:/opt/check/fake-claude.ts:ro`,
      '-v', `${join(ROOT, 'test/box-browsers.ts')}:/opt/check/box-browsers.ts:ro`,
      '-v', `${join(work, 'scenario.json')}:/opt/check/scenario.json:ro`,
      '-e', 'AGENTS_CLAUDE_BIN=/opt/check/fake-claude.ts', '-e', 'AGENTS_FAKE_SCENARIO=/opt/check/scenario.json',
    ]),
  }
}

// The computer MCP server of a session in the box, started as the daemon's MCP
// config says, in the session's folder, the way Claude Code starts it.
export async function computerTools(container: string, sessionId: string, cwd: string) {
  const config = JSON.parse(docker('exec', container, 'cat', `/home/agent/.agents-app/sessions/${sessionId}.mcp.json`))
  const server = config.mcpServers.computer
  const env = Object.entries(server.env as Record<string, string>).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const client = new Client({ name: 'computer-check', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: 'docker', args: ['exec', '-i', '-w', cwd, ...env, container, server.command, ...server.args] }))
  return { client, server }
}

export const textOf = (result: any): string => (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
export const imageOf = (result: any): string | undefined => (result.content ?? []).find((c: any) => c.type === 'image')?.data
export const pngSize = (base64: string) => {
  const png = Buffer.from(base64, 'base64')
  return png.subarray(1, 4).toString() === 'PNG' ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null
}

// What the box's page echoes of its input, read through the agent's browser tools.
export const pageSays = async (tools: Client) =>
  /typed:[^"\n]*/.exec(textOf(await tools.callTool({ name: 'browser_snapshot', arguments: {} })))?.[0] ?? '(nothing)'
