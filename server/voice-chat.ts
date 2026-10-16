// Voice chat: a person talks to an agent over a WebSocket. Their speech becomes a message
// posted to the conversation, exactly as if they had typed it, so the agent takes a turn as it always
// does and the record keeps the words as text. The agent's reply is watched in the record and spoken
// back one sentence at a time as each sentence is written. Audio is never kept.

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import { personFrom } from './auth.ts'
import { pcmToWav } from './audio.ts'
import { many, maybe, pool, tx } from './db.ts'
import { HttpError, sendPersonMessage, type Person } from './record.ts'
import { refuse } from './screens.ts'
import { sentencesFrom, speakable } from './sentences.ts'
import { speak, transcribe } from './speech.ts'
import { messageOf } from '../shared/errors.ts'
import { ConversationId } from '../shared/ids.ts'
import { bytesOf } from '../shared/websocket.ts'
import {
  MAX_CLIP_SECONDS, VOICE_CLOSE_WORDS, VOICE_FRAME_BYTES, VOICE_IN_RATE, VOICE_OUT_RATE, VOICE_REPLY_WAIT_SECONDS, VOICE_WORDS, VoiceClose,
  VoiceFromPage, type VoiceFromServer,
} from '../shared/voice.ts'

const VOICE_PATH = /^\/v1\/voice\/conversations\/([0-9a-f-]{36})$/
// The largest message the API takes from a page. Audio frames are tens of milliseconds, and this holds eight seconds of them.
const VOICE_MAX_FRAME = 256 * 1024
// A person's turn is held in memory until they end it, so it is capped at the longest clip dictation takes.
const MAX_UTTERANCE_BYTES = MAX_CLIP_SECONDS * VOICE_IN_RATE * 2
// How often the record is read for new words from the agent. A reply starts to be spoken within this of its first sentence.
const REPLY_POLL_MS = 250

const voiceSockets = new WebSocketServer({ noServer: true, maxPayload: VOICE_MAX_FRAME })

// Whether this upgrade is for voice chat.
export const isVoiceUpgrade = (req: IncomingMessage) => VOICE_PATH.test(new URL(req.url ?? '/', 'http://localhost').pathname)

type Chat = { conversationId: ConversationId } | { refused: keyof typeof VoiceClose }

// A conversation the person may talk in, with one agent that answers.
async function chatFor(person: Person, id: string): Promise<Chat> {
  const conversationId = ConversationId.safeParse(id)
  if (!conversationId.success) return { refused: 'notFound' }
  const row = await maybe<{ kind: string; agent_id: string | null; member: boolean }>(pool,
    `select c.kind, c.agent_id, exists (select 1 from conversation_members m where m.conversation_id = c.id and m.person_id = $2) as member
     from conversations c where c.id = $1 and c.team_id = $3 and c.archived_at is null`, [conversationId.data, person.id, person.team_id])
  if (!row || !row.member) return { refused: 'notFound' }
  if ((row.kind !== 'main' && row.kind !== 'dm') || !row.agent_id) return { refused: 'notOneAgent' }
  return { conversationId: conversationId.data }
}

// An upgrade for voice chat. The page's origin must be one the app is served from, as for screens, since the
// socket carries the person's identity.
export async function voiceUpgrade(origins: ReadonlySet<string>, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const onError = (error: Error) => { console.error(`voice upgrade for ${req.url ?? '/'}: ${error.message}`) }
  socket.on('error', onError)
  try {
    const id = VOICE_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1] ?? ''
    const origin = req.headers.origin
    if (origin === undefined || !origins.has(origin)) throw new HttpError(403, VOICE_WORDS.notAllowed)
    const person = await personFrom(req)
    const chat = await chatFor(person, id)
    socket.off('error', onError)
    voiceSockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (error) => { console.error(`voice chat ${id}: ${error.message}`) })
      if ('refused' in chat) ws.close(VoiceClose[chat.refused], VOICE_CLOSE_WORDS[chat.refused])
      else talk(ws, person, chat.conversationId)
    })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error(error)
    refuse(socket, status, error instanceof HttpError ? error.message : 'internal error')
  }
}

