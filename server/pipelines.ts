// Pipelines are files in a team's repo, under pipelines/ on the default branch.
// Each version is a file's content, named by git's blob id for it. The server
// reads them from the forge, checks each one loads and makes sense, and makes the
// newest good one current. A run always uses the version it started with.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { one, pool, tx, type Db } from './db.ts'
import { messageOf } from '../shared/errors.ts'
import { forge, forgeConfig, repoPath } from './forge.ts'
import type { Pipeline, Stage } from '../shared/pipeline.ts'

const CACHE = join(process.env.AGENTS_HOME ?? join(homedir(), '.agents-app'), 'pipelines')
const ACTIONS = ['open_pull_request', 'merge_pull_request', 'close_issue', 'score_change', 'propose_instructions', 'apply_proposal']
const TEXT_ACTIONS = ['open_pull_request', 'close_issue']
const KINDS = ['agent', 'check', 'action', 'gate']

// git's id for a file with this content.
export const blobSha = (source: string) => {
  const bytes = Buffer.from(source)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

// The outcomes a stage can end with. An agent picks from its `next` keys.
export function outcomesOf(stage: Stage): string[] {
  if (stage.kind === 'check') return ['passes', 'fails']
  if (stage.kind === 'action') return stage.action === 'score_change' ? ['better', 'not_better', 'failed'] : ['done', 'failed']
  if (stage.kind === 'gate') return ['approved', 'rejected']
  return Object.keys(stage.next)
}

type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null

// What is wrong with a pipeline file's export, or nothing. The export comes from
// a file anyone on the team can change, so nothing about its shape is assumed.
function problems(value: unknown): string[] {
  if (!isObject(value) || !isObject(value.stages)) return ['the file must export default a pipeline']
  const stages = value.stages
  const out: string[] = []
  if (typeof value.agent !== 'string' || !value.agent) out.push('agent must name an agent')
  if (value.runsOn !== 'box' && value.runsOn !== 'home') out.push('runsOn must be box or home')
  if (typeof value.spendCapUsd !== 'number' || !(value.spendCapUsd > 0)) out.push('spendCapUsd must be more than 0')
  if (!Array.isArray(value.triggers)) out.push('triggers must be a list')
  if (typeof value.start !== 'string' || !isObject(stages[value.start])) out.push(`start names no stage: ${String(value.start)}`)
  const target = (from: string, next: unknown) => {
    if (typeof next === 'string') {
      if (!isObject(stages[next])) out.push(`${from} leads to a missing stage: ${next}`)
    } else if (!isObject(next) || (!('done' in next) && !('handoff' in next))) {
      out.push(`${from} leads nowhere`)
    }
  }
  for (const [name, stage] of Object.entries(stages)) {
    if (!isObject(stage) || typeof stage.kind !== 'string' || !KINDS.includes(stage.kind)) {
      out.push(`${name}: kind must be one of ${KINDS.join(', ')}`)
      continue
    }
    const fn = (key: string) => typeof stage[key] === 'function'
    if (stage.kind === 'agent' && !fn('prompt')) out.push(`${name}: an agent stage needs a prompt`)
    if (stage.kind === 'check' && !fn('command')) out.push(`${name}: a check needs a command`)
    if (stage.kind === 'action') {
      if (typeof stage.action !== 'string' || !ACTIONS.includes(stage.action)) out.push(`${name}: an action must be one of ${ACTIONS.join(', ')}`)
      else if (TEXT_ACTIONS.includes(stage.action) && !fn('text')) out.push(`${name}: ${stage.action} needs a text`)
    }
    if (stage.kind === 'gate' && !fn('question')) out.push(`${name}: a gate needs a question`)
    if (!isObject(stage.next) || !Object.keys(stage.next).length) {
      out.push(`${name}: next is empty`)
      continue
    }
    const next = stage.next
    for (const outcome of outcomesOf(stage as Stage)) {
      if (next[outcome] === undefined) out.push(`${name}: nothing handles the outcome ${outcome}`)
    }
    for (const [outcome, to] of Object.entries(next)) target(`${name}.${outcome}`, to)
  }
  return out
}

const loaded = new Map<string, Pipeline>()

// Loads a version from its source. A pipeline file may import types only, so it
// loads the same from a cache folder as from its repo.
export async function loadSource(source: string): Promise<{ pipeline?: Pipeline; error?: string }> {
  const sha = blobSha(source)
  const hit = loaded.get(sha)
  if (hit) return { pipeline: hit }
  try {
    mkdirSync(CACHE, { recursive: true })
    const file = join(CACHE, `${sha}.ts`)
    writeFileSync(file, source)
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
    const found = problems(module.default)
    if (found.length) return { error: found.join('; ') }
    // problems() has checked every field the runner reads.
    const pipeline = module.default as Pipeline
    loaded.set(sha, pipeline)
    return { pipeline }
  } catch (error) {
    return { error: messageOf(error).split('\n')[0] ?? 'it does not load' }
  }
}

export async function loadVersion(db: Db, versionId: string): Promise<Pipeline> {
  const version = await one<{ source: string }>(db, `pipeline version ${versionId}`, 'select source from pipeline_versions where id = $1', [versionId])
  const { pipeline, error } = await loadSource(version.source)
  if (!pipeline) throw new Error(`pipeline version ${versionId} does not load: ${error ?? 'no reason given'}`)
  return pipeline
}

// Records one pipeline file as a version, and makes it current if it loads. A
// candidate from a proposal is recorded without becoming current.
export async function recordVersion(teamId: string, repoId: string | null, name: string, path: string, source: string, current = true) {
  const { pipeline, error } = await loadSource(source)
  return tx(async (client) => {
    await client.query(
      `insert into pipelines (team_id, repo_id, name, path) values ($1, $2, $3, $4)
       on conflict (team_id, name) do update set repo_id = excluded.repo_id, path = excluded.path
       where pipelines.repo_id is distinct from excluded.repo_id or pipelines.path <> excluded.path`,
      [teamId, repoId, name, path])
    // Locked, so two servers syncing at once make one room, not two.
    const row = await one<{ id: string; conversation_id: string | null }>(client, `pipeline ${name}`,
      'select id, conversation_id from pipelines where team_id = $1 and name = $2 for update', [teamId, name])
    await client.query(
      `insert into pipeline_versions (pipeline_id, git_sha, source, error) values ($1, $2, $3, $4)
       on conflict (pipeline_id, git_sha) do nothing`, [row.id, blobSha(source), source, error ?? null])
    const version = await one<{ id: string }>(client, `the version of ${name}`,
      'select id from pipeline_versions where pipeline_id = $1 and git_sha = $2', [row.id, blobSha(source)])
    if (pipeline && current) {
      await client.query(
        `update pipelines set current_version_id = $2, description = $3
         where id = $1 and (current_version_id is distinct from $2 or description <> $3)`,
        [row.id, version.id, pipeline.description])
    }
    // The pipeline's room, where its runs post progress and gates ping the shepherd.
    if (!row.conversation_id) {
      const room = await one<{ id: string }>(client, `the room of ${name}`,
        `insert into conversations (team_id, kind, name, source) values ($1, 'room', $2, 'pipeline') returning id`, [teamId, name])
      await client.query('update pipelines set conversation_id = $2 where id = $1', [row.id, room.id])
    }
    return { pipelineId: row.id, versionId: version.id, error }
  })
}

// Reads pipelines/ from the given repos on the forge, or from every repo of the
// given teams, or of every team when neither is given.
export async function syncPipelines(repoIds?: string[], teamIds: string[] | null = null) {
  let forgeUrl: string
  try {
    forgeUrl = forgeConfig().url
  } catch {
    return
  }
  const { rows: repos } = await pool.query<{ id: string; team_id: string; remote_url: string; default_branch: string }>(
    `select id, team_id, remote_url, default_branch from repos
     where starts_with(remote_url, $1) and ($2::uuid[] is null or id = any($2)) and ($3::uuid[] is null or team_id = any($3))`,
    [forgeUrl, repoIds ?? null, teamIds])
  for (const repo of repos) {
    try {
      for (const file of await forge.files(repoPath(repo.remote_url), 'pipelines', repo.default_branch)) {
        if (!file.path.endsWith('.ts')) continue
        const name = file.path.slice('pipelines/'.length, -'.ts'.length)
        await recordVersion(repo.team_id, repo.id, name, file.path, file.content)
      }
    } catch (error) {
      console.error(`pipelines in ${repo.remote_url}:`, (error as Error).message)
    }
  }
}
