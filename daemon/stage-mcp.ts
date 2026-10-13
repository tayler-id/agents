// The report_result tool for a pipeline stage's session. The agent calls it once
// to say how the stage ended. The call itself lands in the record as a tool call,
// and the runner reads it from there when the turn ends.
// Env: AGENTS_STAGE_OUTCOMES, a JSON list of the outcomes this stage accepts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const outcomes = JSON.parse(process.env.AGENTS_STAGE_OUTCOMES ?? '[]') as [string, ...string[]]
const server = new McpServer({ name: 'stage', version: '1.0.0' })

server.registerTool('report_result', {
  title: 'Report how this stage ended',
  description: 'Call this once, when the stage\'s work is done, to tell the pipeline how it ended. '
    + `outcome must be one of: ${outcomes.join(', ')}. The summary is shown to people; data holds any details the stage asked for.`,
  inputSchema: {
    outcome: z.enum(outcomes),
    summary: z.string().min(1).describe('What you found or did, in a few sentences'),
    data: z.record(z.string(), z.unknown()).optional().describe('Details the stage asked for, such as a test command'),
  },
}, async ({ outcome }) => ({
  content: [{ type: 'text', text: `Recorded ${outcome}. Stop here: end your turn without further tool calls.` }],
}))

await server.connect(new StdioServerTransport())
