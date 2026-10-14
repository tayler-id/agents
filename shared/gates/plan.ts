// Reads an approved plan's Done means and Keep sections. Each Done means item
// names the check that shows it as "(check: test/step91.ts)". Each Keep item
// starts with a feature id from the repo's feature map in backticks.

import type { MapOnMain } from '../framework.ts'
import { matcher } from './glob.ts'
import { proseFindings, type ProseRules } from './prose.ts'

export type PlanItems = {
  done: { text: string; check: string | null }[]
  keep: { text: string; feature: string | null }[]
}

const SECTION = /^#{1,6}\s+(.+?)\s*$/
const ITEM = /^\s*(?:[-*]|\d+\.)\s+(.+)$/

export function planItems(plan: string): PlanItems {
  const out: PlanItems = { done: [], keep: [] }
  let section: 'done' | 'keep' | null = null
  for (const line of plan.split('\n')) {
    const heading = SECTION.exec(line)?.[1]?.toLowerCase()
    if (heading !== undefined) {
      section = heading === 'done means' ? 'done' : heading === 'keep' ? 'keep' : null
      continue
    }
    const item = ITEM.exec(line)?.[1]
    if (item === undefined || section === null) continue
    if (section === 'done') out.done.push({ text: item, check: /\(check:\s*([^\s)]+)\)/.exec(item)?.[1] ?? null })
    else out.keep.push({ text: item, feature: /^`([a-z][a-z0-9-]*)`/.exec(item)?.[1] ?? null })
  }
  return out
}

// What is wrong with a plan on its own, before anyone reads it or code exists:
// a Done means item that names no check file, a Keep item that names no
// feature in the map, and prose that breaks the writing rules. When the policy
// names a feature map main lacks, the plan fails with that reason rather than
// passing with its Keep items unchecked.
export function planProblems(plan: string, checks: string, prose: ProseRules, featureMap: MapOnMain): string[] {
  const items = planItems(plan)
  const isCheck = matcher([checks])
  const problems: string[] = []
  if (!items.done.length) problems.push('Done means lists nothing')
  items.done.forEach((item, i) => {
    if (item.check === null) problems.push(`Done means item ${i + 1} names no check, as (check: <path>)`)
    else if (!isCheck(item.check)) problems.push(`Done means item ${i + 1} names ${item.check}, which is not a check file (${checks})`)
  })
  if (featureMap.kind === 'missing') {
    problems.push(`the policy names the feature map ${featureMap.path}, which is not on main, so no Keep item can be checked. Add the map to main, or take it out of the policy`)
  }
  if (featureMap.kind === 'found') {
    const ids = new Set(featureMap.map.features.map((f) => f.id))
    items.keep.forEach((item, i) => {
      if (item.feature === null || !ids.has(item.feature)) problems.push(`Keep item ${i + 1} names no feature in the feature map`)
    })
  }
  for (const finding of proseFindings('plan.md', plan, prose)) problems.push(`line ${finding.line ?? 0} has ${finding.text}`)
  return problems
}

// The rule names a rubric defines: each list item that starts with a bold name,
// as the coding standards write them. A reviewer's finding cites one.
export function ruleNames(rubric: string): string[] {
  return rubric.split('\n').flatMap((line) => {
    const name = /^\s*-\s+\*\*(.+?)\*\*/.exec(line)?.[1]?.trim().replace(/\.$/, '')
    return name ? [name] : []
  })
}

// The text under a heading, up to the next heading at its level or above, or
// null when the document has no such heading or nothing under it.
export function sectionOf(document: string, heading: string): string | null {
  const lines = document.split('\n')
  const start = lines.findIndex((line) => SECTION.exec(line)?.[1]?.toLowerCase() === heading.toLowerCase())
  if (start === -1) return null
  const level = (/^#+/.exec(lines[start] ?? '')?.[0] ?? '#').length
  const end = lines.findIndex((line, i) => i > start && (/^#+(?=\s)/.exec(line)?.[0].length ?? Infinity) <= level)
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
  return body || null
}

// The headings a document has, for a stage that requires some.
export function headingsOf(document: string): Set<string> {
  return new Set(document.split('\n').flatMap((line) => {
    const heading = SECTION.exec(line)?.[1]
    return heading === undefined ? [] : [heading.toLowerCase()]
  }))
}
