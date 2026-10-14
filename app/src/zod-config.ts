// The app's Content-Security-Policy forbids eval, and zod probes for it with
// new Function to compile faster parsers. Firefox logs every blocked probe as a
// console error, so the app tells zod not to try. main.tsx imports this first.
import { z } from 'zod'

z.config({ jitless: true })
