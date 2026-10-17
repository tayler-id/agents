// A stand-in for the MCP server of an agent's plugin, for checks that the plugin
// gets the secret its config names. It speaks MCP over stdio, as a plugin does.
// Its one tool answers with the SHA-256 of an environment variable and never the
// variable, so a check can compare it with a value's hash and the answer holds
// nothing to scrub.

import { createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fake-plugin', version: '1.0.0' })

server.registerTool('fingerprint', {
  title: 'Fingerprint of an environment variable',
  description: 'The SHA-256 of the variable this plugin was started with, or "unset".',
  inputSchema: { variable: z.string() },
}, ({ variable }) => {
  const value = process.env[variable]
  return { content: [{ type: 'text', text: value === undefined ? 'unset' : createHash('sha256').update(value).digest('hex') }] }
})

await server.connect(new StdioServerTransport())
