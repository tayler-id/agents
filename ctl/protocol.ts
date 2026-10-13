// What the CLI asks the browser session for, and what it answers. The session
// server and the CLI both parse every message with these schemas, so they agree
// on one definition.

import type { Page } from '@playwright/test'
import { z } from 'zod'

// ARIA roles Playwright finds elements by. The list is checked against
// Playwright's own type, so a role it does not know fails to compile.
const ROLES = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
] as const satisfies readonly Parameters<Page['getByRole']>[0][]
export const Role = z.enum(ROLES, {
  error: 'is not an ARIA role. The app uses button, link, textbox, combobox, checkbox, list, listitem, heading, region, form, navigation, main, complementary, status and alert. bin/agentsctl browser snapshot --aria lists what a page has.',
})
export type Role = z.infer<typeof Role>

export const Engine = z.enum(['chromium', 'firefox', 'webkit'])
export type Engine = z.infer<typeof Engine>
export const ENGINES = Engine.options
export const Viewport = z.enum(['desktop', 'phone'])
export type Viewport = z.infer<typeof Viewport>
export const VIEWPORTS = Viewport.options
export const Target = z.enum(['browser', 'desktop'])
export type Target = z.infer<typeof Target>

// An element, found the way a person finds it: by its role and accessible name,
// optionally by text inside it, optionally inside a named container.
export const Handle = z.object({
  role: Role,
  name: z.string().optional(),
  text: z.string().optional(),
  within: z.object({ role: Role, name: z.string() }).optional(),
})
export type Handle = z.infer<typeof Handle>

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping') }),
  z.object({ op: z.literal('goto'), route: z.string() }),
  z.object({ op: z.literal('click'), handle: Handle }),
  z.object({ op: z.literal('fill'), handle: Handle, value: z.string() }),
  z.object({ op: z.literal('select'), handle: Handle, option: z.string() }),
  z.object({ op: z.literal('check'), handle: Handle, on: z.boolean() }),
  z.object({ op: z.literal('press'), key: z.string(), handle: Handle.optional() }),
  z.object({ op: z.literal('type'), text: z.string() }),
  z.object({ op: z.literal('wait'), handle: Handle, gone: z.boolean() }),
  z.object({ op: z.literal('text'), handle: Handle }),
  z.object({ op: z.literal('count'), handle: Handle }),
  z.object({ op: z.literal('snapshot'), path: z.string() }),
  z.object({ op: z.literal('screenshot'), path: z.string(), full: z.boolean() }),
  z.object({ op: z.literal('console') }),
  z.object({ op: z.literal('overflow') }),
  z.object({ op: z.literal('a11y') }),
  z.object({ op: z.literal('focus') }),
  z.object({ op: z.literal('tab-to'), handle: Handle, max: z.number().int().positive() }),
  z.object({ op: z.literal('visual'), state: z.string().regex(/^[a-z0-9-]+$/), ready: Handle.optional() }),
  // A video of the page from start to stop, for a reviewer to watch the broken state.
  z.object({ op: z.literal('record'), action: z.enum(['start', 'stop']), label: z.string() }),
  z.object({ op: z.literal('close') }),
  z.object({ op: z.literal('shutdown') }),
])
export type Op = z.infer<typeof Op>
export type OpName = Op['op']

export const SessionRequest = z.object({
  target: Target, engine: Engine, viewport: Viewport, login: z.string(), timeoutMs: z.number().int().positive(), op: Op,
})
export type SessionRequest = z.infer<typeof SessionRequest>

export const Violation = z.object({ id: z.string(), impact: z.string(), help: z.string(), nodes: z.number().int(), target: z.string() })
export const Offender = z.object({ element: z.string(), right: z.number() })
export const Capture = z.object({
  engine: Engine, viewport: Viewport, file: z.string(),
  violations: z.array(Violation), overflow: z.boolean(), errors: z.array(z.string()),
})
export type Capture = z.infer<typeof Capture>

// What each operation found. `pass` is false when the operation ran but found a
// problem it exists to find: an error in the console, an accessibility
// violation, sideways scrolling, or a focus target the keyboard never reached.
export const Found = z.object({
  url: z.string(),
  summary: z.string(),
  pass: z.boolean(),
  files: z.array(z.string()),
  text: z.string().optional(),
  count: z.number().int().optional(),
  errors: z.array(z.string()).optional(),
  violations: z.array(Violation).optional(),
  overflow: z.object({ width: z.number(), scrollWidth: z.number(), offenders: z.array(Offender) }).optional(),
  focus: z.string().optional(),
  path: z.array(z.string()).optional(),
  captures: z.array(Capture).optional(),
})
export type Found = z.infer<typeof Found>

export const SessionReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), found: Found }),
  z.object({ ok: z.literal(false), error: z.string(), url: z.string(), files: z.array(z.string()) }),
])
export type SessionReply = z.infer<typeof SessionReply>
