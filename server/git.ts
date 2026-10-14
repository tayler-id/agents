// Machines clone and push through the API, as themselves. The API checks that the
// repo is their team's and forwards to the repo's forge, this Mac's Gitea or
// GitHub, with the server's credentials, so forge tokens never leave the server.
// Machines never push to a repo's default branch, as the forge names it when the
// push comes. Changes reach it through pull requests, even on GitHub plans that
// can't protect a private repo's branches. On a repo with a policy, a machine may
// also push only to the task branches of its own workspaces. Any other ref is
// refused here and recorded, so the run whose machine tried it stops, and the
// forge's branch protection refuses a push to main again. A repo without a
// policy takes pushes to any branch but the default one.

import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { instanceFrom } from './auth.ts'
import { many, maybe, pool } from './db.ts'
import { currentDefaultBranch, fromForge, gitUpstreamFor, type RepoOnForge } from './repos.ts'
import { HttpError } from './record.ts'

export const GIT_PATH = /^\/v1\/git\/([0-9a-f-]{36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
const FORWARDED = ['content-type', 'accept', 'content-encoding', 'git-protocol']
const DROPPED = ['content-encoding', 'content-length', 'transfer-encoding', 'www-authenticate', 'set-cookie']
// A push's command lines are read before it is forwarded, and the pack after
// them streams through. The lines are a few hundred bytes for each ref.
const COMMANDS_LIMIT_BYTES = 1024 * 1024
const FLUSH = '0000'
const COMMAND = /^(?:[0-9a-f]{40}) (?:[0-9a-f]{40}) (\S+)$/

// The refs a receive-pack request updates: the pkt-lines before the first flush,
// each "<old> <new> <ref>", the first followed by NUL and the capabilities.
export function pushedRefs(body: Buffer): string[] {
  const refs: string[] = []
  let at = 0
  while (at + 4 <= body.length) {
    const size = body.toString('latin1', at, at + 4)
    if (size === FLUSH) break
    const length = Number.parseInt(size, 16)
    if (!Number.isInteger(length) || length < 4 || at + length > body.length) throw new HttpError(400, 'not a git push')
    const line = body.toString('utf8', at + 4, at + length).split('\0')[0]?.trim() ?? ''
    const ref = COMMAND.exec(line)?.[1]
    if (ref !== undefined) refs.push(ref)
    else if (!line.startsWith('shallow ')) throw new HttpError(400, `not a git push command: ${line.slice(0, 80)}`)
    at += length
  }
  return refs
}

// Where the command lines end: the byte after their flush, or null while more
// is needed. A malformed length ends the reading, and pushedRefs says why.
function commandsEnd(head: Buffer): number | null {
  let at = 0
  while (at + 4 <= head.length) {
    const size = head.toString('latin1', at, at + 4)
    if (size === FLUSH) return at + 4
    const length = Number.parseInt(size, 16)
    if (!Number.isInteger(length) || length < 4) return head.length
    if (at + length > head.length) return null
    at += length
  }
  return null
}

// Reads a push's command lines and returns the refs they update, with a
// stream of the whole push, those lines first, so the pack never sits in memory.
export async function readCommands(input: Readable): Promise<{ refs: string[]; stream: Readable }> {
  const chunks = input[Symbol.asyncIterator]()
  let head = Buffer.alloc(0)
  while (commandsEnd(head) === null) {
    if (head.length > COMMANDS_LIMIT_BYTES) throw new HttpError(413, 'a push with more command lines than any task branch needs')
    const next: IteratorResult<unknown> = await chunks.next()
    if (next.done) break
    head = Buffer.concat([head, Buffer.isBuffer(next.value) ? next.value : Buffer.from(String(next.value))])
  }
  const refs = pushedRefs(head)
  const read = head
  async function* whole() {
    yield read
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) yield next.value
  }
  return { refs, stream: Readable.from(whole()) }
}

// The branches a machine may push to on a repo with a policy: the task
// branches, and replay branches, of tasks with a workspace on that machine.
async function ownBranches(instanceId: string): Promise<Set<string>> {
  const tasks = await many<{ slug: string }>(pool,
    'select distinct t.slug from tasks t join workspaces w on w.task_id = t.id where w.instance_id = $1', [instanceId])
  return new Set(tasks.flatMap(({ slug }) => [`refs/heads/task/${slug}`, `refs/heads/replay/${slug}`]))
}

// A request's body, checked to be bytes as it arrives.
async function* bytesOf(source: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'a git request body must be bytes')
    yield chunk
  }
}

