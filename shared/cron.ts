// Five-field cron schedules (minute, hour, day of month, month, day of week) in
// the server's local time, with *, numbers, lists, ranges and steps.

function field(spec: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    const [low, high] = range === '*' ? [min, max] : range.split('-').map(Number)
    const from = low ?? NaN
    const to = high ?? (stepText === undefined ? from : max)
    if (![from, to, step].every(Number.isInteger) || from < min || to > max || from > to || step < 1) {
      throw new Error(`bad cron field: ${spec}`)
    }
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): (date: Date) => boolean {
  const parts = expr.trim().split(/\s+/)
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts
  if (parts.length !== 5 || !minuteSpec || !hourSpec || !domSpec || !monthSpec || !dowSpec) throw new Error('a cron schedule has five fields')
  const minute = field(minuteSpec, [0, 59])
  const hour = field(hourSpec, [0, 23])
  const dom = field(domSpec, [1, 31])
  const month = field(monthSpec, [1, 12])
  const dow = field(dowSpec, [0, 7])
  if (dow.has(7)) dow.add(0)
  // As in cron: when both day fields are set, either one matching is enough.
  const either = domSpec !== '*' && dowSpec !== '*'
  return (d) => minute.has(d.getMinutes()) && hour.has(d.getHours()) && month.has(d.getMonth() + 1)
    && (either ? dom.has(d.getDate()) || dow.has(d.getDay()) : dom.has(d.getDate()) && dow.has(d.getDay()))
}

// The latest minute after `after` and up to `until` that the schedule fires at,
// or null. Looks back at most one day, so a long outage fires once, not many times.
export function lastFire(expr: string, after: Date, until: Date): Date | null {
  const matches = parseCron(expr)
  const t = new Date(until)
  t.setSeconds(0, 0)
  const floor = Math.max(after.getTime(), until.getTime() - 24 * 3600_000)
  for (; t.getTime() > floor; t.setMinutes(t.getMinutes() - 1)) {
    if (matches(t)) return new Date(t)
  }
  return null
}
