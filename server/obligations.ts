// Promises made outside Agents, kept as obligations until their delivery is
// proven. A run that starts from an issue on a repo with a policy promises the
// reporter its outcome on the issue, and the runner delivers it when the run
// ends. An obligation closes only with proof of the kind it promised, or when a
// person waives it by name. An event already applied is a no-op, and a stale
// or conflicting one fails closed and changes nothing.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe } from './db.ts'
import { forge, repoPath } from './forge.ts'
import { HttpError, type Person } from './record.ts'
import { messageOf } from '../shared/errors.ts'
import { DELIVERY, OBLIGATION_ID, type Delivery, type DeliveryEvent, type ObligationId } from '../shared/framework.ts'

const POSTED = z.object({ id: z.number().int().positive(), html_url: z.url() })
const COMMENTS = z.array(z.object({ id: z.number().int().positive(), html_url: z.url(), body: z.string() }))
// An outcome comment names its run, so a retry finds the comment it already posted.
const marker = (runId: string) => `<!-- agents run ${runId} -->`

export type Obligation = {
  id: ObligationId; team_id: string; run_id: string | null; repo_id: string; promise: string; channel: string; number: number
  target: string; proof: Delivery['kind']; due_at: Date; status: 'open' | 'done' | 'waived'; generation: number; delivery_event: string | null
}

// Records a promise to post on an issue, once per run and issue.
export async function promiseOnIssue(client: pg.PoolClient, o: { teamId: string; taskId: string; runId: string; repoId: string; issue: number; target: string; promise: string; dueAt: Date }) {
  await client.query(
    `insert into obligations (team_id, task_id, run_id, repo_id, promise, channel, number, target, proof, due_at)
     values ($1, $2, $3, $4, $5, 'forge_issue', $6, $7, 'comment', $8) on conflict (run_id, target) where run_id is not null do nothing`,
    [o.teamId, o.taskId, o.runId, o.repoId, o.promise, o.issue, o.target, o.dueAt])
}

// Applies a delivery event. Returns what happened, or throws without changing
// anything when the event is stale, names another target or another kind of
// proof, or the obligation is already closed.
export async function deliver(client: pg.PoolClient, obligationId: ObligationId, event: DeliveryEvent): Promise<'delivered' | 'duplicate'> {
  const o = await maybe<Obligation>(client, 'select * from obligations where id = $1 for update', [obligationId])
  if (!o) throw new Error(`no obligation ${obligationId}`)
  if (o.delivery_event === event.id) return 'duplicate'
  if (o.status !== 'open') throw new Error(`obligation ${obligationId} is already ${o.status}, so ${event.id} changes nothing`)
  if (event.generation !== o.generation) throw new Error(`event ${event.id} saw generation ${event.generation}, and the obligation is at ${o.generation}`)
  if (event.target !== o.target) throw new Error(`event ${event.id} delivered to ${event.target}, and the promise was for ${o.target}`)
  if (event.delivery.kind !== o.proof) throw new Error(`event ${event.id} proves a ${event.delivery.kind}, and the promise needs a ${o.proof}`)
  const delivery = DELIVERY.parse(event.delivery)
  await client.query(
    `update obligations set status = 'done', delivery = $2, delivery_event = $3, generation = generation + 1, closed_at = now() where id = $1`,
    [obligationId, JSON.stringify(delivery), event.id])
  return 'delivered'
}

// A person lets an open promise go, by name, with a reason.
export async function waive(client: pg.PoolClient, obligationId: string, person: Person, reason: string) {
  const id = OBLIGATION_ID.parse(obligationId)
  const { rowCount } = await client.query(
    `update obligations set status = 'waived', waived_by = $3, waive_reason = $4, generation = generation + 1, closed_at = now()
     where id = $1 and team_id = $2 and status = 'open'`, [id, person.team_id, person.id, reason])
  if (!rowCount) throw new HttpError(409, 'no such open obligation on your team')
}

// Open promises, due soonest first, for the app to show.
export const openObligations = (db: pg.Pool | pg.PoolClient, teamId: string) => many<{ id: string; promise: string; target: string; due_at: Date; overdue: boolean }>(db,
  `select id, promise, target, due_at, due_at < now() as overdue from obligations where team_id = $1 and status = 'open' order by due_at`, [teamId])

// Delivers the outcome of each run that ended with a promise still open. The
// comment is posted once: a retry finds it by the run's marker first.
export async function deliverOutcomes(client: pg.PoolClient, teamIds: string[] | null) {
  const due = await many<Obligation & { remote_url: string; status_run: string; note: string | null; pr: string | null }>(client,
    `select o.*, rp.remote_url, r.status as status_run, r.note,
       (select a.url from artifacts a where a.task_id = r.task_id and a.kind = 'link' order by a.created_at desc limit 1) as pr
     from obligations o join runs r on r.id = o.run_id join repos rp on rp.id = o.repo_id
     where o.status = 'open' and o.channel = 'forge_issue' and r.status in ('done', 'failed', 'cancelled')
       and ($1::uuid[] is null or o.team_id = any($1)) order by o.due_at`, [teamIds])
  // Each promise is delivered on its own, inside a savepoint, so one that
  // cannot be, such as one on an issue the forge no longer has, stays open,
  // is reported, and never holds up or undoes the rest.
  for (const o of due) {
    if (o.run_id === null) continue
    const runId = o.run_id
    await client.query('savepoint delivery')
    try {
      const repo = repoPath(o.remote_url)
      const tag = marker(runId)
      const comments = COMMENTS.parse(await forge.comments(repo, o.number))
      const posted = comments.find((c) => c.body.includes(tag))
        ?? POSTED.parse(await forge.comment(repo, o.number,
          `${o.status_run === 'done' ? 'Done' : o.status_run === 'cancelled' ? 'Cancelled' : 'Stopped'}: ${o.note ?? 'the run ended.'}${o.pr ? `\n\n${o.pr}` : ''}\n\n${tag}`))
      await deliver(client, o.id, { id: `run:${runId}:outcome`, generation: o.generation, target: o.target, delivery: { kind: 'comment', id: posted.id, url: posted.html_url } })
      await client.query('release savepoint delivery')
    } catch (error) {
      await client.query('rollback to savepoint delivery')
      console.error(`obligation ${o.id} stays open: ${messageOf(error)}`)
    }
  }
}

// A run from an issue on a repo with a policy tells the reporter it started,
// and promises the outcome on the issue by the policy's time cap. The comment
// is looked up before it is posted, so a retried step posts it once.
export async function promiseOutcome(client: pg.PoolClient, o: { teamId: string; taskId: string; runId: string; repoId: string; remoteUrl: string; issue: number; url: string; minutes: number }) {
  const repo = repoPath(o.remoteUrl)
  const tag = `<!-- agents run ${o.runId} started -->`
  const comments = COMMENTS.parse(await forge.comments(repo, o.issue))
  if (!comments.some((c) => c.body.includes(tag))) {
    await forge.comment(repo, o.issue, `Agents started work on this. The outcome will be posted here.\n\n${tag}`)
  }
  await promiseOnIssue(client, {
    teamId: o.teamId, taskId: o.taskId, runId: o.runId, repoId: o.repoId, issue: o.issue, target: o.url,
    promise: 'Post the outcome of the run on this issue', dueAt: new Date(Date.now() + o.minutes * 60_000),
  })
}
