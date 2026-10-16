// The one place the API talks to the speech service on the server Mac: Parakeet for
// speech to text and Qwen3-TTS for speech, both served by mlx_audio.server over HTTP.
// Failures become an HttpError with words a person reads. Nothing else in the server
// knows the service's addresses or shapes.

import { z } from 'zod'
import { HttpError } from './record.ts'
import { messageOf } from '../shared/errors.ts'
import { SPEECH_WORDS, Transcript, VOICE_OUT_RATE } from '../shared/voice.ts'

// The models Tayler chose for their own voice setup on 2026-09-12. They are in the Hugging Face
// cache on the server Mac, and the service loads each on its first request.
export const STT_MODEL = 'mlx-community/parakeet-tdt-0.6b-v3'
export const TTS_MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit'
// The speaker and language of Tayler's own setup. A CustomVoice model refuses a request that names no speaker.
export const TTS_VOICE = 'Aiden'
export const TTS_LANGUAGE = 'english'

// The first clip after the service starts also loads the model, which takes several seconds.
const STT_TIMEOUT_MS = 30_000
// A sentence of speech takes a second or two on this Mac once the model is loaded.
const TTS_TIMEOUT_MS = 60_000
// Clips transcribed at once. The Mac has one set of speech models, and agents' own work shares it.
const MAX_IN_FLIGHT = 3

const SpeechUrl = z.url({ protocol: /^https?$/ })

// Where the speech service is, or null when none is set up. A value that is not a URL stops the API
// at startup, through `checkSpeechSettings`, and not at a person's first clip.
function speechUrl(): URL | null {
  const raw = process.env.AGENTS_SPEECH_URL
  if (!raw) return null
  const parsed = SpeechUrl.safeParse(raw)
  if (!parsed.success) throw new Error(`AGENTS_SPEECH_URL must be the speech service's address, such as http://127.0.0.1:8770: ${z.prettifyError(parsed.error)}`)
  return new URL(parsed.data)
}

export function checkSpeechSettings() {
  speechUrl()
}

function service(): URL {
  const url = speechUrl()
  if (!url) throw new HttpError(503, SPEECH_WORDS.notSetUp)
  return url
}

// A request to the service. A refused or dropped connection means it is not running. Waiting too
// long and an error from the service each get their own words.
async function ask(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let response: Response
  try {
    response = await fetch(new URL(path, service()), { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new HttpError(504, SPEECH_WORDS.tooSlow)
    throw new HttpError(503, SPEECH_WORDS.notRunning)
  }
  if (!response.ok) {
    console.error(`speech service ${path} answered ${response.status}: ${(await response.text().catch(messageOf)).slice(0, 300)}`)
    throw new HttpError(502, SPEECH_WORDS.unreadable)
  }
  return response
}

let inFlight = 0

// Text from a WAV clip.
export async function transcribe(wav: Buffer): Promise<string> {
  service()
  if (inFlight >= MAX_IN_FLIGHT) throw new HttpError(429, SPEECH_WORDS.busy)
  inFlight++
  try {
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'clip.wav')
    form.set('model', STT_MODEL)
    form.set('response_format', 'json')
    const response = await ask('/v1/audio/transcriptions', { method: 'POST', body: form }, STT_TIMEOUT_MS)
    const body = Transcript.safeParse(await response.json().catch(() => null))
    if (!body.success) {
      console.error('speech service sent a transcript that is not {text}')
      throw new HttpError(502, SPEECH_WORDS.unreadable)
    }
    return body.data.text.trim()
  } finally {
    inFlight--
  }
}

// A WAV file's samples as 16-bit mono PCM at the rate voice chat sends. The service answers in
// the model's own rate, and a different one is a change to the service this code must be told about.
function pcmOf(wav: Buffer): Buffer {
  const bad = () => new HttpError(502, SPEECH_WORDS.unreadable)
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw bad()
  let rate = 0
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'fmt ' && size >= 16 && at + 24 <= wav.length) {
      const mono16 = wav.readUInt16LE(at + 8) === 1 && wav.readUInt16LE(at + 10) === 1 && wav.readUInt16LE(at + 22) === 16
      if (!mono16) throw bad()
      rate = wav.readUInt32LE(at + 12)
    } else if (id === 'data' && rate) {
      if (rate !== VOICE_OUT_RATE) {
        console.error(`speech service spoke at ${rate} Hz, and voice chat sends ${VOICE_OUT_RATE} Hz`)
        throw bad()
      }
      return wav.subarray(at + 8, Math.min(at + 8 + size, wav.length))
    }
    at += 8 + size + (size % 2)
  }
  throw bad()
}

// One sentence as 16-bit little-endian mono PCM at VOICE_OUT_RATE.
export async function speak(sentence: string): Promise<Buffer> {
  const response = await ask('/v1/audio/speech', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, input: sentence, voice: TTS_VOICE, lang_code: TTS_LANGUAGE, response_format: 'wav' }),
  }, TTS_TIMEOUT_MS)
  return pcmOf(Buffer.from(await response.arrayBuffer()))
}
