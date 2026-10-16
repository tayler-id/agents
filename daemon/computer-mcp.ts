// The `computer` MCP server every session on a machine with a screen gets. Its
// own tools act on the whole screen through the daemon's screen service, and it
// passes Playwright MCP's browser tools through, driving the box's Chromium over
// its DevTools port. Every action, its own or Playwright's, first checks who
// holds the screen, so a person who takes over stops the agent's use of both.
// The design is docs/design/computers.md.
// Env, set by the daemon in the session's MCP config: AGENTS_SCREEN_SOCKET,
// AGENTS_BROWSER_MCP, AGENTS_BROWSER_CDP, AGENTS_API, AGENTS_TOKEN and AGENTS_SESSION (for share_screen), and
// AGENTS_TASK_FOLDER for a task's session.

import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, ToolSchema, type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  ActDone, ActRefused, ComputerAction, ComputerOutput, SavedScreenshot, ScreenStatus, ScreenStatusOutput, ScreenshotName, SecretsShown,
  type ScreenControl,
} from '../shared/screen.ts'
import { parseJson } from '../shared/json.ts'
import { messageOf } from '../shared/errors.ts'
import { shareBytes } from './share-client.ts'

const Config = z.object({
  AGENTS_SCREEN_SOCKET: z.string().min(1),
  AGENTS_BROWSER_MCP: z.string().min(1),
  AGENTS_BROWSER_CDP: z.url(),
  AGENTS_API: z.url(),
  AGENTS_TOKEN: z.string().min(1),
  AGENTS_SESSION: z.uuid(),
  // Only a task's session has a task folder, where saved screenshots become documents.
  AGENTS_TASK_FOLDER: z.string().min(1).optional(),
})
const parsedConfig = Config.safeParse(process.env)
if (!parsedConfig.success) {
  console.error(`computer: ${z.prettifyError(parsedConfig.error)}`)
  process.exit(2)
}
const config = parsedConfig.data

// Where Playwright puts files it names itself. Files the agent names go where it
// says, relative to the session's folder.
const BROWSER_OUTPUT = join(tmpdir(), 'agents-browser-output')
const InputSchema = ToolSchema.shape.inputSchema
const OutputSchema = ToolSchema.shape.outputSchema.unwrap()
const ErrorBody = z.object({ error: z.string() })

// The screen service, over its Unix socket.
function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: config.AGENTS_SCREEN_SOCKET, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode === undefined) reject(new Error('the screen service answered with no status'))
        else resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function answerOf<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  const parsed = parseJson(schema, text)
  if (!parsed.ok) throw new Error(`the screen service sent something unexpected: ${parsed.reason}`)
  return parsed.value
}

const status = async () => answerOf(ScreenStatus, (await call('GET', '/status')).text)

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })
const refusal = (control: ScreenControl): CallToolResult => failure(control.holder === 'person'
  ? `${control.login} has taken over the screen. Wait until they hand it back (screen_status tells you), then take a screenshot before you act.`
  : 'The screen refused the action.')

type Acted = { done: ActDone } | { refused: CallToolResult }
async function act(action: ComputerAction): Promise<Acted> {
  const answer = await call('POST', '/act', { action })
  if (answer.status === 409) return { refused: refusal(answerOf(ActRefused, answer.text).control) }
  if (answer.status !== 200) return { refused: failure(answerOf(ErrorBody, answer.text).error) }
  return { done: answerOf(ActDone, answer.text) }
}

// A saved screenshot is never scrubbed, so none is saved while a page in the
// box's browser shows a secret the box holds. Null when no page shows one.
async function secretRefusal(): Promise<CallToolResult | null> {
  const answer = await call('GET', '/secrets-shown')
  if (answer.status !== 200) {
    return failure(`No screenshot was saved, since the box could not read what its browser's pages show (${answerOf(ErrorBody, answer.text).error}).`)
  }
  const { names } = answerOf(SecretsShown, answer.text)
  if (names.length === 0) return null
  return failure(`A page in the browser shows ${names.join(', ')}, which this box holds as a secret, so no screenshot was saved. `
    + 'Close that page or change what it shows, then save again.')
}

// The epoch of control this session last acted under, to notice a person used
// the screen in between.
let lastEpoch: number | null = null

