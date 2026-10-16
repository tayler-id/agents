// How an agent's tools reach the record's file routes: sharing a file into the
// chat or task the session serves, and saving a file shared there to disk.
// Both the team-record and the computer MCP servers use it.

import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { cleanFileName, UploadAnswer } from '../shared/attachments.ts'
import { hasCode } from '../shared/errors.ts'
import { request } from 'node:http'
import { parseJson } from '../shared/json.ts'
import { ScanAnswer } from '../shared/secret-scan.ts'

type Session = { api: string; token: string; session: string }

const ErrorBody = z.object({ error: z.string() })

async function failure(res: Response): Promise<Error> {
  const parsed = parseJson(ErrorBody, await res.text())
  return new Error(parsed.ok ? parsed.value.error : `the record answered ${res.status}`)
}

// Asks the daemon on this machine which of its secrets the bytes hold. A machine whose daemon can't be reached
// shares nothing, since it can't be checked.
export function secretsHeld(guardSocket: string | undefined, bytes: Buffer, root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!guardSocket) {
      reject(new Error("This machine's daemon can't check a file for secrets, so nothing was shared."))
      return
    }
    const req = request({ socketPath: guardSocket, path: `/scan?${new URLSearchParams({ root })}`, method: 'POST' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const parsed = parseJson(ScanAnswer, Buffer.concat(chunks).toString('utf8'))
        if (res.statusCode === 200 && parsed.ok) resolve(parsed.value.names)
        else reject(new Error("This machine's daemon couldn't check the file for secrets, so nothing was shared."))
      })
    })
    req.on('error', () => { reject(new Error("This machine's daemon can't check a file for secrets, so nothing was shared.")) })
    req.end(bytes)
  })
}

// Posts a file's bytes under its name, with a caption, into the session's chat or task page.
export async function shareBytes(on: Session, file: { bytes: Buffer; name: string; contentType: string; caption: string }): Promise<UploadAnswer> {
  const query = new URLSearchParams({ session: on.session, caption: file.caption })
  const res = await fetch(`${on.api}/v1/record/share?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${on.token}`, 'content-type': file.contentType, 'x-file-name': encodeURIComponent(file.name) },
    body: new Uint8Array(file.bytes),
  })
  if (!res.ok) throw await failure(res)
  const parsed = parseJson(UploadAnswer, await res.text())
  if (!parsed.ok) throw new Error(`the record sent something unexpected: ${parsed.reason}`)
  return parsed.value
}

// Saves a file shared in the session's chat or task under `attachments/` in the given folder, and returns its path.
export async function saveShared(on: Session, folder: string, attachmentId: string): Promise<string> {
  const res = await fetch(`${on.api}/v1/record/attachments/${attachmentId}?${new URLSearchParams({ session: on.session })}`, {
    headers: { authorization: `Bearer ${on.token}` },
  })
  if (!res.ok) throw await failure(res)
  const header = res.headers.get('x-file-name')
  const name = cleanFileName(header ? decodeURIComponent(header) : attachmentId)
  // One folder for each session, since an agent's chats share one working folder and a file saved for one
  // chat must not be there for the others to share.
  const dir = join(folder, 'attachments', on.session)
  // A link in a folder's place would send the file wherever it points.
  const linked = await lstat(join(folder, 'attachments')).then((info) => info.isSymbolicLink(), (error: unknown) => {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  })
  if (linked) throw new Error(`${join(folder, 'attachments')} is a link, so nothing was saved`)
  await mkdir(dir, { recursive: true })
  const bytes = Buffer.from(await res.arrayBuffer())
  // The id leads the name, so two files with one name never overwrite each other.
  const path = join(dir, `${attachmentId.slice(0, 8)}-${name}`)
  await writeFile(path, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
    if (!hasCode(error, 'EEXIST')) throw error
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a link, so nothing was saved`)
    await writeFile(path, bytes)
  })
  return path
}
