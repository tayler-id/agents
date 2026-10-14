import pg from 'pg'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
// An idle connection that Postgres drops, when it restarts, is removed from the
// pool. Without a listener the error would stop the process.
pool.on('error', (error) => { console.error('postgres:', error.message) })

// A pool or a client inside a transaction.
export type Db = pg.Pool | pg.PoolClient
type Row = pg.QueryResultRow

// Lends `fn` a connection of its own. The pool listens for errors only on idle
// connections, and pg emits one on a lent connection that Postgres drops, so this
// listens while `fn` holds it. The query in flight fails instead of the process
// stopping, and the pool discards the connection when it comes back.
export async function withConnection<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  const onError = (error: Error) => { console.error('postgres:', error.message) }
  client.on('error', onError)
  try {
    return await fn(client)
  } finally {
    client.removeListener('error', onError)
    client.release()
  }
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withConnection(async (client) => {
    await client.query('begin')
    try {
      const result = await fn(client)
      await client.query('commit')
      return result
    } catch (error) {
      // A rollback fails only on a connection Postgres dropped, which has no
      // transaction left and which the pool discards.
      await client.query('rollback').catch(() => undefined)
      throw error
    }
  })
}

// Postgres refused a row that a unique index already has.
export const isUniqueViolation = (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505'

// Reading rows. Pick by what a missing row means: `one` when it is a bug, so it
// throws and says which row; `maybe` when it is a normal case the caller handles.
// The coding-standards skill, "Read database rows with one, maybe or many".

export async function many<T extends Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}

export async function maybe<T extends Row>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0]
}

export async function one<T extends Row>(db: Db, what: string, sql: string, params: unknown[] = []): Promise<T> {
  const row = (await db.query<T>(sql, params)).rows[0]
  if (!row) throw new Error(`expected ${what}, and there is none`)
  return row
}
