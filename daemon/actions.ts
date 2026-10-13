// Turns an agent's screen action into the pointer events, key events, pauses
// and pastes that perform it. Everything is checked first, coordinates and key
// names alike, so a bad action sends nothing to the screen.
//
// Keys are named as xdotool names them, as in Claude's computer-use tool, so
// "ctrl+shift+t" holds Control and Shift while it presses t.
//
// Text is typed key by key when it is printable ASCII, which the box's US keymap
// holds, and pasted from the clipboard otherwise. For any other character Xvnc
// has to add a key to the keymap, and the browser often reads the key press
// before the new keymap and drops the character. Typed key by key, 9 of 18
// strings of accented, Greek, Cyrillic, CJK and emoji text arrived whole in a
// box. Pasted, with each paste waiting for the clipboard and the app as
// desktop.ts describes, 90 of 90 did.

import { Button } from '../shared/rfb.ts'
import type { ComputerAction, ScreenSize } from '../shared/screen.ts'

export class BadAction extends Error {}

// Where the pointer is and which buttons it holds. A held button stays held
// from one action to the next, as left_mouse_down asks.
export type Pointer = { x: number; y: number; buttons: number }

export type Step =
  | { kind: 'pointer'; pointer: Pointer }
  | { kind: 'key'; keysym: number; down: boolean }
  | { kind: 'wait'; ms: number }
  // Puts text on the clipboard, for the ctrl+v that follows.
  | { kind: 'clipboard'; text: string }
  // Waits until the app has asked for the pasted text, so the next key or paste
  // can't overtake it.
  | { kind: 'pasted' }

export type Plan = { steps: Step[]; pointer: Pointer; settle: boolean }

// Press and release, and the clicks of a double click, stay well inside the
// 400 ms most toolkits allow for a double click.
const CLICK_GAP_MS = 30
// xdotool types with a 12 ms gap. Chromium keeps up with less, and a paragraph
// still types in a few seconds.
const TYPE_GAP_MS = 10
// A drag moves in steps, so pages that track the mouse see it travel.
const DRAG_STEPS = 12
const DRAG_STEP_MS = 15

const RETURN = 0xff0d
const TAB = 0xff09
const NAMED_KEYS: Record<string, number> = {
  return: RETURN, enter: RETURN, kp_enter: 0xff8d, tab: TAB, iso_left_tab: 0xfe20, escape: 0xff1b, esc: 0xff1b,
  backspace: 0xff08, delete: 0xffff, del: 0xffff, insert: 0xff63, home: 0xff50, end: 0xff57,
  page_up: 0xff55, pageup: 0xff55, prior: 0xff55, page_down: 0xff56, pagedown: 0xff56, next: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, menu: 0xff67, caps_lock: 0xffe5, print: 0xff61,
  space: 0x20, minus: 0x2d, plus: 0x2b, equal: 0x3d, comma: 0x2c, period: 0x2e, slash: 0x2f, backslash: 0x5c,
  semicolon: 0x3b, apostrophe: 0x27, grave: 0x60, bracketleft: 0x5b, bracketright: 0x5d,
  ctrl: 0xffe3, control: 0xffe3, control_l: 0xffe3, control_r: 0xffe4,
  shift: 0xffe1, shift_l: 0xffe1, shift_r: 0xffe2,
  alt: 0xffe9, alt_l: 0xffe9, alt_r: 0xffea,
  super: 0xffeb, super_l: 0xffeb, super_r: 0xffec, meta: 0xffeb, cmd: 0xffeb, win: 0xffeb,
}
// F1 to F12 are consecutive keysyms.
const F1 = 0xffbe
const FUNCTION_KEYS = 12
// A character's Unicode keysym is its code point plus this.
const UNICODE_KEYSYM = 0x01000000
const CONTROL = 0xffe3
const V = 0x76

// Whether a character is on the box's US keymap: printable ASCII, newline and tab.
const onKeymap = (char: string) => char === '\n' || char === '\t' || /^[\x20-\x7e]$/.test(char)

// The keysym for one character. Printable ASCII keysyms equal their code
// points. Any other character's is its Unicode keysym, which Xvnc adds to the
// keymap when it first sees it.
export function charKeysym(char: string): number {
  if (char === '\n') return RETURN
  if (char === '\t') return TAB
  const code = char.codePointAt(0)
  if (code === undefined) throw new BadAction('an empty string has no key')
  if (code >= 0x20 && code <= 0x7e) return code
  return UNICODE_KEYSYM + code
}

// The text as runs to type and runs to paste, in order.
function runsOf(text: string): { paste: boolean; text: string }[] {
  const runs: { paste: boolean; text: string }[] = []
  for (const char of text) {
    const paste = !onKeymap(char)
    const last = runs.at(-1)
    if (last && last.paste === paste) last.text += char
    else runs.push({ paste, text: char })
  }
  return runs
}

