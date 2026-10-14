import { createHmac } from 'node:crypto'

// A pipeline's webhook secret, derived from the server's hook secret, so each
// pipeline has its own without the server keeping one per pipeline.
export const pipelineHookSecret = (serverSecret: string, pipelineId: string) => createHmac('sha256', serverSecret).update(pipelineId).digest('hex')
