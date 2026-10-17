// Voice chat: a person talks to an agent over a WebSocket. The check starts the API on its
// own ports, a stand-in for the speech service (test/fake-speech.ts), and plays the agent's
// machine through the real machine API, posting the agent's words and ending its turn with
// the same events a daemon sends. It checks that:
// - the person's audio frames become the text they said, posted to the conversation as their
//   message, and the stand-in heard exactly the fixture's samples
// - the agent's reply is spoken one sentence at a time as each is written, in order, each as
//   the audio the stand-in makes for that sentence, with the markdown and code left unspoken
// - the person talking over the agent, or sending stop, silences it, and nothing more is spoken
// - a closed socket speaks no more
// - nothing heard, no audio, a too-long turn, a service that errors and a service not set up each
//   give the person words and leave the socket open for the next turn
// - another site's page, a person not signed in, a conversation that is not theirs, a room and the
//   machine port are all refused
// This check owns ports 8340 to 8346, as step24v does, so the two do not run together.
//   node --env-file=.env --env-file=.env.test test/step24w.ts

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { SPEECH_WORDS, VOICE_CLOSE_WORDS, VOICE_FRAME_BYTES, VOICE_IN_RATE, VOICE_OUT_RATE, VOICE_WORDS, VoiceClose, VoiceFromServer } from '../shared/voice.ts'
import { bytesOf } from '../shared/websocket.ts'
import { TTS_LANGUAGE, TTS_MODEL, TTS_VOICE } from '../server/speech.ts'
import { startFakeSpeech, pcmFor, type FakeSpeech, type Heard } from './fake-speech.ts'
import { must } from './must.ts'
import { addPerson, addTeam, dropTeam, migrate, startApi, type VoiceApi } from './voice-kit.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SPEECH_PORT = 8340
const PORTS = { machines: 8341, people: 8342, streams: 8343 } as const
const BARE_PORTS = { machines: 8344, people: 8345, streams: 8346 } as const
const SENTENCE = 'Please schedule the design review for Tuesday morning.'
// How long to wait for something that should happen, and for something that should not.
const WAIT_MS = 15_000
const QUIET_MS = 1_500

const id = randomBytes(4).toString('hex')
const team = `voice-${id}`
const login = `voice-${id}@example.com`
const teammate = `mate-${id}@example.com`
const outsider = `out-${id}@example.com`
const work = mkdtempSync(join(tmpdir(), 'agents-step24w-'))
const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const fixturePcm = readFileSync(join(ROOT, 'test/fixtures/dictation.wav')).subarray(44)
const decide = (clip: Heard) => (clip.wav.subarray(44).equals(fixturePcm) ? SENTENCE : 'something else')
const origin = must(process.env.AGENTS_PEOPLE_ORIGINS?.split(',')[0]?.trim(), 'AGENTS_PEOPLE_ORIGINS')
// 20 ms of the fixture at a time, as a page sends a microphone.
const FRAME_BYTES = VOICE_IN_RATE * 2 * 0.02
const frames = (pcm: Buffer) => Array.from({ length: Math.ceil(pcm.length / FRAME_BYTES) }, (_, i) => pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES))

