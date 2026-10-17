// The API's routes for History: the sessions a person may see, a search across
// their steps, and one session for a replay. api.ts adds them to its own list.

import type { z } from 'zod'
import { personFrom } from './auth.ts'
import { listSessions, searchSteps, sessionSteps, sessionView } from './history.ts'
import { pathId, problems, type Route } from './http.ts'
import { HttpError } from './record.ts'
import { HistoryQuery, SearchQuery, StepsQuery, type HistoryPage, type SearchPage, type SessionView, type StepsPage } from '../shared/history.ts'
import { SessionId } from '../shared/ids.ts'

const UUID = '([0-9a-f-]{36})'

// A query string through its schema. One that does not fit answers 400 with what is wrong.
function parseQuery<S extends z.ZodType>(schema: S, url: URL): z.output<S> {
  const result = schema.safeParse(Object.fromEntries(url.searchParams))
  if (!result.success) throw new HttpError(400, problems(result.error))
  return result.data
}

type Answer<A> = Promise<A>

export const historyRoutes: Route[] = [
  ['people', 'GET', /^\/v1\/history$/, async (req, _params, url): Answer<HistoryPage> =>
    listSessions(await personFrom(req), parseQuery(HistoryQuery, url))],

  // Words from any step: a message, a tool call, a result or an error.
  ['people', 'GET', /^\/v1\/search$/, async (req, _params, url): Answer<SearchPage> =>
    searchSteps(await personFrom(req), parseQuery(SearchQuery, url))],

  ['people', 'GET', new RegExp(`^/v1/history/sessions/${UUID}$`), async (req, [id]): Answer<SessionView> =>
    sessionView(await personFrom(req), pathId(SessionId, id))],

  ['people', 'GET', new RegExp(`^/v1/history/sessions/${UUID}/steps$`), async (req, [id], url): Answer<StepsPage> =>
    sessionSteps(await personFrom(req), pathId(SessionId, id), parseQuery(StepsQuery, url))],
]
