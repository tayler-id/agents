// What a session may do without asking a person, beyond the tools it is given.
// In a task's workspace the agent may change files inside it. On a box it may also
// run commands, since a box holds only its workspaces and its own instance token.
// A conversation's session asks for both. docs/design/workflow.md lists what
// still asks, and why.

import type pg from 'pg'
import { one } from './db.ts'
import type { Permissions } from '../shared/types.ts'

export const CONVERSATION_PERMISSIONS: Permissions = { workspaceWrites: false, commands: false }

export async function workspacePermissions(client: pg.PoolClient, instanceId: string): Promise<Permissions> {
  const instance = await one<{ kind: 'mac' | 'box' }>(client, `instance ${instanceId}`, 'select kind from instances where id = $1', [instanceId])
  return { workspaceWrites: true, commands: instance.kind === 'box' }
}
