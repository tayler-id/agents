// A caught error's message. What is thrown can be anything, so it is never
// assumed to be an Error.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Whether a caught error is a system error with this code, such as ENOENT.
export const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code
