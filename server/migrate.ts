// Applies server/migrations/*.sql in name order, each once and in its own
// transaction. Safe to run on every start: the API runs it before listening.
//   node --env-file=.env server/migrate.ts

import { readdirSync, readFileSync } from 'node:fs'
import { pool, withConnection } from './db.ts'

const DIR = new URL('./migrations/', import.meta.url)
const LOCK = 7710

export async function migrate(): Promise<string[]> {
  return withConnection(async (client) => {
    try {
      await client.query('select pg_advisory_lock($1)', [LOCK])
      await client.query(`create table if not exists schema_migrations (
        version text primary key, applied_at timestamptz not null default now())`)
      const { rows } = await client.query<{ version: string }>('select version from schema_migrations')
      const done = new Set(rows.map((r) => r.version))
      const applied: string[] = []
      for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue
        try {
          await client.query('begin')
          await client.query(readFileSync(new URL(file, DIR), 'utf8'))
          await client.query('insert into schema_migrations (version) values ($1)', [file])
          await client.query('commit')
        } catch (error) {
          await client.query('rollback')
          throw new Error(`${file}: ${(error as Error).message}`)
        }
        applied.push(file)
      }
      return applied
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {})
    }
  })
}

if (import.meta.main) {
  try {
    const applied = await migrate()
    console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date')
  } finally {
    await pool.end()
  }
}
