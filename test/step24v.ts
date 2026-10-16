// Dictation: POST /v1/transcribe turns a person's recording into the words they said,
// through the speech service on the server Mac. The check starts the API on its own ports
// and a stand-in for the speech service (test/fake-speech.ts), which answers a clip with
// the words it holds only when it was sent exactly the audio the check recorded. The
// fixture, test/fixtures/dictation.wav, is "Please schedule the design review for Tuesday
// morning." read by a macOS voice at 16 kHz. Parakeet reads it back as exactly that.
// Checks that:
// - a WAV and a WebM of that fixture come back as that sentence, and the service heard
//   the fixture's own samples, whole, under the model and format the API names
// - a person who is not signed in, or not on a team, gets 401 and 403, and the machine
//   port has no such route
// - the limits answer with their words: a wrong type, a body past 10 MB, a clip past 60 s,
//   bytes that are not what their type says, an empty body
// - with the service down, with no service set up, erroring, answering nonsense and
//   answering too slowly, a person reads what happened and not "fetch failed"
// - four clips at once answer the fourth that the service is busy, and the three finish
// - a clip with no speech answers {text: ""}
// This check owns ports 8340 to 8346. It uses the test database and the lock-free ports of
// its own, so it does not take the lock for port 7701.
//   node --env-file=.env --env-file=.env.test test/step24v.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { pcmToWav } from '../server/audio.ts'
import { STT_MODEL } from '../server/speech.ts'
import { MAX_CLIP_BYTES, SPEECH_WORDS, VOICE_IN_RATE } from '../shared/voice.ts'
import { startFakeSpeech, type Heard } from './fake-speech.ts'
import { addTeam, dropTeam, migrate, startApi, type VoiceApi } from './voice-kit.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SPEECH_PORT = 8340
const PORTS = { machines: 8341, people: 8342, streams: 8343 } as const
const BARE_PORTS = { machines: 8344, people: 8345, streams: 8346 } as const
const SENTENCE = 'Please schedule the design review for Tuesday morning.'
// The API waits this long for the speech service before it gives up on a clip. Waiting that long is the check.
const SLOW_MS = 30_000
const SLOW_MARGIN_MS = 15_000

const id = randomBytes(4).toString('hex')
const team = `voice-${id}`
const login = `voice-${id}@example.com`
const stranger = `stranger-${id}@example.com`
const work = mkdtempSync(join(tmpdir(), 'agents-step24v-'))
const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const fixture = readFileSync(join(ROOT, 'test/fixtures/dictation.wav'))
// The samples of the fixture, after its 44-byte header.
const fixturePcm = fixture.subarray(44)
const webm = (() => {
  const source = join(work, 'dictation.wav')
  const out = join(work, 'dictation.webm')
  writeFileSync(source, fixture)
  execFileSync('ffmpeg', ['-v', 'error', '-i', source, '-c:a', 'libopus', out])
  return readFileSync(out)
})()

// The stand-in's rule for a clip: the fixture's own samples, whole, are the sentence. Anything else is a different clip.
// A WebM went through opus, so its samples differ, and it counts when it is the right length and has sound in it.
function decide(clip: Heard): string {
  if (clip.wav.subarray(44).equals(fixturePcm)) return SENTENCE
  const seconds = (clip.wav.length - 44) / (VOICE_IN_RATE * 2)
  const loud = clip.wav.subarray(44).some((byte) => byte !== 0)
  return Math.abs(seconds - fixturePcm.length / (VOICE_IN_RATE * 2)) < 0.3 && loud && clip.wav.toString('ascii', 0, 4) === 'RIFF' ? SENTENCE : 'something else'
}

const Reply = z.object({ text: z.string().optional(), error: z.string().optional() })
async function post(api: VoiceApi, body: Buffer | string, contentType: string, as: string | null = login) {
  const res = await fetch(`${api.people}/v1/transcribe`, {
    method: 'POST', headers: { 'content-type': contentType, ...(as ? { 'tailscale-user-login': as } : {}) },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  })
  return { status: res.status, ...Reply.parse(await res.json()) }
}
const wavOf = (seconds: number) => pcmToWav(Buffer.alloc(Math.round(seconds * VOICE_IN_RATE) * 2), VOICE_IN_RATE)