type Seen = { json: VoiceFromServer } | { audio: Buffer }
class Voice {
  seen: Seen[] = []
  closed: { code: number; reason: string } | null = null
  ws: WebSocket
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data, isBinary) => {
      this.seen.push(isBinary ? { audio: bytesOf(data) } : { json: VoiceFromServer.parse(JSON.parse(bytesOf(data).toString('utf8'))) })
    })
    ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() } })
  }
  get types() { return this.seen.flatMap((s) => ('json' in s ? [s.json.type] : [])) }
  count(type: string) { return this.types.filter((t) => t === type).length }
  // The sentences spoken and the audio frames that came after each, joined.
  get spoken() {
    const out: { text: string; audio: Buffer }[] = []
    for (const s of this.seen) {
      if ('json' in s && s.json.type === 'speaking') out.push({ text: s.json.text, audio: Buffer.alloc(0) })
      else if ('audio' in s) {
        const last = out.at(-1)
        if (last) last.audio = Buffer.concat([last.audio, s.audio])
      }
    }
    return out
  }
  errors() { return this.seen.flatMap((s) => ('json' in s && s.json.type === 'error' ? [s.json.error] : [])) }
  send(message: object) { this.ws.send(JSON.stringify(message)) }
  async say(pcm: Buffer) {
    for (const frame of frames(pcm)) this.ws.send(frame, { binary: true })
  }
  mark() { return this.seen.length }
}
async function until(condition: () => boolean | Promise<boolean>, ms = WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await sleep(25)
  }
  return condition()
}
// Opens a voice chat as `as`, from `from`, and says how the upgrade went.
function open(api: VoiceApi, conversationId: string, as: string | null, from: string | null = origin): Promise<{ voice: Voice } | { status: number }> {
  const url = `${api.people.replace('http', 'ws')}/v1/voice/conversations/${conversationId}`
  const headers: Record<string, string> = {}
  if (as) headers['tailscale-user-login'] = as
  if (from) headers.origin = from
  const ws = new WebSocket(url, { headers })
  return new Promise((resolve) => {
    const voice = new Voice(ws)
    ws.once('open', () => { resolve({ voice }) })
    ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode ?? 0 }) })
    ws.once('error', () => undefined)
  })
}
const connected = async (api: VoiceApi, conversationId: string, as = login) => {
  const opened = await open(api, conversationId, as)
  if (!('voice' in opened)) throw new Error(`voice chat refused with ${opened.status}`)
  await until(() => opened.voice.count('ready') === 1)
  return opened.voice
}

