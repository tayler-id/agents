// Connects a folder on this Mac, so every Claude Code session its person starts
// in it from a terminal lands in the team's record, or disconnects one. Run it
// on the Mac, where the daemon's token is:
//   node daemon/folders.ts                                  lists the connected folders
//   node daemon/folders.ts connect [folder] [--private | --team]   the folder defaults to the current one
//   node daemon/folders.ts disconnect [folder]
// A folder is the team's when first connected, and --private keeps its sessions
// to you. Connecting it again keeps whichever it is, unless --private or --team
// says otherwise. Your home folder, and any folder above it, can't be connected,
// since it holds every project you have. --json prints the answer as JSON.
// Exit codes: 0 done, 1 failed and safe to retry, 2 usage, 3 refused with nothing changed.
// The Agents app on the Mac connects folders through the daemon's socket,
// daemon/app-socket.ts, which calls the functions exported here.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { messageOf } from '../shared/errors.ts'
import { ConnectAnswer, FolderAnswer, FolderList, holdsHome, type FolderRow, type FolderVisibility } from '../shared/terminal.ts'
import { ApiError, apiClient, loadConfig, type Api } from './api.ts'
import { projectName } from './transcripts.ts'

// A connect or disconnect that changed nothing: the folder can't be used as given,
// it is the home folder or holds it, or the API refused it.
export class FolderRefused extends Error {
  readonly kind: 'usage' | 'home' | 'api'
  constructor(kind: 'usage' | 'home' | 'api', message: string) {
    super(message)
    this.kind = kind
  }
}

// The folder as Claude Code records it: links resolved, and each name in the case
// it has on disk, since Claude Code writes the path the system gives back. On a
// case-insensitive volume, the case a person typed would match no transcript.
export function folderPath(given: string, mustExist: boolean): string {
  const path = resolve(given)
  if (!existsSync(path)) {
    if (mustExist) throw new FolderRefused('usage', `${path} does not exist.`)
    return path
  }
  if (!statSync(path).isDirectory()) throw new FolderRefused('usage', `${path} is not a folder.`)
  return realpathSync.native(path)
}

// Claude Code shortens a transcript folder's name past this length, and the daemon would never find it.
const LONGEST_NAME = 200

// The API refused, and changed nothing. Anything else, such as the API being down, can be tried again.
async function asked(call: Promise<unknown>): Promise<unknown> {
  try {
    return await call
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw new FolderRefused('api', messageOf(error))
    throw error
  }
}

export type Connected = ConnectAnswer & { path: string; warnings: string[] }

// Connects a folder, or changes who sees its sessions. With no visibility, a
// folder connected before keeps its own, and a new one is the team's. The
// warnings say what will keep its sessions from landing.
export async function connectFolder(api: Api, given: string, visibility: FolderVisibility | undefined): Promise<Connected> {
  const path = folderPath(given, true)
  if (holdsHome(path, realpathSync.native(homedir()))) {
    throw new FolderRefused('home', `${path} is your home folder or holds it, so every Claude Code session you start under it would land in the record.`)
  }
  const answer = ConnectAnswer.parse(await asked(api('POST', '/v1/instance/folders', visibility === undefined ? { path } : { path, visibility })))
  const name = projectName(path)
  const warnings = name.length > LONGEST_NAME
    ? [`the folder's transcript folder name is ${name.length} characters, and Claude Code shortens names past ${LONGEST_NAME}, so its sessions will not land.`]
    : []
  return { ...answer, path, warnings }
}

export async function disconnectFolder(api: Api, given: string): Promise<FolderAnswer & { path: string }> {
  const path = folderPath(given, false)
  return { ...FolderAnswer.parse(await asked(api('POST', '/v1/instance/folders/disconnect', { path }))), path }
}

export async function connectedFolders(api: Api): Promise<FolderList> {
  return FolderList.parse(await asked(api('GET', '/v1/instance/folders')))
}