// The sentences of the agent's reply as they are written, until its turn ends.
async function* reply(conversationId: ConversationId, sessionId: string, afterSeq: number, userSeq: number, signal: AbortSignal): AsyncGenerator<string> {
  const deadline = Date.now() + VOICE_REPLY_WAIT_SECONDS * 1000
  // How far into each event's speakable words has been handed on.
  const handed = new Map<string, number>()
  for (;;) {
    signal.throwIfAborted()
    // Read before the words, so a reply seen as finished is whole.
    const finished = Boolean(await maybe(pool,
      `select 1 from messages where conversation_id = $1 and speaker = 'agent' and session_id = $2 and seq > $3`, [conversationId, sessionId, afterSeq]))
    const events = await many<{ id: string; text: string }>(pool,
      `select id::text, coalesce(body->>'text', '') as text from events
       where session_id = $1 and kind = 'assistant' and parent_tool_use_id is null and seq > $2 order by seq`, [sessionId, userSeq])
    for (const [i, event] of events.entries()) {
      const words = speakable(event.text)
      // An event with a later one after it is written, so its last words are a sentence even without an end mark.
      const { sentences, next } = sentencesFrom(words, Math.min(handed.get(event.id) ?? 0, words.length), finished || i < events.length - 1)
      handed.set(event.id, next)
      yield* sentences
    }
    if (finished) return
    if (Date.now() > deadline) throw new HttpError(504, VOICE_WORDS.noReply)
    await sleep(REPLY_POLL_MS, undefined, { signal })
  }
}

// One turn: the person's speech to text, posted to the conversation, then the agent's reply spoken.
async function turn(person: Person, conversationId: ConversationId, pcm: Buffer, signal: AbortSignal, send: (message: VoiceFromServer) => void, frame: (audio: Buffer) => void) {
  const text = await transcribe(pcmToWav(pcm, VOICE_IN_RATE))
  signal.throwIfAborted()
  if (!text) throw new HttpError(400, VOICE_WORDS.nothingHeard)
  send({ type: 'heard', text })
  const posted = await tx((client) => sendPersonMessage(client, person, conversationId, text, randomUUID()))
  send({ type: 'thinking' })
  const where = await maybe<{ session_id: string; seq: string }>(pool,
    `select e.session_id, e.seq from events e join sessions s on s.id = e.session_id
     where s.conversation_id = $1 and e.client_id = $2`, [conversationId, `message:${posted.messageId}`])
  if (!where) throw new Error(`the post ${posted.messageId} has no event in the conversation's session`)
  for await (const sentence of reply(conversationId, where.session_id, posted.seq, Number(where.seq), signal)) {
    send({ type: 'speaking', text: sentence })
    const audio = await speak(sentence, signal)
    signal.throwIfAborted()
    for (let at = 0; at < audio.length; at += VOICE_FRAME_BYTES) frame(audio.subarray(at, at + VOICE_FRAME_BYTES))
  }
  send({ type: 'done' })
}

function talk(ws: WebSocket, person: Person, conversationId: ConversationId) {
  const send = (message: VoiceFromServer) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)) }
  const frame = (audio: Buffer) => { if (ws.readyState === ws.OPEN) ws.send(audio, { binary: true }) }
  let heard: Buffer[] = []
  let heardBytes = 0
  let overflowed = false
  let running: AbortController | null = null
  const clear = () => { heard = []; heardBytes = 0; overflowed = false }
  // Silences the agent and says so. A turn that already ended has nothing to stop.
  const silence = () => {
    if (!running) return
    running.abort()
    running = null
    send({ type: 'stopped' })
  }
  const start = (pcm: Buffer) => {
    const own = new AbortController()
    running = own
    turn(person, conversationId, pcm, own.signal, send, frame).catch((error: unknown) => {
      if (own.signal.aborted) return
      if (error instanceof HttpError) send({ type: 'error', error: error.message })
      else {
        console.error(`voice chat turn: ${messageOf(error)}`)
        send({ type: 'error', error: VOICE_WORDS.failed })
      }
    }).finally(() => { if (running === own) running = null })
  }

  ws.on('message', (data, isBinary) => {
    const bytes = bytesOf(data)
    if (isBinary) {
      silence()
      if (heardBytes + bytes.length > MAX_UTTERANCE_BYTES) overflowed = true
      else {
        heard.push(bytes)
        heardBytes += bytes.length
      }
      return
    }
    let message: VoiceFromPage
    try {
      message = VoiceFromPage.parse(JSON.parse(bytes.toString('utf8')))
    } catch {
      ws.close(VoiceClose.unreadable, VOICE_CLOSE_WORDS.unreadable)
      return
    }
    if (message.type === 'stop') {
      silence()
      clear()
    } else if (overflowed) {
      send({ type: 'error', error: VOICE_WORDS.utteranceTooLong })
      clear()
    } else if (!heardBytes) {
      send({ type: 'error', error: VOICE_WORDS.noAudio })
    } else {
      silence()
      start(Buffer.concat(heard))
      clear()
    }
  })
  ws.on('close', () => {
    running?.abort()
    running = null
  })
  send({ type: 'ready', inRate: VOICE_IN_RATE, outRate: VOICE_OUT_RATE })
}
