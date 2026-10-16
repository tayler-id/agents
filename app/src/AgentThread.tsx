import { useMemo } from 'react'
import { conversationLabel, useSnapshot, type Agent, type Conversation, type Me, type Member } from './data.ts'

// How often an open thread looks again for its two agents' names.
const MEMBERS_POLL_MS = 10000

// A thread between two agents reads as any conversation does, by the two agents'
// names, and has no composer, since people read it and do not post to it. Null
// for any other conversation.
export function useThreadName(conversation: Conversation | undefined, agents: Agent[], me: Me): string | null {
  const thread = conversation?.kind === 'agents'
  const { rows: members } = useSnapshot<Member>('conversation_members', thread ? {} : null, MEMBERS_POLL_MS)
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  return conversation && thread ? conversationLabel(conversation, { me, members, agentName, login: new Map() }) : null
}

// What sits where a thread's composer would.
export function ThreadNote() {
  return <p className="thread-note muted small">Only the two agents write here. Each message is a turn for the other, and its answer goes back to the one that asked.</p>
}
