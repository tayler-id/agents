// Reactions: one emoji on a chat message or on a task post, by a person or by an
// agent. Putting a reaction that is there, or removing one that is not, changes
// nothing and answers the same way.

import type pg from 'pg'
import { canSeeConversation, canSeeSession } from './access.ts'
import { many, maybe } from './db.ts'
import { HttpError, type Person } from './record.ts'

export type ReactionTarget = { kind: 'message'; id: string } | { kind: 'event'; id: string }
type Reactor = { personId: string } | { agentId: string }

// A reaction's target as the row of the post it is on.
type Post = { team_id: string; conversation_id: string | null; session_id: string | null; deleted: boolean }

async function postOf(client: pg.PoolClient, teamId: string, target: ReactionTarget): Promise<Post | undefined> {
  return target.kind === 'message'
    ? maybe<Post>(client,
      'select team_id, conversation_id, null::uuid as session_id, deleted_at is not null as deleted from messages where id = $1 and team_id = $2', [target.id, teamId])
    // Only a task's session has posts to react to. A chat's session holds the prompts behind its messages.
    : maybe<Post>(client,
      `select e.team_id, null::uuid as conversation_id, e.session_id, false as deleted
       from events e join sessions s on s.id = e.session_id where e.id = $1 and e.team_id = $2 and s.task_id is not null`, [target.id, teamId])
}

async function react(client: pg.PoolClient, post: Post, reactor: Reactor, target: ReactionTarget, emoji: string, on: boolean) {
  const message = target.kind === 'message' ? target.id : null
  const event = target.kind === 'event' ? target.id : null
  const person = 'personId' in reactor ? reactor.personId : null
  const agent = 'agentId' in reactor ? reactor.agentId : null
  if (on) {
    if (post.deleted) throw new HttpError(409, 'That post was deleted.')
    await client.query(
      `insert into reactions (team_id, conversation_id, session_id, message_id, event_id, emoji, person_id, agent_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
      [post.team_id, post.conversation_id, post.session_id, message, event, emoji, person, agent])
  } else {
    await client.query(
      `delete from reactions where emoji = $1 and message_id is not distinct from $2 and event_id is not distinct from $3
         and person_id is not distinct from $4 and agent_id is not distinct from $5`,
      [emoji, message, event, person, agent])
  }
  return { reacted: on }
}

// A person's reaction. They must be able to see the chat or the task the post is in.
export async function reactAsPerson(client: pg.PoolClient, person: Person, target: ReactionTarget, emoji: string, on: boolean) {
  const post = await postOf(client, person.team_id, target)
  const visible = post && (post.conversation_id !== null ? await canSeeConversation(person, post.conversation_id)
    : post.session_id !== null && await canSeeSession(person, post.session_id))
  if (!post || !visible) throw new HttpError(404, 'no such post')
  return react(client, post, { personId: person.id }, target, emoji, on)
}

// An agent's reaction, from inside one of its sessions. It may react in its own chat, and in its own
// task's sessions.
export async function reactAsAgent(client: pg.PoolClient, session: { id: string; team_id: string; agent_id: string }, target: ReactionTarget, emoji: string, on: boolean) {
  const post = await postOf(client, session.team_id, target)
  const here = post && await maybe(client,
    `select 1 from sessions s where s.id = $1
       and (s.conversation_id = $2 or s.id = $3 or (s.task_id is not null and s.task_id = (select task_id from sessions where id = $3)))`,
    [session.id, post.conversation_id, post.session_id])
  if (!post || !here) throw new HttpError(404, 'no such post in your chat or task')
  return react(client, post, { agentId: session.agent_id }, target, emoji, on)
}

// The post an agent means when it names none: the latest from a person in its chat, or in its task's session.
export async function latestPersonPost(client: pg.PoolClient, sessionId: string): Promise<ReactionTarget> {
  const message = await maybe<{ id: string }>(client,
    `select m.id from messages m join sessions s on s.conversation_id = m.conversation_id
     where s.id = $1 and m.speaker = 'person' and m.deleted_at is null order by m.seq desc limit 1`, [sessionId])
  if (message) return { kind: 'message', id: message.id }
  const event = await maybe<{ id: string }>(client, `select id from events where session_id = $1 and kind = 'user' order by seq desc limit 1`, [sessionId])
  if (event) return { kind: 'event', id: event.id }
  throw new HttpError(404, 'there is no post from a person to react to yet')
}

// What people and other agents have reacted with on this agent's posts since it was last told, as a
// line each, and marks them told. Empty when there is nothing new.
export async function reactionsNote(client: pg.PoolClient, agentId: string, scope: { conversationId: string } | { sessionId: string }): Promise<string> {
  const rows = await many<{ id: string; who: string; emoji: string; post: string }>(client,
    `select r.id, coalesce(p.login, a.name, 'someone') as who, r.emoji,
       left(coalesce(m.body, e.text, ''), 80) as post
     from reactions r
     left join people p on p.id = r.person_id
     left join agents a on a.id = r.agent_id
     left join messages m on m.id = r.message_id
     left join events e on e.id = r.event_id
     where r.told_agent_at is null and r.agent_id is distinct from $1
       and ((m.id is not null and m.agent_id = $1 and m.deleted_at is null and m.conversation_id = $2)
         or (e.id is not null and (e.kind = 'assistant' or e.body->>'subtype' = 'share') and e.session_id = $3))
     order by r.created_at, r.id`,
    [agentId, 'conversationId' in scope ? scope.conversationId : null, 'sessionId' in scope ? scope.sessionId : null])
  if (rows.length === 0) return ''
  await client.query('update reactions set told_agent_at = now() where id = any($1)', [rows.map((r) => r.id)])
  return `Reactions on your posts since your last turn:\n${rows.map((r) => `- ${r.who} reacted ${r.emoji} to your post "${r.post}"`).join('\n')}`
}