function keyKeysym(name: string): number {
  const named = NAMED_KEYS[name.toLowerCase()]
  if (named !== undefined) return named
  const fn = /^f([0-9]{1,2})$/i.exec(name)
  const n = Number(fn?.[1])
  if (fn && n >= 1 && n <= FUNCTION_KEYS) return F1 + n - 1
  const code = name.codePointAt(0)
  if (code !== undefined && String.fromCodePoint(code) === name) return charKeysym(name)
  throw new BadAction(`"${name}" is not a key name. Use names such as Return, Tab, Escape, ctrl, shift, alt, Up or F5, or a single character`)
}

// "ctrl+shift+t" as keysyms, in the order they are pressed. A lone "+" is the
// plus key, and "ctrl++" holds Control and presses plus.
export function comboKeysyms(combo: string): number[] {
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  if (parts.some((part) => part === '')) throw new BadAction(`"${combo}" has an empty key between its plus signs`)
  return parts.map(keyKeysym)
}

const WHEEL = { up: Button.wheelUp, down: Button.wheelDown, left: Button.wheelLeft, right: Button.wheelRight } as const
const CLICKS = {
  left_click: { button: Button.left, count: 1 },
  right_click: { button: Button.right, count: 1 },
  middle_click: { button: Button.middle, count: 1 },
  double_click: { button: Button.left, count: 2 },
  triple_click: { button: Button.left, count: 3 },
} as const

export function plan(action: ComputerAction, from: Pointer, size: ScreenSize): Plan {
  const steps: Step[] = []
  const at: Pointer = { ...from }
  const send = () => { steps.push({ kind: 'pointer', pointer: { ...at } }) }
  const pause = (ms: number) => { steps.push({ kind: 'wait', ms }) }
  const inside = ([x, y]: readonly [number, number]) => {
    if (x >= size.width || y >= size.height) throw new BadAction(`(${x}, ${y}) is off the ${size.width}x${size.height} screen`)
  }
  const moveTo = (point: readonly [number, number]) => {
    inside(point)
    at.x = point[0]
    at.y = point[1]
    send()
  }
  const button = (bit: number, down: boolean) => {
    at.buttons = down ? at.buttons | bit : at.buttons & ~bit
    send()
  }
  const key = (keysym: number, down: boolean) => { steps.push({ kind: 'key', keysym, down }) }
  // Holds the combo's keys around what `inner` adds, and lets them go in reverse.
  const holding = (combo: string | undefined, inner: () => void) => {
    const keysyms = combo ? comboKeysyms(combo) : []
    for (const keysym of keysyms) key(keysym, true)
    inner()
    for (const keysym of [...keysyms].reverse()) key(keysym, false)
  }

  switch (action.action) {
    case 'screenshot':
    case 'cursor_position':
      break
    case 'mouse_move':
      moveTo(action.coordinate)
      break
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const { button: bit, count } = CLICKS[action.action]
      const where = action.coordinate
      holding(action.text, () => {
        if (where) moveTo(where)
        for (let i = 0; i < count; i++) {
          if (i > 0) pause(CLICK_GAP_MS)
          button(bit, true)
          pause(CLICK_GAP_MS)
          button(bit, false)
        }
      })
      break
    }
    case 'left_click_drag': {
      const [fromX, fromY] = action.start_coordinate
      const [toX, toY] = action.coordinate
      inside(action.coordinate)
      moveTo(action.start_coordinate)
      button(Button.left, true)
      for (let i = 1; i <= DRAG_STEPS; i++) {
        pause(DRAG_STEP_MS)
        moveTo([Math.round(fromX + ((toX - fromX) * i) / DRAG_STEPS), Math.round(fromY + ((toY - fromY) * i) / DRAG_STEPS)])
      }
      button(Button.left, false)
      break
    }
    case 'left_mouse_down':
      button(Button.left, true)
      break
    case 'left_mouse_up':
      button(Button.left, false)
      break
    case 'scroll': {
      const where = action.coordinate
      const wheel = WHEEL[action.scroll_direction]
      holding(action.text, () => {
        if (where) moveTo(where)
        for (let i = 0; i < action.scroll_amount; i++) {
          button(wheel, true)
          button(wheel, false)
          pause(CLICK_GAP_MS)
        }
      })
      break
    }
    case 'type':
      for (const run of runsOf(action.text)) {
        if (run.paste) {
          steps.push({ kind: 'clipboard', text: run.text })
          key(CONTROL, true)
          key(V, true)
          key(V, false)
          key(CONTROL, false)
          steps.push({ kind: 'pasted' })
          continue
        }
        for (const char of run.text) {
          const keysym = charKeysym(char)
          key(keysym, true)
          key(keysym, false)
          pause(TYPE_GAP_MS)
        }
      }
      break
    case 'key':
      holding(action.text, () => undefined)
      break
    case 'hold_key':
      holding(action.text, () => { pause(action.duration * 1000) })
      break
    case 'wait':
      pause(action.duration * 1000)
      break
  }
  const settle = action.action !== 'screenshot' && action.action !== 'cursor_position' && action.action !== 'wait'
  return { steps, pointer: at, settle }
}
