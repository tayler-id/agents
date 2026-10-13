// What every agentsctl command prints with --json: one envelope, with the
// command's own data inside. Checks and the framework's runner parse it with
// these schemas, so they read exactly what the CLI wrote.

import { z } from 'zod'
import { Json } from './db.ts'

export const Output = z.object({
  ok: z.boolean(),
  command: z.string(),
  summary: z.string(),
  // Files the command wrote as evidence.
  files: z.array(z.string()),
  data: Json,
})
export type Output = z.infer<typeof Output>

// Exit codes: 0 when the command did what it says and found nothing wrong, 1 when
// it ran and something failed, 2 when the command line itself is wrong.
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

export class UsageError extends Error {}
