// The API's routes for each person's own box. api.ts adds them to its own list.

import type { z } from 'zod'
import { personFrom } from './auth.ts'
import { makeOwnBox } from './boxes.ts'
import type { Route } from './http.ts'
import { wakeRunner } from './runner.ts'
import type { BoxMade } from '../shared/onboarding.ts'

type Answer<S extends z.ZodType> = Promise<z.output<S>>

export const boxRoutes: Route[] = [
  // A box for someone on the team from before boxes were made on joining.
  ['people', 'POST', /^\/v1\/me\/box$/, async (req): Answer<typeof BoxMade> => {
    const instanceId = await makeOwnBox(await personFrom(req))
    // The runner starts its container.
    void wakeRunner()
    return { instanceId }
  }],
]
