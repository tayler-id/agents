// The change from one version of a document to the next, as git's unified
// diff, for the document's Diff tab. A person sends a document back and reads
// what the agent changed in it.

import { many, maybe, pool } from './db.ts'
import { canSeeTask } from './access.ts'
import { HttpError, type Person } from './record.ts'
import { diffText } from './refine.ts'
import type { ArtifactId } from '../shared/ids.ts'

export async function versionDiff(person: Person, artifactId: ArtifactId, version: number): Promise<string> {
  const artifact = await maybe<{ task_id: string; path: string }>(pool,
    `select task_id, path from artifacts where id = $1 and team_id = $2 and kind = 'document'`, [artifactId, person.team_id])
  if (!artifact || !(await canSeeTask(person, artifact.task_id))) throw new HttpError(404, 'no such document')
  const versions = await many<{ version: number; content: string }>(pool,
    'select version, content from artifact_versions where artifact_id = $1 and version = any($2)', [artifactId, [version - 1, version]])
  const before = versions.find((v) => v.version === version - 1)
  const after = versions.find((v) => v.version === version)
  if (!before || !after) throw new HttpError(404, `no version ${version - 1} and ${version} to compare`)
  return diffText(before.content, after.content, artifact.path)
}
