// Dictation: a person's recording in, the words they said out. The recording is
// held in memory for the request and dropped, so the record keeps only the text a
// person goes on to send.

import { personFrom } from './auth.ts'
import { kindOf, readClip } from './audio.ts'
import { HttpError } from './record.ts'
import { transcribe } from './speech.ts'
import type { Route } from './http.ts'
import { readBody as readWhole } from '../shared/body.ts'
import { MAX_CLIP_BYTES, SPEECH_WORDS, type Transcript } from '../shared/voice.ts'

// A browser posting a form from another site can send only a few content types without asking
// the API first, and the API never answers. Audio is not one of them, so an audio content type
// proves the request came from a page that was allowed to make it.
export const AUDIO_POST = /^\/v1\/transcribe$/

export const voiceRoutes: Route[] = [
  ['people', 'POST', AUDIO_POST, async (req) => {
    await personFrom(req)
    const contentType = req.headers['content-type']
    if (!kindOf(contentType)) throw new HttpError(415, SPEECH_WORDS.wrongType)
    const body = await readWhole(req, MAX_CLIP_BYTES, () => new HttpError(413, SPEECH_WORDS.tooLarge))
    const clip = await readClip(body, contentType)
    const result: Transcript = { text: await transcribe(clip.wav) }
    return result
  }],
]
