// The API's routes for each person's own box and their Claude sign-in on it:
// the person's side on the people port, and the box's side on the machine port.
// api.ts adds them to its own list.

import { instanceFrom, personFrom } from './auth.ts'
import { makeOwnBox } from './boxes.ts'
import { cancelLogin, codeForBox, loginDone, loginFailed, loginLink, sendCode, startLogin } from './claudelogin.ts'
import { parseBody, pathId, type Route } from './http.ts'
import { wakeRunner } from './runner.ts'
import type { z } from 'zod'
import {
  ClaudeCodeBody, ClaudeLoginId, LoginDoneBody, LoginFailedBody, LoginLinkBody,
  type BoxMade, type Done, type LoginCodeReply, type LoginStarted,
} from '../shared/onboarding.ts'

const UUID = '([0-9a-f-]{36})'
const done: Done = { ok: true }
type Answer<S extends z.ZodType> = Promise<z.output<S>>

export const boxRoutes: Route[] = [
  // A box for someone on the team from before boxes were made on joining.
  ['people', 'POST', /^\/v1\/me\/box$/, async (req): Answer<typeof BoxMade> => {
    const instanceId = await makeOwnBox(await personFrom(req))
    // The runner starts its container.
    void wakeRunner()
    return { instanceId }
  }],

  ['people', 'POST', /^\/v1\/me\/claude-login$/, async (req): Answer<typeof LoginStarted> => ({ loginId: await startLogin(await personFrom(req)) })],

  ['people', 'POST', new RegExp(`^/v1/claude-logins/${UUID}/code$`), async (req, [loginId]): Promise<Done> => {
    const person = await personFrom(req)
    await sendCode(person, pathId(ClaudeLoginId, loginId), (await parseBody(req, ClaudeCodeBody)).code)
    return done
  }],

  ['people', 'POST', new RegExp(`^/v1/claude-logins/${UUID}/cancel$`), async (req, [loginId]): Promise<Done> => {
    await cancelLogin(await personFrom(req), pathId(ClaudeLoginId, loginId))
    return done
  }],

  // The box's side. Its token says which box it is, and it acts only on its own sign-ins.
  ['machines', 'POST', new RegExp(`^/v1/instance/claude-logins/${UUID}/link$`), async (req, [loginId]): Promise<Done> => {
    const instance = await instanceFrom(req)
    await loginLink(instance, pathId(ClaudeLoginId, loginId), (await parseBody(req, LoginLinkBody)).url)
    return done
  }],

  ['machines', 'POST', new RegExp(`^/v1/instance/claude-logins/${UUID}/code$`), async (req, [loginId]): Answer<typeof LoginCodeReply> =>
    ({ code: await codeForBox(await instanceFrom(req), pathId(ClaudeLoginId, loginId)) })],

  ['machines', 'POST', new RegExp(`^/v1/instance/claude-logins/${UUID}/done$`), async (req, [loginId]): Promise<Done> => {
    const instance = await instanceFrom(req)
    await loginDone(instance, pathId(ClaudeLoginId, loginId), (await parseBody(req, LoginDoneBody)).validDays)
    return done
  }],

  ['machines', 'POST', new RegExp(`^/v1/instance/claude-logins/${UUID}/failed$`), async (req, [loginId]): Promise<Done> => {
    const instance = await instanceFrom(req)
    await loginFailed(instance, pathId(ClaudeLoginId, loginId), (await parseBody(req, LoginFailedBody)).reason)
    return done
  }],
]