// Bytes as the web stream fetch takes for a request body.
function webStream(chunks: AsyncIterable<Buffer>): ReadableStream<Uint8Array> {
  const source = chunks[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  })
}

export async function proxyGit(req: IncomingMessage, res: ServerResponse, url: URL) {
  const instance = await instanceFrom(req)
  const [, repoId, rest] = GIT_PATH.exec(url.pathname) ?? []
  if (!repoId || !rest) throw new HttpError(404, 'no such git path')
  const row = await maybe<RepoOnForge & { policy_id: string | null; default_branch: string }>(pool,
    'select forge, remote_url, policy_id, default_branch from repos where id = $1 and team_id = $2', [repoId, instance.team_id])
  if (!row) throw new HttpError(404, 'no such repo')
  const repo = { ...row, id: repoId }
  const headers: Record<string, string> = {}
  for (const name of FORWARDED) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  let body: Readable = req
  if (req.method === 'POST' && rest === 'git-receive-pack') {
    // A gzipped push is unzipped here, to read its commands, and sent on plain.
    const plain = plainBody(req, req.headers['content-encoding'])
    delete headers['content-encoding']
    const { refs, stream } = await readCommands(plain)
    if (repo.policy_id !== null) {
      const own = await ownBranches(instance.id)
      const refused = refs.filter((ref) => !own.has(ref))
      if (refused.length) {
        await pool.query('insert into refused_pushes (team_id, instance_id, repo_id, refs) values ($1, $2, $3, $4)',
          [instance.team_id, instance.id, repoId, refused])
        throw new HttpError(403, `on a repo with a policy a machine pushes only to its own task branches, so ${refused.join(', ')} was refused. Changes reach main only through a pull request the owner approves.`)
      }
    }
    // The branch rule asks the forge which branch is the default now.
    const defaultBranch = await fromForge(() => currentDefaultBranch(repo))
    if (refs.includes(`refs/heads/${defaultBranch}`)) {
      throw new HttpError(403, `machines push task branches, never ${defaultBranch}. Changes reach ${defaultBranch} through pull requests.`)
    }
    body = stream
  }
  const upstream = await fromForge(() => gitUpstreamFor(repo))
  headers.authorization = upstream.authorization
  // Node's fetch needs `duplex` to send a streamed body, and the DOM's RequestInit type has no field for it.
  const init: RequestInit & { duplex: 'half' } = { method: req.method, headers, body: req.method === 'GET' ? undefined : webStream(bytesOf(body)), duplex: 'half' }
  const response = await fetch(`${upstream.url}/${rest}${url.search}`, init)
  const out: Record<string, string> = {}
  response.headers.forEach((value, key) => { if (!DROPPED.includes(key)) out[key] = value })
  res.writeHead(response.status, out)
  // A forge that drops the connection mid-answer leaves the machine a cut-off
  // response, which git reports as a failed clone or push.
  if (response.body) Readable.from(response.body, { objectMode: false }).on('error', () => res.end()).pipe(res)
  else res.end()
}

// A push's body as git sent it, unzipped when it came gzipped. An error on the
// request reaches the unzipping too, or its reader would wait for bytes that
// never come.
export function plainBody(req: Readable, encoding: string | undefined): Readable {
  if (encoding !== 'gzip') return req
  const gunzip = createGunzip()
  req.on('error', (error) => { gunzip.destroy(error) })
  return req.pipe(gunzip)
}
