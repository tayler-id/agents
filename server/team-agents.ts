// What an agent does with its team's other agents, from inside one of its
// sessions: sees who they are, messages one, hands one a task, reports the result
// of a task handed to it, and makes a new agent once its owner says yes. The API
// calls these for the session's team-agents tools, and they check everything
// themselves, whatever the tool's server sent: who may message whom, the chain's
// hop limit, and the yes behind a new agent. The design is "Agents creating,
// messaging and delegating to agents" in docs/design/target-architecture.md.

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { isUniqueViolation, many, maybe, one, tx } from './db.ts'
import { appendMessage, conversationSession, HttpError, scrub } from './record.ts'
import { insertAgent } from './agents.ts'
import { slugOf } from './tasks.ts'
import { launchHandedTask } from './launch.ts'
import { CHAIN_ORIGIN, deliverTaskResult, sendAgentTurn } from './agent-turns.ts'
import { sameInput } from './durability.ts'
import { AgentId, ConversationId, SessionId, TaskId, TeamId, TurnId } from '../shared/ids.ts'
import { InstanceId, PersonId } from '../shared/onboarding.ts'
import {
  AcceptsAgents, CREATE_AGENT_TOOL, MAX_HOPS, MAX_SENDS_PER_TURN, NewAgentAsk,
  type AgentMade, type DelegateTask, type MessageSent, type Reported, type ReportBack, type SendToAgent, type TaskHanded, type TeamAgents,
} from '../shared/team-agents.ts'

// The session a tool call comes from, with its agent and that agent's owner.
const CallerRow = z.object({
  id: SessionId, team_id: TeamId, agent_id: AgentId, name: z.string(), owner_id: PersonId.nullable(), owner_login: z.string().nullable(),
  home_instance_id: InstanceId.nullable(), conversation_id: ConversationId.nullable(), task_id: TaskId.nullable(), stage: z.string().nullable(),
  conversation_kind: z.string().nullable(), visibility: z.enum(['team', 'private']).nullable(),
})
type Caller = z.infer<typeof CallerRow>

// The agent session `sessionId`, on the calling machine's team.
export async function callerOf(client: pg.PoolClient, teamId: string, sessionId: string): Promise<Caller> {
  const row = await maybe(client,
    `select s.id, s.team_id, s.agent_id, a.name, a.owner_id, p.login as owner_login, a.home_instance_id, s.conversation_id, s.task_id, s.stage,
       c.kind as conversation_kind, coalesce(c.visibility, t.visibility) as visibility
     from sessions s join agents a on a.id = s.agent_id left join people p on p.id = a.owner_id
       left join conversations c on c.id = s.conversation_id left join tasks t on t.id = s.task_id
     where s.id = $1 and s.team_id = $2`, [sessionId, teamId])
  if (!row) throw new HttpError(404, 'no agent session of this team')
  return CallerRow.parse(row)
}

// Another agent of the team, as a message to it needs it.
const Target = z.object({
  id: AgentId, name: z.string(), owner_id: PersonId.nullable(), owner_login: z.string().nullable(), accepts_agents: AcceptsAgents,
  home_instance_id: InstanceId.nullable(), harness: z.enum(['claude', 'codex']), model: z.string().nullable(), title: z.string().nullable(),
})
type Target = z.infer<typeof Target>
const TARGET = `select a.id, a.name, a.owner_id, p.login as owner_login, a.accepts_agents, a.home_instance_id, a.harness, a.model, a.title
  from agents a left join people p on p.id = a.owner_id where a.team_id = $1 and a.archived_at is null`

// An agent messages its owner's other agents freely, and another person's agent
// only when that person lets the team's agents in, Tayler's call on 2026-10-16.
// A message runs a turn on its owner's Claude account.
const mayMessage = (caller: Caller, target: Target) =>
  (caller.owner_id !== null && caller.owner_id === target.owner_id) || target.accepts_agents === 'team'

export async function listAgents(client: pg.PoolClient, caller: Caller): Promise<TeamAgents> {
  const rows = z.array(Target).parse(await many(client, `${TARGET} order by a.name`, [caller.team_id]))
  return {
    agents: rows.map((agent) => ({
      name: agent.name, title: agent.title, owner: agent.owner_login, you: agent.id === caller.agent_id,
      takesYourMessages: agent.id !== caller.agent_id && mayMessage(caller, agent),
    })),
  }
}

