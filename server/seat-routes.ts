// The API's routes for a box's seats, on the machine port: which seat a session
// runs on, and a seat that is up for its agent. api.ts adds them to its own list.

import { instanceFrom } from './auth.ts'
import { pool, tx } from './db.ts'
import { parseBody, pathId, type Route } from './http.ts'
import { seatUp, sessionSeat } from './seats.ts'
import { SessionId } from '../shared/ids.ts'
import { InstanceId, type Done } from '../shared/onboarding.ts'
import { SeatInPath, SeatUp, type SessionSeat } from '../shared/seats.ts'

const UUID = '([0-9a-f-]{36})'

export const seatRoutes: Route[] = [
  // A machine starting a session, or handing it a message, asks which seat it runs on.
  ['machines', 'POST', new RegExp(`^/v1/instance/sessions/${UUID}/seat$`), async (req, [sessionId]): Promise<SessionSeat> => {
    const instanceId = InstanceId.parse((await instanceFrom(req)).id)
    return { seat: await tx((client) => sessionSeat(client, instanceId, pathId(SessionId, sessionId))) }
  }],

  // A machine's seat is up for the agent it started it for.
  ['machines', 'POST', /^\/v1\/instance\/seats\/([0-9]+)\/up$/, async (req, [n]): Promise<Done> => {
    const instanceId = InstanceId.parse((await instanceFrom(req)).id)
    const { agentId } = await parseBody(req, SeatUp)
    await seatUp(pool, instanceId, pathId(SeatInPath, n), agentId)
    return { ok: true }
  }],
]
