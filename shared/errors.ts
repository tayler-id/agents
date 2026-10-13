// A caught error's message. What is thrown can be anything, so it is never
// assumed to be an Error.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
