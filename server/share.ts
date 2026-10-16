// An agent shares a file or a screenshot from its session. In a chat the file is
// a post by the agent, with the caption as its words. In a task's session it is a
// notice event, which the task page shows where it was shared.

import { z } from 'zod'
import { cleanFileName, type UploadAnswer } from '../shared/attachments.ts'
import { maybe, pool, tx } from './db.ts'
import { appendEvents, appendMessage, HttpError } from './record.ts'
import { placeUploads, refuseSecret, removeFiles, saveUpload } from './attachments.ts'

const Sharing = z.object({
  agent_id: z.uuid(), conversation_id: z.uuid().nullable(), task_id: z.uuid().nullable(), judged: z.boolean(),
})

export type Shared = UploadAnswer & { messageId?: string; eventId?: string }

export async function shareFromSession(input: {
  teamId: string; sessionId: string; bytes: Buffer; name: string; declaredType: string; caption: string
}): Promise<Shared> {
  const row = await maybe(pool,
    `select s.agent_id, s.conversation_id, s.task_id,
       exists (select 1 from run_stages st join runs r on r.id = st.run_id
         where r.task_id = s.task_id and st.data->'reviewers' @> jsonb_build_array(jsonb_build_object('sessionId', s.id::text))) as judged
     from sessions s where s.id = $1 and s.team_id = $2 and s.folder_id is null`, [input.sessionId, input.teamId])
  const session = row ? Sharing.parse(row) : null
  if (!session) throw new HttpError(404, 'no such agent session')
  if (session.judged) throw new HttpError(409, "A judge's session shares nothing, since it works on its own and posts nowhere.")
  refuseSecret(input.bytes)
  const caption = input.caption.trim()
  const place = session.conversation_id ? { conversationId: session.conversation_id } : { sessionId: input.sessionId }
  const saved = await saveUpload(pool, { teamId: input.teamId, place, by: { agentId: session.agent_id }, bytes: input.bytes, name: cleanFileName(input.name), declaredType: input.declaredType })
  try {
    const posted = await tx(async (client) => {
      if (session.conversation_id) {
        const message = await appendMessage(client, session.conversation_id, {
          speaker: 'agent', agentId: session.agent_id, body: caption, clientId: `share:${saved.attachmentId}`, sessionId: input.sessionId,
        })
        await placeUploads(client, [saved.attachmentId], { conversationId: session.conversation_id, messageId: message.id })
        return { messageId: message.id }
      }
      const [seq] = await appendEvents(client, input.sessionId, {
        events: [{ clientId: `share:${saved.attachmentId}`, kind: 'notice', text: caption || saved.name,
          body: { subtype: 'share', attachmentIds: [saved.attachmentId], caption } }],
      })
      if (seq === undefined) throw new Error(`the share ${saved.attachmentId} was not recorded`)
      const event = await maybe<{ id: string }>(client, 'select id from events where session_id = $1 and seq = $2', [input.sessionId, seq])
      if (!event) throw new Error(`the share ${saved.attachmentId} has no event`)
      await placeUploads(client, [saved.attachmentId], { sessionId: input.sessionId, eventId: event.id })
      return { eventId: event.id }
    })
    return { ...saved, ...posted }
  } catch (error) {
    await pool.query('delete from attachments where id = $1', [saved.attachmentId])
    await removeFiles([saved.attachmentId])
    throw error
  }
}
