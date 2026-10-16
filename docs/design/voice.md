# Voice: dictation and voice chat

Tayler decided on 2026-10-16 that people talk to agents, not only type (`docs/decisions.md`, "Voice: talking to agents, not only typing"). This is the design for the two pieces in order: dictation, then voice chat. Meetings come later and reuse both.

## Where speech runs

Speech runs on the server Mac, with no cloud account. Speech to text is Parakeet (`mlx-community/parakeet-tdt-0.6b-v3`). Speech is Qwen3-TTS (`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit`). Both are already in the Hugging Face cache from Tayler's own voice setup. Agents still think in Claude Code, so voice never answers for an agent.

Tayler's `qwaudio-local` service on port 8767 is not the one to call. It is a full-duplex pipeline that speaks the OpenAI realtime protocol over a WebSocket, with its own local language model in the middle. It has no endpoint that turns a clip into text, and no endpoint that speaks a given sentence. Using it would mean running its model on every clip and coaxing it to repeat our words.

The same Python environment also holds `mlx_audio.server`, a plain HTTP server over the same two models. It has `POST /v1/audio/transcriptions` (multipart file, returns `{text}` with `response_format=json`) and `POST /v1/audio/speech` (JSON in, WAV out). Agents calls that. It needs no install and no new model. It loads each model the first time a request names it.

Start it on the server Mac with:

```
~/.local/share/uv/tools/speech-to-speech/bin/python -m mlx_audio.server --host 127.0.0.1 --port 8770
```

`AGENTS_SPEECH_URL=http://127.0.0.1:8770` tells the API where it is. Without that variable the API treats speech as not set up.

**This does not start yet.** `mlx_audio.server` imports `webrtcvad` and its upload route needs `python-multipart`, and neither is installed in that environment. Both are small packages. Installing them is Tayler's call (see the build log). I did not install anything. What I checked by hand with the cached models, importing `mlx_audio` directly: Parakeet loaded in 5.5 s and read the fixture back as exactly "Please schedule the design review for Tuesday morning." in 1.0 s, and Qwen3-TTS (speaker Aiden, as in Tayler's setup) made 2.3 s of 24 kHz audio in 1.05 s. The HTTP layer in front of them has not run, so the request shapes in `server/speech.ts` come from reading the server's code.

## How the API reaches it

`server/speech.ts` is the one place that talks to the service. It has two calls, `transcribe(wav)` and `speak(text)`. Everything else in the server sees only text, PCM and `HttpError`. A stand-in server that speaks the same two endpoints stands in for the service in checks.

## When it is down

A person never sees "fetch failed". Each failure has a status and a sentence:

| Cause | Status | Words |
| --- | --- | --- |
| `AGENTS_SPEECH_URL` not set | 503 | Speech to text is not set up on this server yet. |
| Nothing listening, connection refused | 503 | The speech service is not running. Ask whoever runs the server to start it, then try again. |
| No answer within 30 s | 504 | The speech service took too long. Try a shorter clip. |
| The service answers with an error or something unreadable | 502 | The speech service could not read that clip. |
| Too many clips in flight | 429 | Speech to text is busy. Try again in a moment. |

Typing keeps working in every case. Dictation is an addition to the message box.

## Limits

- A clip is at most 60 seconds and 10 MB. The size is checked while the body streams in, so an oversized upload stops at the limit. The length is read from the audio itself, not from a header the client sets.
- Accepted types are `audio/wav` (16-bit PCM or 32-bit float, any rate, mono or stereo) and `audio/webm`. The first bytes must match the declared type.
- WebM is converted with `ffmpeg` to 16 kHz mono WAV before the service sees it. If `ffmpeg` is missing the answer is a 503 that says so.
- At most 3 clips are transcribed at once, since the Mac has one set of speech models and agents' own work shares it.
- A clip with no speech returns `{ "text": "" }` with status 200. The page says it heard nothing.

## Access

Only a signed-in person on a team reaches `/v1/transcribe`, on the people side. The machine port gives a 404, so a box cannot spend the Mac's speech models. People's changes must declare JSON so another site cannot post as them. Audio types are not safe for a cross-site form, since a browser asks permission first and this API never grants it, so `/v1/transcribe` alone accepts an audio content type.

The voice chat socket checks the page's origin against `AGENTS_PEOPLE_ORIGINS`, as screens do, and checks the person can post in the conversation.

## Latency

- Measured by hand on this Mac with the cached model: Parakeet loads in 5.5 s, then reads a 3 second clip in 1.0 s. The first clip after the service starts pays the load. The 30 s limit covers it.
- Voice chat speaks one sentence at a time. The first sentence is on its way as soon as the agent finishes it, so the wait is the agent's time to first sentence plus one speech request, not the whole reply.

## What the record keeps

- Transcripts, yes. Dictation text goes into the message box and is saved when the person sends it, like any typed message. A voice chat turn is saved as an ordinary message from the person, and the agent's reply is saved as it always is. Both appear in the conversation as text.
- Audio, no. A clip is held in memory for the length of the request and dropped. Nothing is written to disk or Postgres. Keeping audio would need consent for recording, a size policy and a place to store it, and no feature needs it today. Meetings may argue for it again, and that argument belongs in the meetings design.
- No migration. Messages already carry what a transcript needs, so 0026 stays unused.

## Dictation

`POST /v1/transcribe`, body is the raw audio, `content-type` is `audio/wav` or `audio/webm` (a `;codecs=opus` parameter is fine). It returns `{ "text": "..." }`. The errors above and these:

| Cause | Status | Words |
| --- | --- | --- |
| Not audio the server takes | 415 | Send the recording as WAV or WebM. |
| Body bigger than 10 MB | 413 | That recording is too large. The limit is 10 MB. |
| Longer than 60 s | 413 | That recording is too long. The limit is 60 seconds. |
| Bytes do not match the type | 400 | That file is not a WAV or WebM recording. |
| Empty body | 400 | That recording is empty. |

## Voice chat

One WebSocket per conversation with an agent: `GET /v1/voice/conversations/{conversationId}`, upgraded on the people side.

1. The person's audio goes up as binary frames of 16-bit little-endian PCM, mono, 16 kHz. The page ends a turn with the text message `{"type":"end"}`. Detecting silence is the page's job for now.
2. The server turns the frames into WAV, transcribes them, and posts the text as the person's message through the same code as typing (`sendPersonMessage`). The agent takes the turn as it would a typed one.
3. The server watches the agent's reply in the record. Each time a complete sentence appears it asks Qwen3-TTS to speak it and sends the result as binary frames of 16-bit little-endian PCM, mono, 24 kHz, before it starts the next sentence.
4. The text message `{"type":"stop"}`, or a new `end`, stops the agent's speech at once. It sends no more frames and says so.

The server sends text messages for state, so the page needs no guessing: `ready`, `listening`, `heard` (the transcript), `thinking`, `speaking` (the sentence), `done`, `stopped`, and `error`. The exact shapes are in `shared/voice.ts` and in the report for the UI.

Voice chat does not interrupt the agent's thinking. Talking over the agent stops its speech. It does not cancel the turn, which the interrupt button does.

## Not covered

- Silence detection on the server, so the page needs a push-to-talk button or its own detector.
- Streaming a partial transcript while the person is still talking.
- Choosing a voice per agent. Every agent speaks with the service's default voice.
- Meetings, where each person's audio is transcribed separately.
