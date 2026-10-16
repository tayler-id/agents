// Files in chats and tasks: what a person or an agent may upload, how an upload
// is named and typed, and what the API answers. The contract with the screens is
// docs/design/chat-attachments.md on branch ui.

import { z } from 'zod'
import { AgentId, ConversationId, MessageId, PersonId, SessionId, TeamId } from './ids.ts'
import { sniffImage, type ImageMediaType } from './documents.ts'

// The most one file may hold. A chat file is a screenshot or a document, and 25 MB
// is the cap the screens were told.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
// A post carries 1 to 10 files.
export const MAX_ATTACHMENTS_PER_POST = 10
// An upload that no post carries is deleted after this long.
export const PENDING_HOURS = 24
// The most bytes one person may have waiting to be sent. Eight full-size files fit, enough for any post, and a client
// stuck in a retry loop can't fill the server's disk with 24 hours of uploads.
export const MAX_PENDING_BYTES = 8 * MAX_ATTACHMENT_BYTES
// Longest file name kept, in bytes. Most file systems stop at 255, and a saved copy adds a 9-byte prefix.
const MAX_NAME_BYTES = 240

export const AttachmentId = z.uuid().brand<'AttachmentId'>()
export type AttachmentId = z.infer<typeof AttachmentId>

// The ids on a post: 1 to 10, each named once.
export const AttachmentIds = z.array(z.uuid()).min(1).max(MAX_ATTACHMENTS_PER_POST)
  .refine((ids) => new Set(ids).size === ids.length, 'each attachment can be named once')

// A person's post to a chat or a task's session: words, files, or both. The reply names the post it
// answers, in the same chat.
export const PostBody = z.object({
  text: z.string().nullish(),
  attachmentIds: AttachmentIds.nullish(),
  clientId: z.string().min(1).nullish(),
  replyToMessageId: z.uuid().nullish(),
}).refine((body) => (body.text ?? '').trim() !== '' || (body.attachmentIds ?? []).length > 0, { message: 'send text, attachmentIds, or both', path: ['text'] })

// What the upload route answers with. Width and height come with images whose size the bytes show.
export const UploadAnswer = z.object({
  attachmentId: AttachmentId,
  name: z.string(),
  mediaType: z.string(),
  size: z.int(),
  kind: z.enum(['image', 'file']),
  width: z.int().optional(),
  height: z.int().optional(),
})
export type UploadAnswer = z.infer<typeof UploadAnswer>

// A file name from a path or a header, reduced to a name that is safe to show and
// to put in a download header: no folders, no control characters, at most 255 bytes.
export function cleanFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? ''
  // Format characters such as U+202E turn the name around on screen, so `invoice<U+202E>fdp.exe` would read as a PDF.
  let name = last.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  while (new TextEncoder().encode(name).length > MAX_NAME_BYTES) name = name.slice(0, -1)
  return name === '' || name === '.' || name === '..' ? 'file' : name
}

// The media type a sender declared, or octet-stream when it is missing or malformed.
export function declaredType(header: string | undefined): string {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(type) ? type : 'application/octet-stream'
}

export type Sorted = { kind: 'image'; mediaType: ImageMediaType; width: number | null; height: number | null } | { kind: 'file'; mediaType: string; width: null; height: null }

// Whether bytes are a raster image, by the bytes alone, with the size they show.
// Anything else is a file, whatever its sender called it.
export function sortUpload(bytes: Uint8Array, declared: string): Sorted {
  const image = sniffImage(bytes)
  if (!image) return { kind: 'file', mediaType: declared, width: null, height: null }
  const size = imageSize(bytes, image)
  return { kind: 'image', mediaType: image, width: size?.width ?? null, height: size?.height ?? null }
}

const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const le24 = (b: Uint8Array, at: number) => le16(b, at) | ((b[at + 2] ?? 0) << 16)
const be32 = (b: Uint8Array, at: number) => (be16(b, at) * 65536) + be16(b, at + 2)

function imageSize(bytes: Uint8Array, type: ImageMediaType): { width: number; height: number } | null {
  const found = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)
  switch (type) {
    case 'image/png': return found(be32(bytes, 16), be32(bytes, 20))
    case 'image/gif': return found(le16(bytes, 6), le16(bytes, 8))
    case 'image/jpeg': return jpegSize(bytes)
    case 'image/webp': return webpSize(bytes)
  }
}

// A JPEG's size is in its first start-of-frame segment, after the other segments.
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1] ?? 0
    // C0 to CF are frames, except C4 (tables), C8 (reserved) and CC (arithmetic tables).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = be16(bytes, at + 5)
      const width = be16(bytes, at + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + be16(bytes, at + 2)
  }
  return null
}

// A WebP is lossy (VP8), lossless (VP8L) or extended (VP8X), each with its own header.
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (chunk === 'VP8X') return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
  if (chunk === 'VP8 ') return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

// The header value for a download. Non-ASCII names go in the encoded form, and
// the plain form keeps ASCII only, so old clients still get a name.
export function dispositionOf(kind: 'inline' | 'attachment', name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

// A row of attachments as the server reads it, with the bigints cast to numbers and text.
export const AttachmentRow = z.object({
  id: AttachmentId,
  team_id: z.uuid(),
  conversation_id: z.uuid().nullable(),
  session_id: z.uuid().nullable(),
  message_id: z.uuid().nullable(),
  event_id: z.string().nullable(),
  kind: z.enum(['image', 'file']),
  name: z.string(),
  media_type: z.string(),
  size: z.int(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  added_by_person: z.uuid().nullable(),
  added_by_agent: z.uuid().nullable(),
})
export type AttachmentRow = z.infer<typeof AttachmentRow>

// The rows of the three live shapes for chats and tasks, as the app reads them. The shapes' columns are these
// schemas' keys, so a column added here reaches the app and one left out stays on the server. Electric sends a
// bigint as a bigint.
export const AttachmentShapeRow = z.object({
  id: AttachmentId,
  conversation_id: ConversationId.nullable(),
  session_id: SessionId.nullable(),
  message_id: MessageId.nullable(),
  event_id: z.bigint().nullable(),
  kind: z.enum(['image', 'file']),
  name: z.string(),
  media_type: z.string(),
  size: z.bigint(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  added_by_person: PersonId.nullable(),
  added_by_agent: AgentId.nullable(),
  created_at: z.string(),
})
export type AttachmentShapeRow = z.infer<typeof AttachmentShapeRow>

export const ReactionId = z.uuid().brand<'ReactionId'>()
export type ReactionId = z.infer<typeof ReactionId>
export const ReactionShapeRow = z.object({
  id: ReactionId,
  conversation_id: ConversationId.nullable(),
  session_id: SessionId.nullable(),
  message_id: MessageId.nullable(),
  event_id: z.bigint().nullable(),
  emoji: z.string(),
  person_id: PersonId.nullable(),
  agent_id: AgentId.nullable(),
  created_at: z.string(),
})
export type ReactionShapeRow = z.infer<typeof ReactionShapeRow>

export const PinShapeRow = z.object({
  conversation_id: ConversationId,
  message_id: MessageId,
  team_id: TeamId,
  pinned_by: PersonId.nullable(),
  created_at: z.string(),
})
export type PinShapeRow = z.infer<typeof PinShapeRow>
