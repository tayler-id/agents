// Stands in for the speech service on the server Mac (mlx_audio.server), which turns a
// clip into text and a sentence into speech. It answers the two endpoints the API
// calls, in the shapes the real one uses:
//   POST /v1/audio/transcriptions  multipart file and model, answers {text}
//   POST /v1/audio/speech          JSON {model, input, voice, ...}, answers a WAV
// It cannot hear. It answers a clip with the words the check says that clip holds, but
// only when the audio it was sent is the audio the check expects, so a clip that was
// cut, changed or converted wrongly gets different words and the check fails.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { readBody } from '../shared/body.ts'
import { pcmToWav } from '../server/audio.ts'
import { VOICE_OUT_RATE } from '../shared/voice.ts'

export type SpeechMode = 'ok' | 'error' | 'garbage' | 'hold' | 'stall'

export type Heard = { model: string; responseFormat: string; wav: Buffer }
export type Spoken = { model: string; voice: string; language: string; input: string }

// A sentence as the PCM the stand-in speaks for it: 10 ms of a tone per character, at a pitch the
// text picks, so the check can say which sentence a run of frames was.
export function pcmFor(sentence: string): Buffer {
  const pitch = 200 + (Array.from(sentence).reduce((sum, c) => sum + c.charCodeAt(0), 0) % 400)
  const samples = (VOICE_OUT_RATE / 100) * sentence.length
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * pitch * i) / VOICE_OUT_RATE) * 8000), i * 2)
  return pcm
}

export type FakeSpeech = {
  server: Server
  mode: SpeechMode
  // What each clip is expected to hold, and the words to answer it with. A clip is decided by `decide`.
  heard: Heard[]
  spoken: Spoken[]
  // Requests that have arrived and not been answered, while the mode is `hold`.
  waiting: () => number
  release: () => void
  decide: (clip: Heard) => string
}

export function startFakeSpeech(port: number, decide: (clip: Heard) => string): Promise<FakeSpeech> {
  const held: (() => void)[] = []
  const fake: FakeSpeech = {
    mode: 'ok', heard: [], spoken: [], decide,
    waiting: () => held.length,
    release: () => { for (const go of held.splice(0)) go() },
    server: createServer((req, res) => { void answer(fake, held, req, res) }),
  }
  return new Promise((resolve, reject) => {
    fake.server.once('error', reject)
    fake.server.listen(port, '127.0.0.1', () => { fake.server.off('error', reject); resolve(fake) })
  })
}

const SpeechBody = z.object({ model: z.string(), input: z.string(), voice: z.string(), lang_code: z.string() })

// The most the stand-in reads of one request.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const readAll = (req: IncomingMessage) => readBody(req, MAX_REQUEST_BYTES, () => new Error('the stand-in was sent more than it reads'))

const json = (res: ServerResponse, status: number, body: string) => void res.writeHead(status, { 'content-type': 'application/json' }).end(body)

async function answer(fake: FakeSpeech, held: (() => void)[], req: IncomingMessage, res: ServerResponse) {
  try {
    if (fake.mode === 'hold') await new Promise<void>((resolve) => { held.push(resolve) })
    if (fake.mode === 'stall') {
      // Headers and the start of a body that never finishes.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' })
      return void res.write('{"te')
    }
    if (fake.mode === 'error') return json(res, 500, '{"detail":"the model fell over"}')
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const form = await new Response(new Uint8Array(await readAll(req)), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
      const file = form.get('file')
      const model = form.get('model')
      const responseFormat = form.get('response_format')
      if (!(file instanceof Blob) || typeof model !== 'string' || typeof responseFormat !== 'string') return json(res, 422, '{"detail":"file, model and response_format are required"}')
      const clip: Heard = { model, responseFormat, wav: Buffer.from(await file.arrayBuffer()) }
      fake.heard.push(clip)
      if (fake.mode === 'garbage') return json(res, 200, 'not json')
      return json(res, 200, JSON.stringify({ text: fake.decide(clip) }))
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      const body = SpeechBody.parse(JSON.parse((await readAll(req)).toString('utf8')))
      fake.spoken.push({ model: body.model, voice: body.voice, language: body.lang_code, input: body.input })
      if (fake.mode === 'garbage') return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from('not a wav'))
      return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(pcmToWav(pcmFor(body.input), VOICE_OUT_RATE))
    }
    json(res, 404, '{"detail":"Not Found"}')
  } catch (error) {
    console.error(`the speech stand-in failed: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) json(res, 500, '{"detail":"stand-in failure"}')
  }
}
