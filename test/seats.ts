// What the seat checks, step 15c and 15d, share: a session's computer tools,
// pages that fill a seat's browser with one color, and how to tell the colors
// apart on a screen.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { docker, SCREEN } from './computers.ts'

// A session's `computer` MCP server in the box, started in the session's folder
// as the daemon's MCP config says, the way Claude Code starts it. Its `docker
// exec` keeps this check's environment, which the docker agents-git puts first
// on a check's PATH reads. The MCP client would otherwise pass it only a few
// variables, such as PATH and HOME.
export async function seatTools(container: string, sessionId: string, cwd: string) {
  const config = JSON.parse(docker('exec', container, 'cat', `/home/agent/.agents-app/sessions/${sessionId}.mcp.json`))
  const server = config.mcpServers.computer
  const env = Object.entries(server.env).flatMap(([key, value]) => ['-e', `${key}=${String(value)}`])
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const client = new Client({ name: 'seats-check', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: 'docker', args: ['exec', '-i', '-w', cwd, ...env, container, server.command, ...server.args], env: inherited,
  }))
  return { client, env: server.env }
}

// A page that fills a seat's browser with one color, named for the seat.
export const seatPage = (title: string, color: string) => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%;background:${color}}</style><h1>${title}</h1>`)}`
// A point well inside a seat's page, below its browser's toolbar.
export const IN_PAGE = { x: SCREEN.width / 2, y: SCREEN.height - 100 }
export const isRed = ([r, g, b]: number[]) => (r ?? 0) > 200 && (g ?? 255) < 60 && (b ?? 255) < 60
export const isBlue = ([r, g, b]: number[]) => (r ?? 255) < 60 && (g ?? 255) < 60 && (b ?? 0) > 200
