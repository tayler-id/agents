// Reads an issue's text for server/public-text.ts in a thread of its own, so a
// text the parser is slow on never holds the API. The API stops it at its
// deadline.

import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { visibleText } from './public-text.ts'

if (!parentPort) throw new Error('server/visible-text-worker.ts runs only as a worker thread')
parentPort.postMessage(visibleText(z.string().parse(workerData)))
