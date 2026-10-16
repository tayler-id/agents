#!/usr/bin/env node
// The stand-in for Claude, slowed for one kind of message. It starts
// test/fake-claude.ts with the same arguments and passes on everything it is sent
// and everything it prints, but holds a message that asks it to work slowly for a
// few seconds first. The session is busy meanwhile, so a check can change
// something under an agent that is in the middle of a turn.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

// How long a slow message is held.
const SLOW_MS = 4000
const FAKE = new URL('./fake-claude.ts', import.meta.url).pathname

const child = spawn(process.execPath, [FAKE, ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] })
child.stdin.on('error', () => undefined)
const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { resolve(code) }))

for await (const line of createInterface({ input: process.stdin })) {
  if (line.includes('work slowly')) await sleep(SLOW_MS)
  child.stdin.write(`${line}\n`)
}
child.stdin.end()
process.exitCode = await exited ?? 1