// The folders command itself, when this file is run rather than imported.
async function main() {
  const USAGE = 'usage: node daemon/folders.ts [connect [folder] [--private | --team] | disconnect [folder]] [--json]'
  const SELF = 'node daemon/folders.ts'

  const args = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const [verb, folderArg, ...extra] = args.filter((a) => !a.startsWith('--'))
  const json = flags.has('--json')

  function exit(code: 0 | 1 | 2 | 3, text: string, answer?: unknown): never {
    if (json) console.log(JSON.stringify(code === 0 ? { ok: true, ...(typeof answer === 'object' ? answer : {}) } : { ok: false, error: text }))
    else (code === 0 ? console.log : console.error)(text)
    process.exit(code)
  }

  const known = verb === undefined || verb === 'connect' || verb === 'disconnect'
  const allowedFlags = verb === 'connect' ? ['--json', '--private', '--team'] : ['--json']
  if (!known || extra.length || (verb === undefined && folderArg !== undefined) || [...flags].some((f) => !allowedFlags.includes(f))
    || (flags.has('--private') && flags.has('--team'))) exit(2, USAGE)

  const who = (folder: FolderRow) => (folder.visibility === 'team' ? 'the team sees its sessions' : 'only you see its sessions')

  // Where the daemon looks for the folder's transcripts, and what can keep them
  // from it. The daemon runs under launchd, so this shell's CLAUDE_CONFIG_DIR isn't its.
  function whereTranscripts(path: string): { transcripts: string; warnings: string[] } {
    const transcripts = join(homedir(), '.claude', 'projects', projectName(path))
    const warnings: string[] = []
    const own = process.env.CLAUDE_CONFIG_DIR
    if (own !== undefined && resolve(own) !== join(homedir(), '.claude')) {
      warnings.push(`this shell sets CLAUDE_CONFIG_DIR, so Claude Code started from it writes transcripts under ${join(resolve(own), 'projects')}. `
        + 'The daemon reads ~/.claude/projects unless its own environment sets CLAUDE_CONFIG_DIR to the same folder, so those sessions will not land until it does.')
    }
    return { transcripts, warnings }
  }

  const api = apiClient((() => {
    try {
      return loadConfig()
    } catch (error) {
      return exit(2, `${messageOf(error)}. The daemon's token is what lets this Mac connect folders.`)
    }
  })())

  try {
    if (verb === undefined) {
      const { folders } = await connectedFolders(api)
      if (!folders.length) exit(0, `No folder on this Mac is connected.\nnext: ${SELF} connect <folder>`, { folders })
      exit(0, folders.map((f) => `${f.path}  ${who(f)}, since ${f.connected_at}`).join('\n'), { folders })
    }
    if (verb === 'connect') {
      // With neither flag, the API keeps the folder's own visibility, so a bare connect never widens a private folder.
      const visibility = flags.has('--private') ? 'private' : flags.has('--team') ? 'team' : undefined
      const { path, warnings: nameWarnings, ...answer } = await connectFolder(api, folderArg ?? process.cwd(), visibility)
      const shown = answer.exposed ? ` The team now sees the ${answer.exposed} session${answer.exposed === 1 ? '' : 's'} already in the record from it.` : ''
      const where = whereTranscripts(path)
      const warnings = [...where.warnings, ...nameWarnings]
      const notes = [`transcripts: the daemon reads ${where.transcripts}, and the folders whose names start with it`, ...warnings.map((w) => `warning: ${w}`)].join('\n')
      exit(0, answer.already
        ? `ok: ${path} was already connected, and ${who(answer.folder)}.\n${notes}\nalready: true`
        : `ok: connected ${path}. Claude Code sessions you start in it from now on land in the record, and ${who(answer.folder)}.${shown}\n${notes}\nnext: ${SELF} disconnect ${path}`,
      { ...answer, transcripts: where.transcripts, warnings })
    }
    const { path, ...answer } = await disconnectFolder(api, folderArg ?? process.cwd())
    exit(0, answer.already
      ? `ok: ${path} was already disconnected.\nalready: true`
      : `ok: disconnected ${path}. Its sessions stay on this Mac from now on.\nnext: ${SELF} connect ${path}`,
    answer)
  } catch (error) {
    if (error instanceof FolderRefused) {
      if (error.kind === 'usage') exit(2, error.message)
      exit(3, error.kind === 'home' ? `${error.message}\nnext: ${SELF} connect <the folder of one project>` : error.message)
    }
    exit(1, `${messageOf(error)}\nnext: check the daemon's API is up, then run this again.`)
  }
}

if (import.meta.main) await main()
