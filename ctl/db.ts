// The instance's database, which is always the test database (config.ts checks).
// `agentsctl db` reads side effects back with read-only queries: each runs in a
// read-only transaction that is rolled back, so Postgres itself refuses a write.
// Queries name the instance's rows with placeholders, {team}, {owner},
// {teammate} and {machine}, which become parameters, never text in the SQL.

import pg from 'pg'
import { z } from 'zod'
import { config } from './config.ts'
import type { Seed } from './state.ts'

export const Json = z.json()
export type Json = z.infer<typeof Json>
export const Rows = z.array(z.record(z.string(), Json))
export type Rows = z.infer<typeof Rows>

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: config().DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const PLACEHOLDER = /\{(team|owner|teammate|machine)\}/g
const Placeholder = z.enum(['team', 'owner', 'teammate', 'machine'])

// Turns {team} and the rest into $1, $2 ... with the seed's ids as the values.
export function bind(sql: string, seed: Seed): { text: string; values: string[] } {
  const values: string[] = []
  const ids = { team: seed.teamId, owner: seed.owner.id, teammate: seed.teammate.id, machine: seed.machine.id }
  const text = sql.replace(PLACEHOLDER, (_match, name: unknown) => {
    values.push(ids[Placeholder.parse(name)])
    return `$${String(values.length)}`
  })
  return { text, values }
}

// Postgres values as JSON: times as ISO strings, everything else as pg gives it.
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(plain)
  return value
}

export async function readOnly(sql: string, values: string[]): Promise<Rows> {
  return withClient(async (client) => {
    await client.query('begin transaction read only')
    try {
      const result = await client.query<Record<string, unknown>>(sql, values)
      return Rows.parse(result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))))
    } finally {
      await client.query('rollback')
    }
  })
}
