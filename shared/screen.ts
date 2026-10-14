// An agent's computer screen: its size, who controls it and how control moves
// between an agent and a person, the messages a box and the API exchange about
// it, and the actions agents take on it. The design is docs/design/computers.md.

import { z } from 'zod'
import { PersonId, SessionId, TunnelId } from './ids.ts'

export const ScreenSize = z.object({ width: z.int().positive(), height: z.int().positive() })
export type ScreenSize = z.infer<typeof ScreenSize>

// AGENTS_DESKTOP's form, such as 1280x800.
export const ScreenSizeText = z.string().regex(/^[1-9][0-9]{2,4}x[1-9][0-9]{2,4}$/, 'a size such as 1280x800')
  .transform((text): ScreenSize => {
    const [width, height] = text.split('x').map(Number)
    return ScreenSize.parse({ width, height })
  })

// Who holds the screen's keyboard and mouse: the agents on the machine, or one
// person who took over.
export const ScreenControl = z.discriminatedUnion('holder', [
  z.object({ holder: z.literal('agent') }),
  z.object({ holder: z.literal('person'), personId: PersonId, login: z.string().min(1), since: z.iso.datetime({ offset: true }) }),
])
export type ScreenControl = z.infer<typeof ScreenControl>
type AgentHolds = Extract<ScreenControl, { holder: 'agent' }>
type PersonHolds = Extract<ScreenControl, { holder: 'person' }>
export const AGENT_HOLDS: AgentHolds = { holder: 'agent' }

// What moves control. `left` is the server giving the screen back because the
// holder has had no Screen view open for SCREEN_GRACE_MS, or may no longer
// watch it, since the box started work they can't see.
export type HandoffEvent =
  | { kind: 'take'; personId: PersonId; login: string; at: string }
  | { kind: 'hand_back'; personId: PersonId }
  | { kind: 'left'; personId: PersonId; why: 'view_closed' | 'not_allowed' }

// Where an event leads. Each change carries the control it can lead to, so code
// that handles a takeover always has the person who took it.
export type Handoff =
  | { ok: true; change: 'took_over' | 'already_held'; control: PersonHolds }
  | { ok: true; change: 'handed_back' | 'left'; control: AgentHolds }
  | { ok: false; reason: string }

// How long a person may hold the screen with no Screen view open before it goes
// back to the agent. It is long enough to reload the page or for a phone to
// change networks, and short enough that a closed tab doesn't hold an agent up.
export const SCREEN_GRACE_MS = 30_000
// How often the API looks for people who hold a screen with no view open, and
// runs the watch rule again for everyone watching.
export const SCREEN_SWEEP_MS = 5_000

type Holder = ScreenControl['holder']
type EventKind = HandoffEvent['kind']
type ControlOf<H extends Holder> = Extract<ScreenControl, { holder: H }>
type EventOf<K extends EventKind> = Extract<HandoffEvent, { kind: K }>
type Row<C> = { [K in EventKind]: (control: C, event: EventOf<K>) => Handoff }

const notHeld: Handoff = { ok: false, reason: 'The agent already has the screen.' }

// Every state and event, and where it leads.
const TRANSITIONS: { [H in Holder]: Row<ControlOf<H>> } = {
  agent: {
    take: (_control, event) => ({
      ok: true, change: 'took_over', control: { holder: 'person', personId: event.personId, login: event.login, since: event.at },
    }),
    hand_back: () => notHeld,
    left: () => notHeld,
  },
  person: {
    take: (control, event) => (control.personId === event.personId
      ? { ok: true, change: 'already_held', control }
      : { ok: false, reason: `${control.login} has the screen.` }),
    hand_back: (control, event) => (control.personId === event.personId
      ? { ok: true, change: 'handed_back', control: AGENT_HOLDS }
      : { ok: false, reason: `${control.login} has the screen, not you.` }),
    left: (control, event) => (control.personId === event.personId
      ? { ok: true, change: 'left', control: AGENT_HOLDS }
      : { ok: false, reason: `${control.login} has the screen, not you.` }),
  },
}

function step<C>(row: Row<C>, control: C, event: HandoffEvent): Handoff {
  switch (event.kind) {
    case 'take': return row.take(control, event)
    case 'hand_back': return row.hand_back(control, event)
    case 'left': return row.left(control, event)
  }
}

export function handoff(control: ScreenControl, event: HandoffEvent): Handoff {
  switch (control.holder) {
    case 'agent': return step(TRANSITIONS.agent, control, event)
    case 'person': return step(TRANSITIONS.person, control, event)
  }
}

// The box's control connection to the API's machine port. The API sends every
// change of control and asks for a tunnel per viewer. The box pings, and the
// API answers, so either side notices a dead connection.
export const ToBox = z.discriminatedUnion('type', [
  z.object({ type: z.literal('control'), control: ScreenControl }),
  z.object({ type: z.literal('open'), tunnel: TunnelId }),
  z.object({ type: z.literal('pong') }),
])
export type ToBox = z.infer<typeof ToBox>
export const FromBox = z.object({ type: z.literal('ping') })
// Colima's port forwarding and cloud load balancers drop TCP connections idle
// for about a minute. A ping every 15 seconds keeps a screen's connections
// open, and three missed answers mean one is gone. The box pings its control
// connection, and the API pings each viewer and each tunnel.
export const SCREEN_PING_MS = 15_000
export const SCREEN_DEAD_MS = 45_000

