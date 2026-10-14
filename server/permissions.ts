// What a session may do without asking a person, beyond the tools it is given.
// In a task's workspace the agent may change files inside it. Commands ask on a
// Mac and on a box alike. A box holds its workspaces, its machine token and a
// Claude token, the team's or its owner's own, and letting commands run there
// without asking is Tayler's call. A conversation's session asks for both.
// docs/design/workflow.md lists what still asks, and why.

import type { Permissions } from '../shared/types.ts'

export const CONVERSATION_PERMISSIONS: Permissions = { workspaceWrites: false }
export const WORKSPACE_PERMISSIONS: Permissions = { workspaceWrites: true }