async function computer(args: unknown): Promise<CallToolResult> {
  const action = ComputerAction.safeParse(args)
  if (!action.success) return failure(z.prettifyError(action.error))
  const acted = await act(action.data)
  if ('refused' in acted) return acted.refused
  const { shot, cursor, epoch, lastPerson } = acted.done
  const personUsedScreen = lastEpoch !== null && epoch !== lastEpoch ? lastPerson : null
  lastEpoch = epoch
  const output = ComputerOutput.parse({ width: shot.width, height: shot.height, cursor, personUsedScreen })
  const note = personUsedScreen ? ` ${personUsedScreen} used the screen since your last action, so look at this screenshot before you act.` : ''
  return {
    content: [
      { type: 'image', data: shot.png, mimeType: 'image/png' },
      { type: 'text', text: `Screen ${shot.width}x${shot.height}, cursor at (${cursor.x}, ${cursor.y}).${note}` },
    ],
    structuredContent: output,
  }
}

async function saveScreenshot(args: unknown): Promise<CallToolResult> {
  const input = z.object({ name: ScreenshotName }).safeParse(args)
  if (!input.success) return failure(z.prettifyError(input.error))
  if (!config.AGENTS_TASK_FOLDER) return failure("This session has no task folder, so a screenshot can't become a document here. Use the computer tool to look instead.")
  const acted = await act({ action: 'screenshot' })
  if ('refused' in acted) return acted.refused
  // Read once the shot is taken, after the screen settled, so the pages are read
  // as the shot shows them.
  const secretShown = await secretRefusal()
  if (secretShown) return secretShown
  const bytes = Buffer.from(acted.done.shot.png, 'base64')
  const path = `checks/${input.data.name}.png`
  mkdirSync(join(config.AGENTS_TASK_FOLDER, 'checks'), { recursive: true })
  writeFileSync(join(config.AGENTS_TASK_FOLDER, path), bytes)
  return {
    content: [
      { type: 'text', text: `Saved ${path} in the task folder. It shows on the task under "Made by this task" when your turn ends.` },
      { type: 'image', data: acted.done.shot.png, mimeType: 'image/png' },
    ],
    structuredContent: SavedScreenshot.parse({ path, bytes: bytes.length }),
  }
}

// Posts what the screen shows into the chat or task the session serves, as a picture the people there see.
async function shareScreen(args: unknown): Promise<CallToolResult> {
  const input = z.object({ caption: z.string().max(2000).optional() }).safeParse(args)
  if (!input.success) return failure(z.prettifyError(input.error))
  const acted = await act({ action: 'screenshot' })
  if ('refused' in acted) return acted.refused
  // The shot is read for secrets once it is taken, as a saved screenshot is.
  const secretShown = await secretRefusal()
  if (secretShown) return secretShown
  const bytes = Buffer.from(acted.done.shot.png, 'base64')
  await shareBytes({ api: config.AGENTS_API, token: config.AGENTS_TOKEN, session: config.AGENTS_SESSION },
    { bytes, name: 'screen.png', contentType: 'image/png', caption: input.data.caption ?? '' })
  return { content: [{ type: 'text', text: 'Shared a screenshot of your screen.' }] }
}

async function screenStatus(): Promise<CallToolResult> {
  const now = await status()
  const who = now.control.holder === 'person' ? `${now.control.login} has the screen and is using it now.` : 'You have the screen.'
  return {
    content: [{ type: 'text', text: `${who} It is ${now.size.width}x${now.size.height}.` }],
    structuredContent: ScreenStatusOutput.parse({ control: now.control, size: now.size }),
  }
}

// The `computer` tool's input as one flat object, the shape Claude's own
// computer-use tool has. It is built from the per-action schemas, with each
// field once and `action` naming every action.
function computerInputSchema(): Tool['inputSchema'] {
  const properties: Record<string, object> = {}
  for (const option of ComputerAction.options) {
    const schema = InputSchema.parse(z.toJSONSchema(option))
    for (const [field, value] of Object.entries(schema.properties ?? {})) properties[field] ??= value
  }
  properties.action = { type: 'string', enum: ComputerAction.options.map((option) => option.shape.action.value), description: 'What to do' }
  return { type: 'object', properties, required: ['action'] }
}