// What a machine's daemon reports every few seconds: whether it is online, and
// its screen's size, or null when it has none.
export const Heartbeat = z.object({ status: z.enum(['online', 'offline']), screen: ScreenSize.nullable().optional() })
export type Heartbeat = z.infer<typeof Heartbeat>

// A person taking over a screen or handing it back, from the session they were
// looking at, if any, and the API's answer.
export const ScreenMove = z.object({ sessionId: SessionId.nullable() })
export const ScreenMoved = z.object({ control: ScreenControl })
export type ScreenMoved = z.infer<typeof ScreenMoved>

// Text frames to a person's Screen view. Binary frames are the screen itself.
export const ToViewer = z.object({ type: z.literal('control'), control: ScreenControl })
export type ToViewer = z.infer<typeof ToViewer>

// Why a screen's WebSocket closed, with a sentence as the close reason. The
// 4000s are the range left for applications.
export const ScreenClose = {
  // The API closing a person's Screen view.
  notAllowed: 4403,
  notConnected: 4404,
  badInput: 4400,
  boxClosed: 4502,
  boxSilent: 4504,
  // The app closing its view on a control message it could not read.
  unreadable: 4000,
  // Either end of a box's control connection, on a message it could not read.
  // RFC 6455 names 1003 for data an endpoint can't accept.
  unsupported: 1003,
} as const

// Actions on the screen, named and shaped as in Claude's computer-use tool.
const Coordinate = z.tuple([z.int().min(0), z.int().min(0)]).describe('[x, y] in screen pixels from the top left')
const Keys = z.string().min(1).max(80).describe('Keys in xdotool form, such as "Return", "ctrl+l" or "ctrl+shift+t"')
const HeldKeys = z.string().min(1).max(80).describe('Keys to hold during the action, such as "shift" or "ctrl"')
// A paragraph of form input. Longer text belongs in a file, not in keystrokes.
export const MAX_TYPE_CHARS = 2000
// About two screens of scrolling per action, so the agent looks between scrolls.
export const MAX_SCROLL = 25
// Long enough for a page to load or an animation to finish, short enough that a
// stuck action never holds the screen.
export const MAX_WAIT_SECONDS = 30
const click = <A extends string>(action: A) => z.object({
  action: z.literal(action), coordinate: Coordinate.optional().describe('Where to click. The current cursor position when left out'), text: HeldKeys.optional(),
})

export const ComputerAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }),
  z.object({ action: z.literal('cursor_position') }),
  z.object({ action: z.literal('mouse_move'), coordinate: Coordinate }),
  click('left_click'),
  click('right_click'),
  click('middle_click'),
  click('double_click'),
  click('triple_click'),
  z.object({ action: z.literal('left_click_drag'), start_coordinate: Coordinate.describe('Where the drag starts'), coordinate: Coordinate.describe('Where the drag ends') }),
  z.object({ action: z.literal('left_mouse_down') }),
  z.object({ action: z.literal('left_mouse_up') }),
  z.object({
    action: z.literal('scroll'), coordinate: Coordinate.optional().describe('Where to scroll. The current cursor position when left out'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']), scroll_amount: z.int().min(1).max(MAX_SCROLL).describe('How many wheel clicks'),
    text: HeldKeys.optional(),
  }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(MAX_TYPE_CHARS).describe('The text to type') }),
  z.object({ action: z.literal('key'), text: Keys }),
  z.object({ action: z.literal('hold_key'), text: Keys, duration: z.number().positive().max(MAX_WAIT_SECONDS).describe('Seconds to hold') }),
  z.object({ action: z.literal('wait'), duration: z.number().positive().max(MAX_WAIT_SECONDS).describe('Seconds to wait') }),
])
export type ComputerAction = z.infer<typeof ComputerAction>

const Point = z.object({ x: z.int().min(0), y: z.int().min(0) })

// The box's screen service, which the `computer` MCP server calls over a Unix
// socket. An action runs only while the agents hold the screen. `epoch` counts
// changes of control, so a session can tell a person used the screen since its
// own last action, and `lastPerson` says who.
export const ActRequest = z.object({ action: ComputerAction })
export const Screenshot = z.object({ png: z.base64(), width: z.int().positive(), height: z.int().positive() })
export const ActDone = z.object({ shot: Screenshot, cursor: Point, epoch: z.int().min(0), lastPerson: z.string().nullable() })
export type ActDone = z.infer<typeof ActDone>
export const ActRefused = z.object({ control: ScreenControl })
export const ScreenStatus = z.object({ control: ScreenControl, size: ScreenSize, epoch: z.int().min(0), lastPerson: z.string().nullable() })
export type ScreenStatus = z.infer<typeof ScreenStatus>
// The names of the box's secrets that a page open in its browser shows now. A
// saved screenshot is never scrubbed, so none is saved while this names any.
export const SecretsShown = z.object({ names: z.array(z.string().min(1)) })
export type SecretsShown = z.infer<typeof SecretsShown>

// The `computer` MCP server's structured results.
export const ComputerOutput = z.object({
  width: z.int().positive(), height: z.int().positive(), cursor: Point,
  personUsedScreen: z.string().nullable().describe('Who used the screen since your last action, if anyone'),
})
export const SavedScreenshot = z.object({ path: z.string().describe("The file's path in the task folder"), bytes: z.int().positive() })
export const ScreenStatusOutput = z.object({ control: ScreenControl, size: ScreenSize })
// A screenshot's name, which becomes a file name in the task folder.
export const ScreenshotName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'lowercase letters, digits and dashes')