const Id = z.object({ conversationId: z.uuid() })
const PersonRows = z.array(z.object({ body: z.string(), speaker: z.string() }))
let speech: FakeSpeech | undefined
let api: VoiceApi | undefined
let bare: VoiceApi | undefined
const db = new pg.Client({ connectionString: must(process.env.DATABASE_URL, 'DATABASE_URL') })
const voices: Voice[] = []
try {
  migrate()
  addTeam(team, login)
  addPerson(team, teammate)
  addTeam(`${team}-out`, outsider)
  await db.connect()
  const machine = z.object({ token: z.string() }).parse(JSON.parse(execFileSync(process.execPath, ['server/admin.ts', 'add-instance', team, 'mac', 'mac', login], { cwd: ROOT, encoding: 'utf8' })))
  execFileSync(process.execPath, ['server/admin.ts', 'add-agent', team, 'helper', 'mac'], { cwd: ROOT, stdio: 'ignore' })
  speech = await startFakeSpeech(SPEECH_PORT, decide)
  api = await startApi(work, PORTS, `http://127.0.0.1:${SPEECH_PORT}`)
  const people = api.people
  const post = async (path: string, body: unknown, as = login) => {
    const res = await fetch(`${people}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': as }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }
  const { conversationId } = Id.parse(await post('/v1/conversations', { kind: 'dm', agent: 'helper' }))
  const { conversationId: room } = Id.parse(await post('/v1/conversations', { kind: 'room', name: `room-${id}`, people: [], agents: ['helper'] }))

  // The agent's machine: the words and the turn's end, posted the way a daemon posts them.
  const sessionOf = async () => z.object({ id: z.uuid() }).parse((await db.query('select id from sessions where conversation_id = $1', [conversationId])).rows[0]).id
  const machineCall = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORTS.machines}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  }
  // The oldest turn the machine has not finished, with its message command, claimed as the daemon does.
  const oldestOpen = async () => {
    const found = await until(async () => (await db.query(
      `select 1 from turns t join sessions s on s.id = t.session_id where s.conversation_id = $1 and t.status in ('placed', 'running')`, [conversationId])).rows.length > 0)
    if (!found) throw new Error('the post has no turn for the machine to take')
    const row = z.object({ command_id: z.uuid(), status: z.string() }).parse((await db.query(
      `select t.command_id, t.status from turns t join sessions s on s.id = t.session_id
       where s.conversation_id = $1 and t.status in ('placed', 'running') order by t.requested_at limit 1`, [conversationId])).rows[0])
    if (row.status === 'placed') await machineCall(`/v1/instance/commands/${row.command_id}/claim`, {})
    return row.command_id
  }
  let eventNumber = 0
  // The words of the oldest open turn, and its end when `usage` is among them, posted the way a daemon posts them.
  const agentPosts = async (events: { kind: 'assistant' | 'usage'; text?: string }[]) => {
    const session = await sessionOf()
    const command = await oldestOpen()
    const ending = events.some((e) => e.kind === 'usage')
    await machineCall(`/v1/sessions/${session}/events`, {
      events: events.map((e) => ({
        clientId: `agent-${id}-${++eventNumber}`, kind: e.kind, text: e.text, body: e.kind === 'assistant' ? { text: e.text } : { total_cost_usd: 0.01 * eventNumber },
      })),
      status: ending ? 'idle' : 'running', ...(ending ? { ended: { how: 'answered', ids: [command] } } : {}),
    })
  }
  const openTurns = async () => Number(z.object({ n: z.string() }).parse((await db.query(
    `select count(*) as n from turns t join sessions s on s.id = t.session_id where s.conversation_id = $1 and t.status in ('placed', 'running')`, [conversationId])).rows[0]).n)
  // Ends every turn the machine still holds, with nothing said.
  const drain = async () => { while (await openTurns() > 0) await agentPosts([{ kind: 'usage' }]) }
  const personMessages = async () => PersonRows.parse((await db.query(
    `select body, speaker from messages where conversation_id = $1 order by seq`, [conversationId])).rows)

  // ---- one whole turn ----
  const voice = await connected(api, conversationId)
  voices.push(voice)
  const ready = voice.seen[0]
  check(ready && 'json' in ready && ready.json.type === 'ready' && JSON.stringify([ready.json.inRate, ready.json.outRate]) === JSON.stringify([VOICE_IN_RATE, VOICE_OUT_RATE]),
    'the socket opens with ready, saying the rate to send audio at and the rate it will play at')
  await voice.say(fixturePcm)
  voice.send({ type: 'end' })
  check(await until(() => voice.count('thinking') === 1), 'the person ends their turn and the API says it is thinking')
  const heardJson = voice.seen.find((s) => 'json' in s && s.json.type === 'heard')
  check(heardJson && 'json' in heardJson && heardJson.json.type === 'heard' && heardJson.json.text === SENTENCE, 'heard carries the words the person said')
  check(speech.heard.length === 1 && speech.heard[0]?.wav.subarray(44).equals(fixturePcm), 'the speech service was sent exactly the audio frames the person sent')
  const posted = await personMessages()
  check(posted.length === 1 && posted[0]?.speaker === 'person' && posted[0].body === SENTENCE, 'the transcript is in the conversation as the person\'s own message')

  await agentPosts([{ kind: 'assistant', text: 'I will look into that. Checking the files' }])
  check(await until(() => voice.spoken.length === 1), 'the first complete sentence of the reply is spoken as soon as it is written')
  await until(() => voice.spoken[0]?.audio.length === pcmFor('I will look into that.').length)
  check(voice.spoken[0]?.text === 'I will look into that.' && voice.spoken[0].audio.equals(pcmFor('I will look into that.')),
    'it is sent as the audio the speech service made for that sentence, whole and in order')
  check(speech.spoken[0]?.model === TTS_MODEL && speech.spoken[0].voice === TTS_VOICE && speech.spoken[0].language === TTS_LANGUAGE,
    'the speech service was asked for the Qwen3-TTS model, its speaker and language')
  const frameSizes = voice.seen.flatMap((s) => ('audio' in s ? [s.audio.length] : []))
  check(frameSizes.length > 1 && frameSizes.slice(0, -1).every((n) => n === VOICE_FRAME_BYTES), 'the audio comes in frames of 200 ms, so the page can start at once')
  await sleep(QUIET_MS / 3)
  check(voice.spoken.length === 1, 'a sentence still being written is not spoken')

  await agentPosts([
    { kind: 'assistant', text: 'The answer is **42**. Here is `code`.\n```ts\nconst hidden = 1\n```\n- first item\n- second item' },
    { kind: 'usage' },
  ])
  check(await until(() => voice.count('done') === 1), 'when the agent\'s turn ends the reply finishes with done')
  check(JSON.stringify(voice.spoken.map((s) => s.text)) === JSON.stringify([
    'I will look into that.', 'Checking the files', 'The answer is 42.', 'Here is code.', 'first item.', 'second item',
  ]), 'the rest is spoken in order, with markdown and the code block left out and the last words of a finished event spoken')
  check(voice.spoken.every((s) => s.audio.equals(pcmFor(s.text))), 'every sentence arrived as its own audio')
  const order = voice.types.join(',')
  check(order.startsWith('ready,heard,thinking,speaking') && order.endsWith('speaking,done'), 'the states arrive in order: ready, heard, thinking, speaking, then done')
  const record = await personMessages()
  check(record.length === 2 && record[1]?.speaker === 'agent', "the agent's reply is in the conversation as text, as it is for typing")

  // ---- talking over the agent ----
  const second = voice.mark()
  speech.mode = 'ok'
  await voice.say(fixturePcm)
  voice.send({ type: 'end' })
  await until(() => voice.count('thinking') === 2)
  await agentPosts([{ kind: 'assistant', text: 'Here is the first thing. And here is the second thing.' }])
  check(await until(() => voice.spoken.length >= 7), 'a second turn is spoken as well')
  const stopsBefore = voice.count('stopped')
  await voice.say(fixturePcm.subarray(0, FRAME_BYTES * 2))
  check(await until(() => voice.count('stopped') === stopsBefore + 1), 'audio from the person while the agent speaks silences it, and the API says stopped')
  const spokenAtStop = speech.spoken.length
  await agentPosts([{ kind: 'assistant', text: 'A third sentence arrives late. And a fourth.' }, { kind: 'usage' }])
  await sleep(QUIET_MS)
  check(speech.spoken.length === spokenAtStop && !voice.seen.slice(second).some((s) => 'json' in s && s.json.type === 'done'), 'after being talked over, nothing more of that reply is spoken')
  voice.send({ type: 'stop' })

  // ---- stop while the agent is thinking, and a socket that closes ----
  const third = await connected(api, conversationId)
  voices.push(third)
  await third.say(fixturePcm)
  third.send({ type: 'end' })
  await until(() => third.count('thinking') === 1)
  third.send({ type: 'stop' })
  check(await until(() => third.count('stopped') === 1), 'stop while the agent is thinking answers stopped')
  const closing = await connected(api, conversationId)
  await closing.say(fixturePcm)
  closing.send({ type: 'end' })
  await until(() => closing.count('thinking') === 1)
  closing.ws.close()
  await until(() => closing.closed !== null)
  const spokenBeforeClose = speech.spoken.length
  await agentPosts([{ kind: 'usage' }])
  await agentPosts([{ kind: 'assistant', text: 'Nobody is listening to this sentence. Or this one.' }, { kind: 'usage' }])
  await sleep(QUIET_MS)
  check(speech.spoken.length === spokenBeforeClose, 'a socket that closed mid-turn gets nothing spoken for it')

  // ---- speaking again while the last turn is still being posted ----
  await drain()
  const quick = await connected(api, conversationId)
  voices.push(quick)
  const postsBefore = (await personMessages()).length
  speech.mode = 'hold'
  await quick.say(fixturePcm)
  quick.send({ type: 'end' })
  await until(() => speech !== undefined && speech.waiting() === 1)
  await quick.say(fixturePcm)
  quick.send({ type: 'end' })
  speech.mode = 'ok'
  speech.release()
  check(await until(async () => (await personMessages()).length === postsBefore + 2), 'a turn ended while the last was still being read is queued and posted too, and neither is lost')
  check(quick.count('heard') === 2 && quick.errors().length === 0, 'both turns are heard, with no error')
  await drain()

  // ---- the reply to this post, not an earlier one ----
  const mate1 = await connected(api, conversationId)
  voices.push(mate1)
  await post(`/v1/conversations/${conversationId}/messages`, { text: 'A typed question, asked first.' })
  await mate1.say(fixturePcm)
  mate1.send({ type: 'end' })
  await until(() => mate1.count('thinking') === 1)
  await until(async () => (await openTurns()) === 2)
  const spokenBefore = mate1.spoken.length
  await agentPosts([{ kind: 'assistant', text: 'Working on the typed question. Nearly there.' }])
  await sleep(QUIET_MS)
  await agentPosts([{ kind: 'assistant', text: 'This answers the typed question. It says so.' }, { kind: 'usage' }])
  await sleep(QUIET_MS)
  check(mate1.spoken.length === spokenBefore && mate1.count('done') === 0, "while the agent answers an earlier post, that answer is not spoken as the reply to the spoken one")
  await agentPosts([{ kind: 'assistant', text: 'This answers the spoken sentence. Done now.' }, { kind: 'usage' }])
  check(await until(() => mate1.count('done') === 1), 'the reply to the spoken post finishes with done')
  check(JSON.stringify(mate1.spoken.map((x) => x.text)) === JSON.stringify(['This answers the spoken sentence.', 'Done now.']), 'and only the reply to the spoken post was spoken')

  // ---- what goes wrong ----
  const wrong = await connected(api, conversationId)
  voices.push(wrong)
  wrong.send({ type: 'end' })
  check(await until(() => wrong.errors().includes(VOICE_WORDS.noAudio)), 'ending a turn with no audio says so in words')
  await wrong.say(Buffer.alloc(VOICE_IN_RATE * 2 * 61))
  wrong.send({ type: 'end' })
  check(await until(() => wrong.errors().includes(VOICE_WORDS.utteranceTooLong)), 'a turn past 60 seconds is refused in words')
  speech.decide = () => ''
  await wrong.say(fixturePcm)
  wrong.send({ type: 'end' })
  check(await until(() => wrong.errors().includes(VOICE_WORDS.nothingHeard)), 'speech with no words in it says it heard nothing')
  speech.decide = decide
  speech.mode = 'error'
  await wrong.say(fixturePcm)
  wrong.send({ type: 'end' })
  check(await until(() => wrong.errors().includes(SPEECH_WORDS.unreadable)), 'a speech service that fails gives the person its words')
  speech.mode = 'ok'
  const postedBefore = (await personMessages()).length
  await wrong.say(fixturePcm)
  wrong.send({ type: 'end' })
  check(await until(() => wrong.count('thinking') >= 1) && (await personMessages()).length === postedBefore + 1, 'after those errors the same socket takes another turn')
  wrong.ws.send('not json')
  check(await until(() => wrong.closed?.code === VoiceClose.unreadable && wrong.closed.reason === VOICE_CLOSE_WORDS.unreadable), 'a text message that is not end or stop closes the socket with its reason')

  // ---- who may ----
  const otherSite = await open(api, conversationId, login, 'http://evil.example')
  check('status' in otherSite && otherSite.status === 403, "a page from another site is refused with 403, since the socket carries the person's identity")
  const noOrigin = await open(api, conversationId, login, null)
  check('status' in noOrigin && noOrigin.status === 403, 'a connection that sends no origin is refused with 403')
  const noLogin = await open(api, conversationId, null)
  check('status' in noLogin && noLogin.status === 401, 'a connection with no Tailscale login is refused with 401')
  const notTeam = await open(api, conversationId, `nobody-${id}@example.com`)
  check('status' in notTeam && notTeam.status === 403, 'a login that is on no team is refused with 403')
  const mate = await open(api, conversationId, teammate)
  check('voice' in mate && await until(() => mate.voice.closed?.code === VoiceClose.notFound), "a teammate cannot talk in another person's conversation with an agent")
  const otherTeam = await open(api, conversationId, outsider)
  check('voice' in otherTeam && await until(() => otherTeam.voice.closed?.code === VoiceClose.notFound), 'a person on another team cannot either')
  const inRoom = await open(api, room, login)
  check('voice' in inRoom && await until(() => inRoom.voice.closed?.code === VoiceClose.notOneAgent && inRoom.voice.closed.reason === VOICE_CLOSE_WORDS.notOneAgent),
    'a room is refused, since voice chat is with one agent')
  const noSuch = await open(api, '00000000-0000-4000-8000-000000000000', login)
  check('voice' in noSuch && await until(() => noSuch.voice.closed?.code === VoiceClose.notFound), 'a conversation that does not exist is refused')
  const onMachinePort = new WebSocket(`ws://127.0.0.1:${PORTS.machines}/v1/voice/conversations/${conversationId}`, { headers: { origin, 'tailscale-user-login': login } })
  const machineStatus = await new Promise<number>((resolve) => {
    onMachinePort.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0) })
    onMachinePort.once('open', () => { resolve(101) })
    onMachinePort.once('error', () => undefined)
  })
  check(machineStatus === 400 || machineStatus === 404, `the machine port does not take voice chat (answered ${machineStatus})`)

  // ---- no speech service ----
  bare = await startApi(work, BARE_PORTS, undefined)
  const unset = await connected(bare, conversationId)
  voices.push(unset)
  await unset.say(fixturePcm)
  unset.send({ type: 'end' })
  check(await until(() => unset.errors().includes(SPEECH_WORDS.notSetUp)), 'with no speech service set up the person is told so, and the socket stays open')
} finally {
  for (const v of voices) v.ws.close()
  await bare?.stop()
  await api?.stop()
  speech?.server.close()
  speech?.server.closeAllConnections()
  await db.end()
  await dropTeam(team)
  await dropTeam(`${team}-out`)
  rmSync(work, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
