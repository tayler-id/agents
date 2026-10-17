// Opens a new window in a seat's browser, for a button on the seat's dock
// (daemon/dock.ts). It goes through the browser the daemon runs, found on its
// DevTools port, so it never starts another browser on the seat's profile, and
// does nothing while that browser is down.
//   node daemon/open-window.ts <DevTools address> <page address>

import { z } from 'zod'
import { browserDevtools } from './devtools.ts'

// Long enough for a browser under load to open a window.
const OPEN_WAIT_MS = 5_000

const [cdpUrl, url] = z.tuple([z.url(), z.string().min(1)]).parse(process.argv.slice(2))
const browser = await browserDevtools(cdpUrl, AbortSignal.timeout(OPEN_WAIT_MS))
try {
  await browser.send('Target.createTarget', { url, newWindow: true })
} finally {
  browser.close()
}
