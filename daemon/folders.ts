// Connects a folder on this Mac, so every Claude Code session its person starts
// in it from a terminal lands in the team's record, or disconnects one. Run it
// on the Mac, where the daemon's token is:
//   node daemon/folders.ts                                  lists the connected folders
//   node daemon/folders.ts connect [folder] [--private]     the folder defaults to the current one
//   node daemon/folders.ts disconnect [folder]
// --private keeps the folder's sessions to you. --json prints the answer as JSON.
// Exit codes: 0 done, 1 failed and safe to retry, 2 usage, 3 refused with nothing changed.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { messageOf } from '../shared/errors.ts'
import { FolderAnswer, FolderList, type FolderRow } from '../shared/terminal.ts'
import { ApiError, apiClient, loadConfig } from './api.ts'

const USAGE = 'usage: node daemon/folders.ts [connect [folder] [--private] | disconnect [folder]] [--json]'
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
const allowedFlags = verb === 'connect' ? ['--json', '--private'] : ['--json']
if (!known || extra.length || (verb === undefined && folderArg !== undefined) || [...flags].some((f) => !allowedFlags.includes(f))) exit(2, USAGE)

// The folder as Claude Code records it, with links resolved, since it writes the real path.
function folderPath(given: string | undefined, mustExist: boolean): string {
  const path = resolve(given ?? process.cwd())
  if (!existsSync(path)) {
    if (mustExist) exit(2, `${path} does not exist.`)
    return path
  }
  if (!statSync(path).isDirectory()) exit(2, `${path} is not a folder.`)
  return realpathSync(path)
}

const who = (folder: FolderRow) => (folder.visibility === 'team' ? 'the team sees its sessions' : 'only you see its sessions')

const api = apiClient((() => {
  try {
    return loadConfig()
  } catch (error) {
    return exit(2, `${messageOf(error)}. The daemon's token is what lets this Mac connect folders.`)
  }
})())

try {
  if (verb === undefined) {
    const { folders } = FolderList.parse(await api('GET', '/v1/instance/folders'))
    if (!folders.length) exit(0, `No folder on this Mac is connected.\nnext: ${SELF} connect <folder>`, { folders })
    exit(0, folders.map((f) => `${f.path}  ${who(f)}, since ${f.connected_at}`).join('\n'), { folders })
  }
  if (verb === 'connect') {
    const path = folderPath(folderArg, true)
    const visibility = flags.has('--private') ? 'private' : 'team'
    const answer = FolderAnswer.parse(await api('POST', '/v1/instance/folders', { path, visibility }))
    exit(0, answer.already
      ? `ok: ${path} was already connected, and ${who(answer.folder)}.\nalready: true`
      : `ok: connected ${path}. Claude Code sessions you start in it from now on land in the record, and ${who(answer.folder)}.\nnext: ${SELF} disconnect ${path}`,
    answer)
  }
  const path = folderPath(folderArg, false)
  const answer = FolderAnswer.parse(await api('POST', '/v1/instance/folders/disconnect', { path }))
  exit(0, answer.already
    ? `ok: ${path} was already disconnected.\nalready: true`
    : `ok: disconnected ${path}. Its sessions stay on this Mac from now on.\nnext: ${SELF} connect ${path}`,
  answer)
} catch (error) {
  // The API refused, and changed nothing. Anything else, such as the API being down, can be tried again.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) exit(3, messageOf(error))
  exit(1, `${messageOf(error)}\nnext: check the daemon's API is up, then run this again.`)
}