// The turn a message or a handed-over task is sent from: the one the session runs
// now. A session that took in two messages at once runs two, and the one furthest
// down its chain counts, so no chain gets past its limit that way. Only a
// conversation or a task the team shares sends, since the thread between two
// agents is the team's to read, and a room or a pipeline stage does not, since
// an answer would come back outside the room's turns or the stage's.
async function sendingTurn(client: pg.PoolClient, caller: Caller): Promise<{ id: TurnId; hops: number; origin: ConversationId | null }> {
  if (caller.stage !== null) throw new HttpError(403, 'A pipeline stage does not message other agents.')
  if (caller.conversation_kind === 'room') throw new HttpError(409, 'Agents in a room cannot message other agents yet. Say what you need in the room instead.')
  if (caller.visibility === 'private') {
    throw new HttpError(409, 'The work this session serves is private, and what agents send each other is read by the whole team, so nothing was sent.')
  }
  const turn = await maybe(client,
    `select id, hops, ${CHAIN_ORIGIN} as origin from turns where session_id = $1 and status = 'running' order by hops desc, requested_at desc, id desc limit 1`, [caller.id])
  if (!turn) throw new HttpError(409, 'This session has no turn running, so it cannot message another agent now.')
  return z.object({ id: TurnId, hops: z.number().int(), origin: ConversationId.nullable() }).parse(turn)
}

// The hop a message or a task from `turn` would be, when the chain has room for it.
// A refusal puts a note in the conversation the chain started in, if it started in
// one, and that note is written on its own connection so it stays when the
// request's transaction rolls back. Asking again after the same turn's refusal
// writes nothing new, since the note's client id is the turn's.
async function nextHop(caller: Caller, turn: { id: TurnId; hops: number; origin: ConversationId | null }): Promise<number> {
  const hops = turn.hops + 1
  if (hops > MAX_HOPS) {
    if (turn.origin !== null) {
      const origin = turn.origin
      await tx((client) => appendMessage(client, origin, {
        speaker: 'agent', agentId: caller.agent_id, body: `${caller.name} stopped a chain of agents at ${MAX_HOPS} hops`,
        clientId: `chain-stopped:${turn.id}`, kind: 'chain_stopped',
      }))
    }
    throw new HttpError(409, `This would be hop ${hops} of the chain, and a chain of agents stops after ${MAX_HOPS} hops, so nothing was sent. Answer with what you have.`)
  }
  return hops
}

// Refuses the send or hand-off that would be the 6th of one harness turn. A session
// that took in a second message while it ran has two running turns for one harness
// turn, so what both sent counts together. Messages a turn sent are the turns that
// answer to it, and tasks it handed over name it as theirs. Two sends at once wait
// for each other on the lock, so neither slips past.
async function checkFanout(client: pg.PoolClient, caller: Caller) {
  // An advisory lock, not the session's row. A send goes on to lock the target's session,
  // and two agents sending to each other at once would wait for each other's rows.
  await client.query(`select pg_advisory_xact_lock(hashtext('fanout:' || $1))`, [caller.id])
  const sent = await one<{ n: number }>(client, 'the count of what the turn sent',
    `with running as (select id from turns where session_id = $1 and status = 'running')
     select ((select count(*) from turns where answer_to_turn in (select id from running) and source = 'agent')
           + (select count(*) from tasks where asked_by_turn in (select id from running)))::int as n`, [caller.id])
  if (sent.n >= MAX_SENDS_PER_TURN) {
    throw new HttpError(409, `This turn has sent ${MAX_SENDS_PER_TURN} messages and tasks already, and one turn sends at most ${MAX_SENDS_PER_TURN}, so nothing was sent. Answer with what you have.`)
  }
}

