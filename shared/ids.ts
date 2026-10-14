// Row ids, each its own type, so a task's id never passes where a session's is
// expected. Each parses a uuid, as Postgres's gen_random_uuid() makes them.

import { z } from 'zod'

export const TeamId = z.uuid().brand<'TeamId'>()
export type TeamId = z.infer<typeof TeamId>
export const PersonId = z.uuid().brand<'PersonId'>()
export type PersonId = z.infer<typeof PersonId>
export const AgentId = z.uuid().brand<'AgentId'>()
export type AgentId = z.infer<typeof AgentId>
export const RepoId = z.uuid().brand<'RepoId'>()
export type RepoId = z.infer<typeof RepoId>
export const TaskId = z.uuid().brand<'TaskId'>()
export type TaskId = z.infer<typeof TaskId>
export const SessionId = z.uuid().brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionId>
export const WorkspaceId = z.uuid().brand<'WorkspaceId'>()
export type WorkspaceId = z.infer<typeof WorkspaceId>
export const ConversationId = z.uuid().brand<'ConversationId'>()
export type ConversationId = z.infer<typeof ConversationId>
export const MessageId = z.uuid().brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageId>
export const ArtifactId = z.uuid().brand<'ArtifactId'>()
export type ArtifactId = z.infer<typeof ArtifactId>
export const FileChangeId = z.uuid().brand<'FileChangeId'>()
export type FileChangeId = z.infer<typeof FileChangeId>
export const PushId = z.uuid().brand<'PushId'>()
export type PushId = z.infer<typeof PushId>
export const RunId = z.uuid().brand<'RunId'>()
export type RunId = z.infer<typeof RunId>
export const PipelineId = z.uuid().brand<'PipelineId'>()
export type PipelineId = z.infer<typeof PipelineId>
export const ProposalId = z.uuid().brand<'ProposalId'>()
export type ProposalId = z.infer<typeof ProposalId>
// events.id is a bigint, which Postgres sends as text.
export const EventId = z.string().regex(/^\d+$/).brand<'EventId'>()
export type EventId = z.infer<typeof EventId>
export const ScreenTakeoverId = z.uuid().brand<'ScreenTakeoverId'>()
export type ScreenTakeoverId = z.infer<typeof ScreenTakeoverId>
export const BlobId = z.uuid().brand<'BlobId'>()
export type BlobId = z.infer<typeof BlobId>
// A tunnel lives only in the API's memory, between a person's Screen view and a
// box. It is a uuid like the rest so it can't be guessed.
export const TunnelId = z.uuid().brand<'TunnelId'>()
export type TunnelId = z.infer<typeof TunnelId>
