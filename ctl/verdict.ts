// What a verification proved, strongest first. A verdict comes from evidence,
// and an environment that could not run the proof is never a pass.
//   live-ui-verified    the behaviour was driven through the running app (UI, API
//                       or desktop app) and its end state observed, side effects included
//   unit-test-verified  only checks that call the code ran; nothing drove the app
//   type-check-only     only the compiler and lint ran
//   verifier-blocked    the proof could not run: the instance was unhealthy, or a
//                       prerequisite (real Claude, the forge, a box) was missing
//   verifier-failed     the proof ran on a healthy instance and the app did not
//                       do what the map says: a regression, or map drift to triage
// `map run` gives each step live-ui-verified, verifier-failed or verifier-blocked.
// The other two are for a change verified without driving the app.

import { z } from 'zod'

export const Verdict = z.enum(['live-ui-verified', 'unit-test-verified', 'type-check-only', 'verifier-blocked', 'verifier-failed'])
export type Verdict = z.infer<typeof Verdict>
