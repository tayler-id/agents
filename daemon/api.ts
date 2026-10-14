// How a machine reaches the API: the address and token from AGENTS_API and
// AGENTS_TOKEN, or $AGENTS_HOME/daemon.json, and one call made with them. The
// daemon and the folders command both use it.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { EventBatch } from '../shared/types.ts'

// Holds each agent's folder, each task's workspace, and this machine's config.
export const HOME = process.env.AGENTS_HOME ?? join(homedir(), '.agents-app')

export type Config = { api: string; token: string }

export function loadConfig(): Config {
  let file: unknown = {}
  try {
    file = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8'))
  } catch {
    // No daemon.json: the environment must give the token.
  }
  const fromFile = (key: string) => {
    const value = typeof file === 'object' && file !== null ? (file as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' ? value : undefined
  }
  const api = process.env.AGENTS_API ?? fromFile('api') ?? 'http://127.0.0.1:7700'
  const token = process.env.AGENTS_TOKEN ?? fromFile('token')
  if (!token) throw new Error(`set AGENTS_TOKEN or add a token to ${join(HOME, 'daemon.json')}`)
  return { api, token }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Api = <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<T>

export function apiClient(config: Config): Api {
  return async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(config.api + path, {
      method,
      signal,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json: unknown = await res.json().catch(() => ({}))
    if (!res.ok) {
      const error = typeof json === 'object' && json !== null && 'error' in json && typeof json.error === 'string' ? json.error : ''
      throw new ApiError(res.status, `${method} ${path}: ${res.status} ${error}`)
    }
    // The API's answers are this repo's own types.
    return json as T
  }
}

// Retries until the API takes the batch, which the caller has scrubbed. Posts
// are idempotent by client id. A 4xx other than 408 or 429 means the batch
// itself is wrong, or its session takes no more, so it is logged and dropped.
export async function postEvents(api: Api, sessionId: string, batch: EventBatch) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api('POST', `/v1/sessions/${sessionId}/events`, batch)
      return
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        console.error(`dropped a batch for ${sessionId}:`, (error as Error).message)
        return
      }
      await sleep(Math.min(30_000, 500 * 2 ** attempt))
    }
  }
}
