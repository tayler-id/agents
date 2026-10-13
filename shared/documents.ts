// Documents an agent writes in its task's folder: text, and images such as the
// screenshots it saves to show what it checked. The design is
// docs/design/computers.md.

import { z } from 'zod'
import { BlobId, TeamId } from './ids.ts'

// Raster images only. SVG can carry script, so it stays a text file.
export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export type ImageMediaType = z.infer<typeof ImageMediaType>

// A 1280x800 screenshot is well under 1 MB. Five leaves room for full-page
// captures, and as base64 still fits the API's 20 MB request limit. The
// migration's check on blobs.size_bytes matches it.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Text documents over this are skipped, as before images.
export const MAX_TEXT_BYTES = 1024 * 1024

// The image type the bytes themselves say, whatever the file is called, or null.
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // RIFF, four bytes of length, then WEBP.
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

// What a machine sends for each changed file in a task's folder. A text file
// carries its content, an image its bytes as base64.
export const DocumentUpload = z.union([
  z.object({ path: z.string().min(1), content: z.string() }),
  z.object({ path: z.string().min(1), image: z.object({ mediaType: ImageMediaType, base64: z.base64() }) }),
])
export type DocumentUpload = z.infer<typeof DocumentUpload>
export const DocumentUploads = z.object({ documents: z.array(DocumentUpload) })

// One row of blobs, without its bytes, which only the image route reads.
export const BlobRow = z.object({
  id: BlobId, team_id: TeamId, sha256: z.string().regex(/^[0-9a-f]{64}$/), media_type: ImageMediaType,
  size_bytes: z.int().min(1).max(MAX_IMAGE_BYTES), created_at: z.date(),
})
export type BlobRow = z.infer<typeof BlobRow>