// The agent a message or a task goes to, when it may.
async function reachable(client: pg.PoolClient, caller: Caller, name: string): Promise<Target & { home_instance_id: InstanceId }> {
  const found = await maybe(client, `${TARGET} and a.name = $2`, [caller.team_id, name])
  if (!found) throw new HttpError(404, `No agent on your team is named ${name}. list_agents shows who is.`)
  const target = Target.parse(found)
  if (target.id === caller.agent_id) throw new HttpError(400, `${name} is you.`)
  if (!mayMessage(caller, target)) {
    throw new HttpError(403, target.owner_login === null
      ? `${name} has no owner, so it takes no messages from agents until an admin lets the team's agents message it.`
      : `${name} is ${target.owner_login}'s agent, and ${target.owner_login} has not let other people's agents message it. They can allow it on ${name}'s page.`)
  }
  const home = target.home_instance_id
  if (home === null) throw new HttpError(409, `${name} has no machine to run on.`)
  return { ...target, home_instance_id: home }
}

// The thread between two agents, made the first time one messages the other. One
// pair's lookup and making wait for each other, so a pair never gets two threads.
async function threadOf(client: pg.PoolClient, teamId: TeamId, a: AgentId, b: AgentId): Promise<ConversationId> {
  const [first, second] = [a, b].sort()
  await client.query(`select pg_advisory_xact_lock(hashtext('agents-thread:' || $1 || ':' || $2))`, [first, second])
  const found = await maybe(client,
    `select c.id from conversations c where c.team_id = $1 and c.kind = 'agents' and c.archived_at is null
       and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.agent_id = $2)
       and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.agent_id = $3)
     order by c.created_at, c.id limit 1`, [teamId, first, second])
  if (found) return z.object({ id: ConversationId }).parse(found).id
  const made = z.object({ id: ConversationId }).parse(await one(client, 'the new thread',
    `insert into conversations (team_id, kind) values ($1, 'agents') returning id`, [teamId]))
  await client.query('insert into conversation_members (team_id, conversation_id, agent_id) values ($1, $2, $3), ($1, $2, $4)', [teamId, made.id, first, second])
  return made.id
}

// One agent's message to another. It goes into their thread, and to the other
// agent as a turn in its session there. The tool returns at once, and the answer
// comes back to the sending turn's session when the other agent's turn ends.
export async function sendToAgent(client: pg.PoolClient, caller: Caller, ask: SendToAgent): Promise<MessageSent> {
  const turn = await sendingTurn(client, caller)
  const hops = await nextHop(caller, turn)
  await checkFanout(client, caller)
  const target = await reachable(client, caller, ask.to)
  const threadId = await threadOf(client, caller.team_id, caller.agent_id, target.id)
  const message = await appendMessage(client, threadId, {
    speaker: 'agent', agentId: caller.agent_id, body: ask.text, clientId: `agent:${randomUUID()}`, sessionId: caller.id,
  })
  const session = await conversationSession(client, caller.team_id, null, threadId, target)
  const text = `${caller.name} sent you a message, in your thread with ${caller.name}:\n\n${ask.text}\n\n`
    + `What you say last in this turn goes back to ${caller.name} as your answer.`
  const turnId = await sendAgentTurn(client, SessionId.parse(session.id), { text, clientId: `message:${message.id}`, links: { messageId: message.id } }, caller.agent_id,
    { source: 'agent', askedBySession: caller.id, answerTo: turn.id, hops, originConversation: turn.origin })
  if (turnId === null) throw new Error(`message ${message.id} reached ${target.name}'s session before it was sent`)
  return { threadId, turnId, hops }
}

// A task one agent hands another. It is a task like one a person starts, with
// its own workspace and session, and its result goes back to the turn that
// handed it over when its agent reports back or a person marks it done.
export async function delegateTask(client: pg.PoolClient, caller: Caller, ask: DelegateTask): Promise<TaskHanded> {
  const turn = await sendingTurn(client, caller)
  const hops = await nextHop(caller, turn)
  await checkFanout(client, caller)
  const target = await reachable(client, caller, ask.to)
  const task = z.object({ id: TaskId }).parse(await one(client, 'the handed-over task',
    `insert into tasks (team_id, slug, title, instructions, owner_id, agent_id, source, asked_by_turn)
     values ($1, $2, $3, $4, $5, $6, 'agent', $7) returning id`,
    [caller.team_id, slugOf(ask.title), ask.title, ask.instructions, caller.owner_id, target.id, turn.id]))
  const sessionId = await launchHandedTask(client, task.id, { agentId: caller.agent_id, name: caller.name },
    { source: 'delegation', askedBySession: caller.id, answerTo: null, hops, originConversation: turn.origin })
  return { taskId: task.id, sessionId, hops }
}

