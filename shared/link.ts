// The control connection every daemon keeps open to the API's machine port. The
// API sends it what must not be stored anywhere on the way, such as a secret's
// value, and the daemon answers. Each side dials out, so nothing on a computer
// listens for the API. A frame is one JSON text message. The design is "Secrets
// set from the app" in docs/design/target-architecture.md.

import { z } from 'zod'
import { SecretName } from './secrets.ts'
import { SecretValue, SettableName } from './secret-rules.ts'

export const LINK_PATH = '/v1/instance/control'

// Colima's port forwarding and cloud load balancers drop TCP connections idle
// for about a minute. The API pings each control connection every 15 seconds,
// and either side drops one that has said nothing for three pings, since a
// computer that sleeps, or a network that drops, leaves a connection open with
// nobody behind it.
export const LINK_PING_MS = 15_000
export const LINK_DEAD_MS = 45_000
// A daemon whose connection fails tries again after the first wait, and waits
// twice as long after each failure, up to the longest. The longest stays inside
// LINK_WAIT_MS, so a person who sets a value just after the API restarts finds
// the daemon back before the wait runs out.
export const LINK_RECONNECT_FIRST_MS = 1_000
export const LINK_RECONNECT_MAX_MS = 8_000
// How long setting a value waits for a computer whose connection is not up yet.
// Nothing here starts a stopped computer, so this covers a daemon reconnecting.
export const LINK_WAIT_MS = 12_000
// How long a computer gets to answer a frame. It writes a small file.
export const LINK_ANSWER_MS = 10_000
// The largest frame. A value of SECRET_VALUE_MAX_BYTES with every character
// escaped as \u00XX is about 25 KB.
export const LINK_MAX_FRAME_BYTES = 64 * 1024
// The close code for a frame that is not text or does not parse.
export const LINK_UNSUPPORTED = 1003

const RequestId = z.uuid()

// What the API asks of a computer.
export const ToDaemon = z.discriminatedUnion('type', [
  z.object({ type: z.literal('secret_put'), id: RequestId, name: SettableName, value: SecretValue }),
  z.object({ type: z.literal('secret_remove'), id: RequestId, name: SettableName }),
])
export type ToDaemon = z.infer<typeof ToDaemon>

// What a computer answers, and tells the API when it connects.
export const FromDaemon = z.discriminatedUnion('type', [
  // The names of the secrets the computer holds, sent each time it connects. The
  // API forgets that it set one the computer no longer holds, such as after a
  // box was made again with an empty home.
  z.object({ type: z.literal('secrets_held'), names: z.array(SecretName) }),
  z.object({ type: z.literal('secret_stored'), id: RequestId, name: SecretName }),
  // `had` is false when the computer held no value under the name.
  z.object({ type: z.literal('secret_removed'), id: RequestId, name: SecretName, had: z.boolean() }),
  z.object({ type: z.literal('secret_refused'), id: RequestId, name: SecretName, reason: z.string().max(500) }),
])
export type FromDaemon = z.infer<typeof FromDaemon>
