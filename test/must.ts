// A value a check needs. If it is missing the check cannot go on, so this throws
// and names what was missing, instead of failing later on undefined.
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, and there is none`)
  return value
}
