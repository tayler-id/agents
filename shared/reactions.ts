// A reaction is one emoji on a post. The emoji is a single grapheme, so a skin
// tone or a family stays whole and two emoji are refused.

import { z } from 'zod'

// The column's check says the same.
export const MAX_EMOJI_BYTES = 32

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
// A picture, a flag, or a keycap such as 1 with its enclosing square.
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[0-9#*]️?⃣$/u

export const Emoji = z.string().refine((value) => {
  if (Buffer.byteLength(value) > MAX_EMOJI_BYTES) return false
  const parts = [...segmenter.segment(value)]
  return parts.length === 1 && EMOJI.test(value)
}, 'a reaction is one emoji of at most 32 bytes')
export type Emoji = z.infer<typeof Emoji>
