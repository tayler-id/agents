// How a machine reaches the API: the address and token from AGENTS_API and
// AGENTS_TOKEN, or $AGENTS_HOME/daemon.json, and one call made with them. The
// daemon and the folders command both use it.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import type { EventBatch } from '../shared/types.ts'

// Holds each agent's folder, each task's workspace, and this machine's config.
export const HOME = process.env.AGENTS_HOME ?? join(homedir(), '.agents-app')

export type Config = { api: string; token: string }

// What daemon.json holds that a machine reads. AGENTS_API and AGENTS_TOKEN win over it.
const ConfigFile = z.looseObject({ api: z.string().optional(), token: z.string().optional() })

// The config file, or nothing when there is none. A file that can't be read, or
// that isn't a config, is an error naming it, since the daemon would otherwise
// start without the settings the person put there.
function readConfigFile(): z.infer<typeof ConfigFile> {
  const path = join(HOME, 'daemon.json')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // No daemon.json: the environment must give the token.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON: ${messageOf(error)}`)
  }
  const parsed = ConfigFile.safeParse(json)
  if (!parsed.success) throw new Error(`${path} is not a config: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function loadConfig(): Config {
  const file = readConfigFile()
  const api = process.env.AGENTS_API ?? file.api ?? 'http://127.0.0.1:7700'
  const token = process.env.AGENTS_TOKEN ?? file.token
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

// The API's answer is outside data, so a caller parses what it needs from it.
export type Api = (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>

export function apiClient(config: Config): Api {
  return async (method, path, body, signal) => {
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
    return json
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
        console.error(`dropped a batch for ${sessionId}:`, messageOf(error))
        return
      }
      await sleep(Math.min(30_000, 500 * 2 ** attempt))
    }
  }
}
