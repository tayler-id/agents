// What a step shows in a replay: its whole content, read from the event's body,
// which keeps a tool call's whole input and a tool result's whole content. The
// text column is cut for search and shows too little. The harnesses write the
// bodies in their own shapes, so every field is read defensively, and a step
// whose body has none of what its kind should have shows its text instead.

import { z } from 'zod'
import type { StepBlock } from '../shared/history.ts'
import type { EventKind } from '../shared/types.ts'

const Fields = z.record(z.string(), z.unknown())
const fieldsOf = (body: unknown): Record<string, unknown> => Fields.safeParse(body).data ?? {}

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

// A value as a person reads it: a string as written, anything else as indented JSON.
function shown(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

// A tool's input, one block for each field, in the order the harness wrote them.
function inputBlocks(input: unknown): StepBlock[] {
  const fields = Fields.safeParse(input)
  if (fields.success) return Object.entries(fields.data).map(([label, value]) => ({ label, text: shown(value) }))
  return input === undefined ? [] : [{ label: null, text: shown(input) }]
}

// A tool's result: a string, or blocks of text, images and other things.
function resultBlocks(content: unknown): StepBlock[] {
  if (!Array.isArray(content)) return content === undefined ? [] : [{ label: null, text: shown(content) }]
  return content.map((part: unknown): StepBlock => {
    const fields = fieldsOf(part)
    if (fields.type === 'text' && typeof fields.text === 'string') return { label: null, text: fields.text }
    // The terminal reader leaves images on the Mac and says so in place of the image.
    if (fields.type === 'image') return { label: 'image', text: stringOf(fields.omitted) ?? 'An image, not shown here.' }
    return { label: stringOf(fields.type) ?? null, text: shown(part) }
  })
}

// How a turn went, from the fields Claude puts on its result line.
function turnFacts(fields: Record<string, unknown>): string {
  const took = numberOf(fields.duration_ms)
  const cost = numberOf(fields.total_cost_usd)
  const turns = numberOf(fields.num_turns)
  const why = stringOf(fields.terminal_reason) ?? stringOf(fields.stop_reason) ?? stringOf(fields.stopReason)
  const lines = [
    took === undefined ? null : `Took ${(took / 1000).toFixed(1)} s`,
    turns === undefined ? null : `${String(turns)} ${turns === 1 ? 'turn' : 'turns'} of the model`,
    cost === undefined ? null : `Session cost so far $${cost.toFixed(4)}`,
    why === undefined ? null : `Ended: ${why}`,
  ]
  return lines.filter((line) => line !== null).join('\n')
}

export function stepBlocks(kind: EventKind, text: string | null, body: unknown): StepBlock[] {
  const fields = fieldsOf(body)
  const own = (...values: (string | undefined)[]): StepBlock[] => {
    const found = values.find((value) => value !== undefined) ?? text
    return found === null ? [] : [{ label: null, text: found }]
  }
  switch (kind) {
    case 'user': {
      const images = numberOf(fields.images) ?? 0
      return [...own(stringOf(fields.text)), ...(images > 0 ? [{ label: null, text: `${String(images)} ${images === 1 ? 'image stays' : 'images stay'} on the Mac.` }] : [])]
    }
    case 'assistant':
      return own(stringOf(fields.text))
    case 'thinking':
      return own(stringOf(fields.thinking))
    case 'tool_call':
    case 'ask': {
      const blocks = inputBlocks(fields.input)
      const description = stringOf(fields.description)
      if (!blocks.length) return own()
      return description === undefined ? blocks : [{ label: 'description', text: description }, ...blocks]
    }
    case 'tool_result': {
      const blocks = resultBlocks(fields.content)
      return blocks.length ? blocks : own()
    }
    case 'answer': {
      const decision = stringOf(fields.decision)
      const message = stringOf(fields.message)
      if (decision === undefined) return own()
      return [{ label: null, text: message ? `${decision}: ${message}` : decision }]
    }
    case 'usage': {
      const facts = turnFacts(fields)
      return [{ label: null, text: facts || 'The turn ended.' }]
    }
    case 'error': {
      const stderr = stringOf(fields.stderr)
      const reason = own(stringOf(fields.result))
      return stderr ? [...reason, { label: 'stderr', text: stderr }] : reason
    }
    case 'notice': {
      const cwd = stringOf(fields.cwd)
      const model = stringOf(fields.model)
      if (fields.subtype === 'init' && (cwd !== undefined || model !== undefined)) {
        return [{ label: null, text: [model === undefined ? null : `Model ${model}`, cwd === undefined ? null : `Folder ${cwd}`].filter((line) => line !== null).join('\n') }]
      }
      return own(stringOf(fields.text))
    }
  }
}
