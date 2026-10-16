// How an agent's tools reach the record's file routes: sharing a file into the
// chat or task the session serves, and saving a file shared there to disk.
// Both the team-record and the computer MCP servers use it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { cleanFileName, UploadAnswer } from '../shared/attachments.ts'
import { parseJson } from '../shared/json.ts'

type Session = { api: string; token: string; session: string }

const ErrorBody = z.object({ error: z.string() })

async function failure(res: Response): Promise<Error> {
  const parsed = parseJson(ErrorBody, await res.text())
  return new Error(parsed.ok ? parsed.value.error : `the record answered ${res.status}`)
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
  const dir = join(folder, 'attachments')
  await mkdir(dir, { recursive: true })
  // The id leads the name, so two files with one name never overwrite each other.
  const path = join(dir, `${attachmentId.slice(0, 8)}-${name}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}
