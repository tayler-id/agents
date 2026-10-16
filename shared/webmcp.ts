// How an agent's browser uses the tools a web page offers through WebMCP. A team
// lists the origins whose pages it trusts, and the `computer` server gives an
// agent a page's tools only while the page is at one of them. The server, the
// daemon and the app share these shapes. The design is in
// docs/design/target-architecture.md, under "WebMCP, both ways".

import { z } from 'zod'

// The `computer` server's name. Claude Code puts it in each of the server's tool names.
export const COMPUTER_SERVER = 'computer'

// The three tools the server adds when the team lists an origin.
export const WEB_TOOL_LIST = 'web_tools'
export const WEB_TOOL_READ = 'web_read'
export const WEB_TOOL_ACT = 'web_act'

// Tools that ask a person every time, as Claude Code names them. A standing rule
// never covers one and the approval card has no Always or Never for it, since an
// answer for all time would let an agent act on any page it later opens.
export const ASKS_EVERY_TIME: readonly string[] = [`mcp__${COMPUTER_SERVER}__${WEB_TOOL_ACT}`]

// The most origins a team lists. The list rides in every message to a machine.
export const WEBMCP_ORIGINS_MAX = 50
// The longest origin kept. A host name is 253 characters at most.
const ORIGIN_MAX = 300

export type OriginPattern = { scheme: 'http' | 'https'; host: string; port: string }

const DEFAULT_PORT = { http: '80', https: '443' } as const
const ENTRY = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)(?::([0-9]{1,5}|\*))?$/i

// A listed origin read into its parts. A port left out is the scheme's own,
// and `*` is any port. Null when the text is not an origin this list takes.
export function parseOrigin(text: string): OriginPattern | null {
  const match = ENTRY.exec(text)
  const scheme = match?.[1]?.toLowerCase()
  const host = match?.[2]?.toLowerCase()
  if ((scheme !== 'http' && scheme !== 'https') || !host) return null
  const given = match?.[3]
  if (given !== undefined && given !== '*' && (Number(given) < 1 || Number(given) > 65535)) return null
  // Written as a number, so 0080 and 80 are one port.
  const port = given === undefined ? DEFAULT_PORT[scheme] : given === '*' ? '*' : String(Number(given))
  // The URL parser is the judge of the host, as the browser's is, so the list
  // holds nothing a browser would read as another host.
  try {
    if (new URL(`${scheme}://${host}`).host !== host) return null
  } catch {
    // A host the URL parser refuses is not one a page can have.
    return null
  }
  return { scheme, host, port }
}

// An origin as the list keeps it. The scheme's own port is left out.
export function originText({ scheme, host, port }: OriginPattern): string {
  return `${scheme}://${host}${port === DEFAULT_PORT[scheme] ? '' : `:${port}`}`
}

// A listed origin, in the one form the list keeps. A port is a number or `*`.
export const WebmcpOrigin = z.string().trim().max(ORIGIN_MAX).transform((text, ctx) => {
  const pattern = parseOrigin(text)
  if (!pattern) {
    ctx.issues.push({
      code: 'custom', input: text,
      message: 'must be a scheme and a host, such as https://example.com, with a port if the site uses one, or * for any port',
    })
    return z.NEVER
  }
  return originText(pattern)
})
export type WebmcpOrigin = z.infer<typeof WebmcpOrigin>

// The list as a daemon and the computer server take it.
export const WebmcpOrigins = z.array(WebmcpOrigin).max(WEBMCP_ORIGINS_MAX)

// Whether a page at `pageOrigin`, as `location.origin` gives it, is at a listed
// origin. A page with no web origin, such as about:blank, is at none.
export function originAllowed(pageOrigin: string, listed: readonly string[]): boolean {
  let page: URL
  try {
    page = new URL(pageOrigin)
  } catch {
    // location.origin of a page with no web origin is the text "null".
    return false
  }
  if ((page.protocol !== 'http:' && page.protocol !== 'https:') || page.origin !== pageOrigin) return false
  const scheme = page.protocol === 'http:' ? 'http' : 'https'
  const port = page.port || DEFAULT_PORT[scheme]
  return listed.some((entry) => {
    const pattern = parseOrigin(entry)
    return pattern !== null && pattern.scheme === scheme && pattern.host === page.hostname && (pattern.port === '*' || pattern.port === port)
  })
}

// The list as the API shows it to an admin.
export const WebmcpOriginId = z.uuid().brand<'WebmcpOriginId'>()
export type WebmcpOriginId = z.infer<typeof WebmcpOriginId>
export const WebmcpOriginRow = z.object({
  id: WebmcpOriginId, origin: WebmcpOrigin, addedBy: z.string().nullable(), createdAt: z.string().min(1),
})
export type WebmcpOriginRow = z.infer<typeof WebmcpOriginRow>
export const WebmcpOriginList = z.object({ origins: z.array(WebmcpOriginRow) })
export type WebmcpOriginList = z.infer<typeof WebmcpOriginList>
export const AddWebmcpOriginBody = z.object({ origin: WebmcpOrigin })
export type AddWebmcpOriginBody = z.infer<typeof AddWebmcpOriginBody>