const OWN_TOOLS: Tool[] = [
  {
    name: 'computer',
    title: 'Use your computer',
    description: 'Use your own computer: a Linux desktop of 1280x800 pixels with a Chromium window, which people on your team can '
      + 'watch. Each call does one action and returns a screenshot taken after it. Coordinates are [x, y] in screen pixels '
      + 'from the top left. Clicks act at `coordinate`, or where the cursor is when it is left out, and `text` holds keys '
      + 'such as "shift" during a click or scroll. `key` presses keys in xdotool form, such as "Return" or "ctrl+l". For web '
      + 'pages the browser_ tools are faster and more exact. Use this for anything they cannot do, and to see the whole '
      + 'screen. While a person has taken over the screen, every action is refused until they hand it back.',
    inputSchema: computerInputSchema(),
    outputSchema: OutputSchema.parse(z.toJSONSchema(ComputerOutput)),
  },
  {
    name: 'save_screenshot',
    title: 'Save a screenshot as proof',
    description: "Save what the screen shows now as checks/<name>.png in this task's folder, where it becomes a document "
      + 'on the task that your teammates see. Save one for each thing you checked, named for what it shows, such as '
      + '"signup-error-message". Nothing is saved while a page in the browser shows a secret this box holds.',
    inputSchema: InputSchema.parse(z.toJSONSchema(z.object({ name: ScreenshotName.describe('Lowercase letters, digits and dashes') }))),
    outputSchema: OutputSchema.parse(z.toJSONSchema(SavedScreenshot)),
  },
  {
    name: 'share_screen',
    title: 'Share your screen',
    description: 'Post a screenshot of what your screen shows now into the chat or task you are working in, with an optional caption, '
      + 'so the people there see it where you posted it. Nothing is shared while a page in the browser shows a secret this box holds.',
    inputSchema: InputSchema.parse(z.toJSONSchema(z.object({ caption: z.string().max(2000).optional().describe('What to say with it') }))),
  },
  {
    name: 'screen_status',
    title: 'Who has the screen',
    description: 'Whether you have your computer\'s screen or a person has taken it over, and its size.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: OutputSchema.parse(z.toJSONSchema(ScreenStatusOutput)),
  },
]

// Playwright's browser tools, from its MCP server running as a child process.
const browser = new Client({ name: 'computer', version: '1.0.0' })
const browserReady = browser.connect(new StdioClientTransport({
  command: process.execPath,
  // Pages can register their own tools through WebMCP. Those would come from
  // whatever site is open, so they stay out of the agent's tool list.
  args: [config.AGENTS_BROWSER_MCP, '--cdp-endpoint', config.AGENTS_BROWSER_CDP, '--no-webmcp', '--output-dir', BROWSER_OUTPUT],
}))
const browserTools = browserReady.then(async () => (await browser.listTools()).tools)
// Without Playwright the box's image is broken. The server stops and says why,
// and Claude Code shows the session that its `computer` server failed.
browserTools.catch((error: unknown) => {
  console.error(`computer: Playwright's browser tools did not start: ${messageOf(error)}`)
  process.exit(1)
})

// How often a browser call under way asks whether a person has taken over.
const TAKEOVER_POLL_MS = 250

// A browser call runs only while the agents hold the screen. A person who takes
// over while one runs stops it, and the agent hears who did.
async function browserCall(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const now = await status()
  if (now.control.holder === 'person') return refusal(now.control)
  const abort = new AbortController()
  // Set by the poll below while the call is awaited, so it is read through the object.
  const taken: { by: ScreenControl | null } = { by: null }
  const poll = setInterval(() => {
    status().then((later) => {
      if (later.control.holder !== 'person' || abort.signal.aborted) return
      taken.by = later.control
      abort.abort()
    }, (error: unknown) => {
      // The call goes on, and the next poll asks again.
      console.error(`computer: asking who holds the screen: ${messageOf(error)}`)
    })
  }, TAKEOVER_POLL_MS)
  try {
    return CallToolResultSchema.parse(await browser.callTool({ name, arguments: args }, undefined, { signal: abort.signal }))
  } catch (error) {
    if (taken.by) return refusal(taken.by)
    throw error
  } finally {
    clearInterval(poll)
  }
}

const mcp = new McpServer({ name: 'computer', version: '1.0.0' })
mcp.server.registerCapabilities({ tools: {} })
mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...OWN_TOOLS, ...(await browserTools)] }))
mcp.server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params
  if (name === 'computer') return computer(args)
  if (name === 'save_screenshot') return saveScreenshot(args)
  if (name === 'share_screen') return shareScreen(args)
  if (name === 'screen_status') return screenStatus()
  if ((await browserTools).some((tool) => tool.name === name)) {
    // Given a file name, Playwright's screenshot tool saves where the name says,
    // which can be the task folder, where an image becomes a document. Without
    // one it saves only in its own output folder.
    if (name === 'browser_take_screenshot' && typeof args?.filename === 'string') {
      const secretShown = await secretRefusal()
      if (secretShown) return secretShown
    }
    return browserCall(name, args)
  }
  return failure(`There is no tool named ${name}.`)
})
// Claude Code closing the session closes this server, and Playwright's with it.
mcp.server.onclose = () => {
  browser.close().catch((error: unknown) => { console.error(`computer: closing the browser tools: ${messageOf(error)}`) })
}
await mcp.connect(new StdioServerTransport())
