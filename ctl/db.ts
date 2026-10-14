// The instance's database, which is always the test database (config.ts checks).
// `agentsctl db` reads side effects back with read-only queries: each runs in a
// read-only transaction that is rolled back, so Postgres itself refuses a write.
// Queries name the instance's rows with placeholders, {team}, {owner},
// {teammate} and {machine}, which become parameters, never text in the SQL.

import pg from 'pg'
import { z } from 'zod'
import { config } from './config.ts'
import { JSON_VALUE, Refused } from '../shared/cli/output.ts'
import type { Seed } from './state.ts'
import { hasCode, messageOf } from '../shared/errors.ts'

export const Rows = z.array(z.record(z.string(), JSON_VALUE))
export type Rows = z.infer<typeof Rows>

// A read that runs longer than this, or a connection slower to open, fails the
// command instead of hanging it. Every query agentsctl makes is a small read or
// a seed, which take milliseconds on the test database.
const STATEMENT_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: config().DATABASE_URL, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS, query_timeout: STATEMENT_TIMEOUT_MS + CONNECT_TIMEOUT_MS,
  })
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

// Postgres's code for a write inside a read-only transaction.
const READ_ONLY_VIOLATION = '25006'
// A named statement goes through the extended protocol, where Postgres parses
// exactly one statement. Sent as simple text, `select 1; commit; update ...`
// would end the read-only transaction and run the update.
const READ_STATEMENT = 'agentsctl-read'
const MULTIPLE_COMMANDS = /cannot insert multiple commands into a prepared statement/

export async function readOnly(sql: string, values: string[]): Promise<Rows> {
  return withClient(async (client) => {
    await client.query('begin transaction read only')
    try {
      const result = await client.query<Record<string, unknown>>({ name: READ_STATEMENT, text: sql, values })
      return Rows.parse(result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))))
    } catch (error) {
      if (hasCode(error, READ_ONLY_VIOLATION)) {
        throw new Refused(`db reads only, so Postgres refused: ${messageOf(error)}`, ['Change the record the way a person or an agent does: through bin/agentsctl browser, desktop or api'])
      }
      if (error instanceof Error && MULTIPLE_COMMANDS.test(error.message)) {
        throw new Refused('db runs one statement at a time, so Postgres refused a second', ['Run each select as its own db command'])
      }
      throw error
    } finally {
      await client.query('rollback')
    }
  })
}
