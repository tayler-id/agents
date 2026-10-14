// What the CLI asks the browser session for, and what it answers. The session
// server and the CLI both parse every message with these schemas, so they agree
// on one definition.

import type { Page } from '@playwright/test'
import { z } from 'zod'
import { ENGINE, WIDTH } from '../shared/verification.ts'

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

export const Target = z.enum(['browser', 'desktop'])
export type Target = z.infer<typeof Target>

// An element, found the way a person finds it: by its role and accessible name,
// optionally by text inside it, optionally inside a named container.
export const Handle = z.object({
  role: Role,
  name: z.string().optional(),
  text: z.string().optional(),
  // The container: a role, with its accessible name, or the text inside it for containers that have no name, such as list items.
  within: z.object({ role: Role, name: z.string().optional(), text: z.string().optional() }).optional(),
})
export type Handle = z.infer<typeof Handle>

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping') }),
  z.object({ op: z.literal('goto'), route: z.string() }),
  z.object({ op: z.literal('click'), handle: Handle }),
  z.object({ op: z.literal('fill'), handle: Handle, value: z.string() }),
  // A choice by its label, or by its value when the label changes from run to run, such as one with a time in it.
  z.object({ op: z.literal('select'), handle: Handle, option: z.union([z.object({ label: z.string() }), z.object({ value: z.string() })]) }),
  z.object({ op: z.literal('check'), handle: Handle, on: z.boolean() }),
  z.object({ op: z.literal('press'), key: z.string(), handle: Handle.optional() }),
  z.object({ op: z.literal('type'), text: z.string() }),
  z.object({ op: z.literal('wait'), handle: Handle, gone: z.boolean() }),
  // With `holds`, waits until the text holds those words, since lists refresh every few seconds.
  z.object({ op: z.literal('text'), handle: Handle, holds: z.string().optional() }),
  // With `equals`, waits until that many match, since lists fill in as rows arrive.
  z.object({ op: z.literal('count'), handle: Handle, equals: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal('snapshot'), path: z.string() }),
  z.object({ op: z.literal('screenshot'), path: z.string(), full: z.boolean() }),
  z.object({ op: z.literal('console') }),
  z.object({ op: z.literal('network'), path: z.string() }),
  z.object({ op: z.literal('trace'), action: z.enum(['start', 'stop']), path: z.string() }),
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
  target: Target, engine: ENGINE, width: WIDTH, login: z.string(), timeoutMs: z.number().int().positive(), op: Op,
})
export type SessionRequest = z.infer<typeof SessionRequest>

export const Violation = z.object({ id: z.string(), impact: z.string(), help: z.string(), nodes: z.number().int(), target: z.string() })
export const Offender = z.object({ element: z.string(), right: z.number() })
export const Capture = z.object({
  engine: ENGINE, width: WIDTH, file: z.string(),
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
  // True when the operation found its end state already in place and changed nothing.
  already: z.boolean().optional(),
  files: z.array(z.string()),
  // What the operation read from the page: text, a tree, errors, requests,
  // element names. It is outside text, kept out of `summary`, which holds only
  // what the tool knows.
  outside: z.string().optional(),
  count: z.number().int().optional(),
  errors: z.array(z.string()).optional(),
  violations: z.array(Violation).optional(),
  overflow: z.object({ width: z.number(), scrollWidth: z.number(), offenders: z.array(Offender) }).optional(),
  focus: z.string().optional(),
  path: z.array(z.string()).optional(),
  captures: z.array(Capture).optional(),
  network: z.array(z.object({ method: z.string(), url: z.string(), status: z.number().int().nullable(), failed: z.string().nullable(), ms: z.number() })).optional(),
})
export type Found = z.infer<typeof Found>

export const SessionReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), found: Found }),
  // `outside` holds the page's words a failure read, such as the choices a box offers.
  z.object({ ok: z.literal(false), error: z.string(), outside: z.string().optional(), url: z.string(), files: z.array(z.string()) }),
])
export type SessionReply = z.infer<typeof SessionReply>