let speech: Awaited<ReturnType<typeof startFakeSpeech>> | undefined
let api: VoiceApi | undefined
let bare: VoiceApi | undefined
try {
  migrate()
  addTeam(team, login)
  speech = await startFakeSpeech(SPEECH_PORT, decide)
  api = await startApi(work, PORTS, `http://127.0.0.1:${SPEECH_PORT}`)

  // ---- the words come back ----
  const wav = await post(api, fixture, 'audio/wav')
  check(wav.status === 200 && wav.text === SENTENCE, 'a WAV of the fixture comes back as the sentence it holds')
  check(speech.heard.length === 1 && speech.heard[0]?.wav.equals(fixture), 'the service was sent the fixture byte for byte')
  check(speech.heard[0]?.model === STT_MODEL && speech.heard[0].responseFormat === 'json', `the service was asked for ${STT_MODEL}, as json`)
  const web = await post(api, webm, 'audio/webm;codecs=opus')
  check(web.status === 200 && web.text === SENTENCE, 'a WebM of the fixture comes back as the same sentence')
  const converted = speech.heard[1]?.wav
  check(converted?.toString('ascii', 0, 4) === 'RIFF' && converted.readUInt32LE(24) === VOICE_IN_RATE && converted.readUInt16LE(22) === 1,
    'the WebM reached the service as a 16 kHz mono WAV, converted by ffmpeg')

  // ---- who may ----
  check((await post(api, fixture, 'audio/wav', null)).status === 401, 'without a Tailscale login the answer is 401')
  const outsider = await post(api, fixture, 'audio/wav', stranger)
  check(outsider.status === 403 && outsider.error === `${stranger} is not on a team`, 'a login that is not on a team gets 403 and is told so')
  const heardBefore = speech.heard.length
  const machine = await fetch(`http://127.0.0.1:${PORTS.machines}/v1/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(fixture) })
  check(machine.status === 404 && speech.heard.length === heardBefore, 'the machine port has no such route, so a box cannot spend the speech models')

  // ---- limits ----
  const json = await post(api, '{}', 'application/json')
  check(json.status === 415 && json.error === SPEECH_WORDS.wrongType, 'JSON is refused with 415 and "Send the recording as WAV or WebM."')
  check((await post(api, fixture, 'text/plain')).status === 415, 'text/plain is refused with 415')
  const big = await post(api, Buffer.alloc(MAX_CLIP_BYTES + 1), 'audio/wav')
  check(big.status === 413 && big.error === SPEECH_WORDS.tooLarge, 'a body past 10 MB is refused with 413 and its words')
  const long = await post(api, wavOf(61), 'audio/wav')
  check(long.status === 413 && long.error === SPEECH_WORDS.tooLong, 'a 61 second clip is refused with 413 and its words')
  const edge = await post(api, wavOf(60), 'audio/wav')
  check(edge.status === 200, 'a 60 second clip is taken')
  const notWav = await post(api, Buffer.from('this is not audio at all, it is words'), 'audio/wav')
  check(notWav.status === 400 && notWav.error === SPEECH_WORDS.notAudio, 'bytes that are not a WAV, sent as one, get 400 and their words')
  const notWebm = await post(api, fixture, 'audio/webm')
  check(notWebm.status === 400 && notWebm.error === SPEECH_WORDS.notAudio, 'a WAV sent as WebM gets 400 and their words')
  const brokenWebm = await post(api, Buffer.concat([webm.subarray(0, 4), Buffer.from('garbage after a good start')]), 'audio/webm')
  check(brokenWebm.status === 400 && brokenWebm.error === SPEECH_WORDS.notAudio, 'a WebM that cannot be decoded gets 400 and their words')
  const empty = await post(api, Buffer.alloc(0), 'audio/wav')
  check(empty.status === 400 && empty.error === SPEECH_WORDS.empty, 'an empty body gets 400 and its words')
  const liar = wavOf(1)
  liar.writeUInt32LE(0xffff_ff00, 40)
  const lied = await post(api, liar, 'audio/wav')
  check(lied.status === 200, 'a WAV whose header claims more bytes than it holds is measured by the bytes it holds')

  // ---- no speech ----
  speech.decide = () => ''
  const quiet = await post(api, fixture, 'audio/wav')
  check(quiet.status === 200 && quiet.text === '', 'a clip with no speech answers {text: ""}')
  speech.decide = decide

  // ---- busy ----
  speech.mode = 'hold'
  const first = [1, 2, 3].map(() => post(api as VoiceApi, fixture, 'audio/wav'))
  const deadline = Date.now() + 10_000
  while (speech.waiting() < 3 && Date.now() < deadline) await sleep(50)
  const fourth = await post(api, fixture, 'audio/wav')
  check(fourth.status === 429 && fourth.error === SPEECH_WORDS.busy, 'a fourth clip while three are being read gets 429 and "Speech to text is busy. Try again in a moment."')
  speech.mode = 'ok'
  speech.release()
  const finished = await Promise.all(first)
  check(finished.every((r) => r.status === 200 && r.text === SENTENCE), 'the three clips already in flight finish with their words')
  check((await post(api, fixture, 'audio/wav')).status === 200, 'and the next clip is taken again')

  // ---- the service misbehaves ----
  speech.mode = 'error'
  const failed = await post(api, fixture, 'audio/wav')
  check(failed.status === 502 && failed.error === SPEECH_WORDS.unreadable, 'a service that answers 500 gives 502 and "The speech service could not read that clip."')
  speech.mode = 'garbage'
  const garbled = await post(api, fixture, 'audio/wav')
  check(garbled.status === 502 && garbled.error === SPEECH_WORDS.unreadable, 'a service that answers something that is not {text} gives 502 and the same words')
  speech.mode = 'ok'

  // ---- the service is slow ----
  speech.mode = 'hold'
  const started = Date.now()
  const slow = await post(api, fixture, 'audio/wav')
  const waited = Date.now() - started
  check(slow.status === 504 && slow.error === SPEECH_WORDS.tooSlow && Math.abs(waited - SLOW_MS) < SLOW_MARGIN_MS,
    `a service that never answers gives 504 and "The speech service took too long. Try a shorter clip." after about ${SLOW_MS / 1000} s (took ${Math.round(waited / 1000)} s)`)
  speech.mode = 'ok'
  speech.release()

  // ---- the service is down ----
  await new Promise<void>((resolve) => { speech?.server.close(() => { resolve() }); speech?.server.closeAllConnections() })
  const down = await post(api, fixture, 'audio/wav')
  check(down.status === 503 && down.error === SPEECH_WORDS.notRunning, 'with nothing listening the answer is 503 and "The speech service is not running..."')

  // ---- no service set up ----
  bare = await startApi(work, BARE_PORTS, undefined)
  const unset = await post(bare, fixture, 'audio/wav')
  check(unset.status === 503 && unset.error === SPEECH_WORDS.notSetUp, 'an API with no AGENTS_SPEECH_URL answers 503 and "Speech to text is not set up on this server yet."')
} finally {
  await bare?.stop()
  await api?.stop()
  speech?.server.close()
  speech?.server.closeAllConnections()
  await dropTeam(team)
  rmSync(work, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
