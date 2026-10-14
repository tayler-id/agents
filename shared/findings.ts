// What makes a later finding the same one a person overruled: its rule, as the
// rubric checks compare it, its path, and the sha256 of its body. A finding
// reworded is a new one. Kept out of shared/framework.ts, which the app's
// typecheck reads and which must not need Node's own modules.

import { createHash } from 'node:crypto'
import { ruleOf } from './framework.ts'

export const findingKey = (f: { rule: string; path: string | null; body: string }) =>
  `${ruleOf(f.rule)}\n${f.path ?? ''}\n${createHash('sha256').update(f.body.trim()).digest('hex')}`