// The result of a task another agent handed this session's agent. It goes back
// to that agent, and the task is done.
export async function reportBack(client: pg.PoolClient, caller: Caller, ask: ReportBack): Promise<Reported> {
  if (caller.task_id === null) throw new HttpError(409, 'report_back is for a task another agent handed you, and this session serves no task. Say it in your reply instead.')
  const found = await one(client, `task ${caller.task_id}`,
    `select t.id, t.title, t.asked_by_turn, t.done_at is not null as done, a.name as asker
     from tasks t left join turns r on r.id = t.asked_by_turn left join agents a on a.id = r.agent_id where t.id = $1 for update of t`, [caller.task_id])
  const task = z.object({ id: TaskId, title: z.string(), asked_by_turn: TurnId.nullable(), done: z.boolean(), asker: z.string().nullable() }).parse(found)
  if (task.asked_by_turn === null || task.asker === null) {
    throw new HttpError(409, 'No agent handed you this task, so nobody waits for a report. Say it in your reply instead.')
  }
  if (task.done) throw new HttpError(409, 'This task is done, and its result went back already. A person can reopen it.')
  await client.query('update tasks set done_at = now() where id = $1', [task.id])
  const turnId = await deliverTaskResult(client, { id: task.id, agentId: caller.agent_id, askedByTurn: task.asked_by_turn },
    `${caller.name} finished the task you handed it, "${task.title}":\n\n${ask.text}`, ask.text, caller.id)
  return { to: task.asker, turnId }
}

// A new agent, which this session's agent asked for and its owner said yes to.
// The engine asks before every create_agent call, and this refuses one with no
// answered yes behind it, from the owner, for exactly this agent, that has not
// made an agent already. So an engine that runs tools without asking still cannot
// make one. The new agent is the owner's, on the asking agent's machine.
export async function makeAgent(client: pg.PoolClient, caller: Caller, raw: Record<string, unknown>): Promise<AgentMade> {
  if (caller.owner_id === null || caller.owner_login === null) throw new HttpError(409, `${caller.name} has no owner to say yes to a new agent.`)
  const ask = NewAgentAsk.safeParse(raw)
  if (!ask.success) throw new HttpError(400, z.prettifyError(ask.error))
  const home = caller.home_instance_id
  if (home === null) throw new HttpError(409, `${caller.name} has no machine to put a new agent on.`)
  const answered = z.array(z.object({ id: z.string(), input: z.unknown() })).parse(await many(client,
    `select a.id, a.payload->'input' as input from asks a
     where a.session_id = $1 and a.kind = 'tool_approval' and a.payload->>'toolName' = $2 and a.status = 'answered'
       and a.answer->>'decision' = 'allow' and a.answered_by = $3 and not exists (select 1 from agents g where g.made_by_ask = a.id)
     order by a.answered_at desc, a.id`, [caller.id, CREATE_AGENT_TOOL, caller.owner_id]))
  // The ask holds the input as the engine asked with it, scrubbed as everything the
  // record keeps, and the tool's server sends it read through the same schema. The
  // agent is made from the scrubbed copy, so no secret the model wrote reaches it.
  const wanted = scrub(ask.data)
  const yes = answered.find((row) => {
    const said = NewAgentAsk.safeParse(row.input)
    return said.success && sameInput(said.data, wanted)
  })
  if (!yes) {
    throw new HttpError(403, `Making an agent needs ${caller.owner_login}'s yes on an ask for exactly this agent, and none is answered. Call create_agent, and it asks them.`)
  }
  const agentId = await insertAgent(client, {
    teamId: caller.team_id, ownerId: caller.owner_id, homeInstanceId: home, name: wanted.name, title: wanted.title ?? null, role: null,
    instructions: wanted.instructions ?? '', model: null, madeBy: { sessionId: caller.id, askId: yes.id },
  }).catch((error: unknown) => {
    // Two calls with the same yes at once: the unique ask on agents lets one through.
    if (isUniqueViolation(error) && error instanceof Error && 'constraint' in error && error.constraint === 'agents_made_by_ask_key') {
      throw new HttpError(409, 'That yes made an agent already.')
    }
    throw error
  })
  return { agentId: AgentId.parse(agentId), name: wanted.name, owner: caller.owner_login }
}
