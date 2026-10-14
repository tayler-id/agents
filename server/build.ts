// The build this server process runs, read once at start. The health check
// answers with it, and every piece of evidence the runner records names it, so
// a result can be traced to the exact code that produced it.

import { buildOf } from '../shared/build.ts'

export const BUILD = buildOf(['shared', 'server', 'pipelines'])
