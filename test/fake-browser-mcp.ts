// Stands in for Playwright's MCP server, which the box's computer server runs as a
// child, so a check can start that server without a browser. It lists one tool.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'fake-browser', version: '1.0.0' })
server.registerTool('browser_snapshot', { description: 'A page snapshot', inputSchema: {} }, () => ({ content: [{ type: 'text', text: 'a page' }] }))
await server.connect(new StdioServerTransport())
