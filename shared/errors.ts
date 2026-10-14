// A caught error's message. What is thrown can be anything, so it is never
// assumed to be an Error.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Whether a caught error carries this code, such as Node's ENOENT, a process's exit status or Postgres's SQLSTATE.
export const hasCode = (error: unknown, code: string | number): boolean => error instanceof Error && 'code' in error && error.code === code
