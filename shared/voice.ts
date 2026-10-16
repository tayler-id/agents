// What dictation and voice chat share between the page, the API and the checks:
// the limits on a recording, the words a person reads when speech is down, and
// the shapes of the voice chat socket's messages.

import { z } from 'zod'

// A clip longer than this is refused. Parakeet reads a minute in a few seconds, and a
// longer one is a meeting, which has its own design.
export const MAX_CLIP_SECONDS = 60
// A minute of 16-bit stereo at 48 kHz is about 11.5 MB, so the byte limit also keeps out a
// clip recorded at a quality speech does not need.
export const MAX_CLIP_BYTES = 10 * 1024 * 1024

export const Transcript = z.object({ text: z.string() })
export type Transcript = z.infer<typeof Transcript>

// Every sentence a person can read from the speech endpoints, by what went wrong.
export const SPEECH_WORDS = {
  notSetUp: 'Speech to text is not set up on this server yet.',
  notRunning: 'The speech service is not running. Ask whoever runs the server to start it, then try again.',
  tooSlow: 'The speech service took too long. Try a shorter clip.',
  unreadable: 'The speech service could not read that clip.',
  busy: 'Speech to text is busy. Try again in a moment.',
  noConverter: 'This recording needs ffmpeg on the server to be converted, and it is not installed.',
  wrongType: 'Send the recording as WAV or WebM.',
  notAudio: 'That file is not a WAV or WebM recording.',
  empty: 'That recording is empty.',
  tooLarge: `That recording is too large. The limit is ${MAX_CLIP_BYTES / (1024 * 1024)} MB.`,
  tooLong: `That recording is too long. The limit is ${MAX_CLIP_SECONDS} seconds.`,
} as const

// Voice chat audio. The page sends 16-bit little-endian mono PCM at this rate and the API
// sends the agent's speech back as the same kind of PCM at the second rate.
export const VOICE_IN_RATE = 16_000
export const VOICE_OUT_RATE = 24_000
