// A session's live tokens, while its agent types. The stream holds every chunk
// the agent has typed in the session. The view shows the newest message's text
// until the finished message arrives through sync.

import { useEffect, useState } from 'react'
import { stream } from '@durable-streams/client'
import type { LiveDelta } from '../../shared/types.ts'

export type LiveMessage = { messageId: string; text: string }

export function useLiveText(sessionId: string | null, active: boolean): LiveMessage | null {
  // Kept with the session it came from, so switching sessions never shows the old text.
  const [state, setState] = useState<{ sessionId: string | null; live: LiveMessage | null }>({ sessionId, live: null })

  useEffect(() => {
    if (!sessionId || !active) return
    const abort = new AbortController()
    const url = `${window.location.origin}/v1/streams/sessions/${sessionId}`
    const texts = new Map<string, string>()
    let newest = ''
    void (async () => {
      // The stream is created on the first token, so wait for it.
      while (!abort.signal.aborted) {
        const head = await fetch(url, { method: 'HEAD', signal: abort.signal }).catch(() => null)
        if (head?.ok) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      if (abort.signal.aborted) return
      const res = await stream<LiveDelta>({ url, offset: '-1', live: true, signal: abort.signal })
      res.subscribeJson(async (batch) => {
        for (const delta of batch.items) {
          if (delta.p || delta.k !== 'text') continue
          texts.set(delta.m, (texts.get(delta.m) ?? '') + delta.d)
          newest = delta.m
        }
        if (newest) setState({ sessionId, live: { messageId: newest, text: texts.get(newest) ?? '' } })
      })
    })().catch(() => {})
    return () => abort.abort()
  }, [sessionId, active])

  return active && state.sessionId === sessionId ? state.live : null
}
