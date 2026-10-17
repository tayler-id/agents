// Reads a recording a person sends and says what it is, how long it runs, and
// turns it into WAV for the speech service. Nothing here keeps audio: a clip lives
// in memory for one request.

import { execFile } from 'node:child_process'
import { HttpError } from './record.ts'
import { hasCode } from '../shared/errors.ts'
import { MAX_CLIP_SECONDS, SPEECH_WORDS, VOICE_IN_RATE } from '../shared/voice.ts'

export type Clip = { wav: Buffer; seconds: number }

const WAV_HEADER_BYTES = 44
const PCM_FORMAT = 1
const FLOAT_FORMAT = 3
// The first four bytes of every EBML file, which is what WebM is.
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
// ffmpeg is told to stop one second past the limit, so a clip over the limit is seen as over it
// without decoding a whole hour a client sent.
const DECODE_CUTOFF_SECONDS = MAX_CLIP_SECONDS + 1
// A clip of garbage can hang a decoder, so it is killed. The limit is generous for 61 seconds of audio.
const FFMPEG_TIMEOUT_MS = 20_000

export type ClipKind = 'wav' | 'webm'

// The kind a content type names, or null when the server takes no such audio.
export function kindOf(contentType: string | undefined): ClipKind | null {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase()
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return 'wav'
  if (type === 'audio/webm') return 'webm'
  return null
}

// Raw 16-bit little-endian mono PCM as a WAV file.
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(PCM_FORMAT, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// A WAV's length in seconds, read from its own chunks, and nothing else about it trusted.
// Anything that is not 16-bit PCM or 32-bit float is refused, since those are the only
// two a browser records.
export function wavSeconds(wav: Buffer): number {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, SPEECH_WORDS.notAudio)
  }
  let bytesPerSecond = 0
  let at = 12
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      if (size < 16 || at + 8 + 16 > wav.length) throw new HttpError(400, SPEECH_WORDS.notAudio)
      const format = wav.readUInt16LE(at + 8)
      const channels = wav.readUInt16LE(at + 10)
      const rate = wav.readUInt32LE(at + 12)
      const bits = wav.readUInt16LE(at + 22)
      const ok = (format === PCM_FORMAT && bits === 16) || (format === FLOAT_FORMAT && bits === 32)
      if (!ok || channels < 1 || rate < 1) throw new HttpError(400, 'That WAV must be 16-bit or 32-bit float audio.')
      bytesPerSecond = rate * channels * (bits / 8)
    } else if (id === 'data') {
      if (!bytesPerSecond) throw new HttpError(400, SPEECH_WORDS.notAudio)
      // A recording cut short says more than it holds, so the bytes that are there count.
      const held = Math.min(size, wav.length - at - 8)
      return held / bytesPerSecond
    }
    at += 8 + size + (size % 2)
  }
  throw new HttpError(400, SPEECH_WORDS.notAudio)
}

// WebM to 16 kHz mono PCM, by ffmpeg.
function decodeWebm(webm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-t', String(DECODE_CUTOFF_SECONDS), '-f', 's16le', '-ar', String(VOICE_IN_RATE), '-ac', '1', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: DECODE_CUTOFF_SECONDS * VOICE_IN_RATE * 2 + 1024, timeout: FFMPEG_TIMEOUT_MS },
      (error, stdout) => {
        if (!error) return resolve(stdout)
        if (hasCode(error, 'ENOENT')) return reject(new HttpError(503, SPEECH_WORDS.noConverter))
        reject(new HttpError(400, SPEECH_WORDS.notAudio))
      })
    // ffmpeg may close its input before the clip is all written, which says the clip is bad, and the
    // callback above already has that from its exit status.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(webm)
  })
}

// The clip a request carries, checked to be what its content type says and no longer than the limit.
export async function readClip(body: Buffer, contentType: string | undefined): Promise<Clip> {
  const kind = kindOf(contentType)
  if (!kind) throw new HttpError(415, SPEECH_WORDS.wrongType)
  if (!body.length) throw new HttpError(400, SPEECH_WORDS.empty)
  if (kind === 'webm') {
    if (!body.subarray(0, EBML_MAGIC.length).equals(EBML_MAGIC)) throw new HttpError(400, SPEECH_WORDS.notAudio)
    const pcm = await decodeWebm(body)
    const seconds = pcm.length / (VOICE_IN_RATE * 2)
    if (seconds > MAX_CLIP_SECONDS) throw new HttpError(413, SPEECH_WORDS.tooLong)
    return { wav: pcmToWav(pcm, VOICE_IN_RATE), seconds }
  }
  const seconds = wavSeconds(body)
  if (seconds > MAX_CLIP_SECONDS) throw new HttpError(413, SPEECH_WORDS.tooLong)
  return { wav: body, seconds }
}
