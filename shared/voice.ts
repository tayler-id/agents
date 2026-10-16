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

// ---- voice chat ----
// One WebSocket per conversation with an agent, at /v1/voice/conversations/{conversationId}.
// Binary messages carry audio. Text messages carry the JSON below.

// The page's text messages. `end` closes the person's turn and sends it to the agent. `stop`
// silences the agent now. Audio arriving while the agent speaks silences it too.
export const VoiceFromPage = z.discriminatedUnion('type', [z.object({ type: z.literal('end') }), z.object({ type: z.literal('stop') })])
export type VoiceFromPage = z.infer<typeof VoiceFromPage>

export const VoiceFromServer = z.discriminatedUnion('type', [
  // Sent once on connect. The page sends audio at `inRate` and plays what it receives at `outRate`.
  z.object({ type: z.literal('ready'), inRate: z.literal(VOICE_IN_RATE), outRate: z.literal(VOICE_OUT_RATE) }),
  // What the person said, as it was posted to the conversation.
  z.object({ type: z.literal('heard'), text: z.string() }),
  // The post is in the record and the agent has not said anything speakable yet.
  z.object({ type: z.literal('thinking') }),
  // The next sentence of the reply. Binary audio frames for exactly this sentence follow.
  z.object({ type: z.literal('speaking'), text: z.string() }),
  // The whole reply has been sent. Frames already sent may still be playing.
  z.object({ type: z.literal('done') }),
  // The reply was cut short by the person. No more frames follow until the next turn.
  z.object({ type: z.literal('stopped') }),
  // This turn failed, in words a person reads. The socket stays open for the next turn.
  z.object({ type: z.literal('error'), error: z.string() }),
])
export type VoiceFromServer = z.infer<typeof VoiceFromServer>

// Why the API closed the socket, as the close code. The reason is a sentence for a person.
export const VoiceClose = {
  notFound: 4404,
  notOneAgent: 4400,
  // The page sent a text message that is not `end` or `stop`.
  unreadable: 4000,
} as const

export const VOICE_CLOSE_WORDS = {
  notFound: 'No such conversation of yours.',
  notOneAgent: 'Voice chat is for a conversation with one agent.',
  unreadable: 'Voice chat takes only end and stop as text.',
} as const

export const VOICE_WORDS = {
  nothingHeard: 'I did not catch anything. Try again.',
  noAudio: 'There was no audio to send.',
  utteranceTooLong: SPEECH_WORDS.tooLong,
  noReply: 'The agent has not answered yet. Its reply will still appear in the chat.',
  failed: 'Voice chat hit a problem. Try again.',
  notAllowed: 'Only the app may open a voice chat.',
} as const

// The audio the API sends is cut into frames of this many bytes, 200 ms of speech, so the page starts
// playing at once and can drop the rest the moment the person talks over it.
export const VOICE_FRAME_BYTES = (VOICE_OUT_RATE * 2) / 5
// Past this many seconds of the agent working with nothing speakable, the turn gives up waiting.
export const VOICE_REPLY_WAIT_SECONDS = 300
