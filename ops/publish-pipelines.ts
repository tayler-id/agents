// Proposes this repo's pipeline files to the forge's pipelines repo as one pull
// request, so they go through review like any other pipeline change. With
// --merge it merges the pull request too. The forge's webhook then tells the API,
// which makes the new versions current. Files that already match are left alone.
//   node --env-file=.env ops/publish-pipelines.ts [--merge]

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { forge, forgeConfig, ForgeError } from '../server/forge.ts'

const ROOT = new URL('..', import.meta.url).pathname
const merge = process.argv.includes('--merge')
const repo = `${forgeConfig().org}/pipelines`

const local: Record<string, string> = {
  'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
  ...Object.fromEntries(readdirSync(join(ROOT, 'pipelines')).filter((f) => f.endsWith('.ts'))
    .map((f) => [`pipelines/${f}`, readFileSync(join(ROOT, 'pipelines', f), 'utf8')])),
}

async function onForge(path: string): Promise<{ sha: string; content: string } | null> {
  const res = await fetch(`${forgeConfig().url}/api/v1/repos/${repo}/contents/${path}?ref=main`, {
    headers: { authorization: `token ${forgeConfig().token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new ForgeError(res.status, `reading ${path}: ${res.status}`)
  const file = await res.json() as { sha: string; content: string }
  return { sha: file.sha, content: Buffer.from(file.content, 'base64').toString('utf8') }
}

const changes = []
for (const [path, content] of Object.entries(local)) {
  const current = await onForge(path)
  if (current?.content === content) continue
  changes.push({
    operation: current ? 'update' : 'create', path, content: Buffer.from(content).toString('base64'), ...(current ? { sha: current.sha } : {}),
  })
}
if (!changes.length) {
  console.log(`${repo} already has these pipeline files`)
  process.exit(0)
}

const branch = `publish-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
const res = await fetch(`${forgeConfig().url}/api/v1/repos/${repo}/contents`, {
  method: 'POST',
  headers: { authorization: `token ${forgeConfig().token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ branch: 'main', new_branch: branch, message: `Update ${changes.map((c) => c.path).join(', ')}`, files: changes }),
})
if (!res.ok) throw new ForgeError(res.status, `committing the files: ${await res.text()}`)
const pr = await forge.openPullRequest(repo, branch, 'main', 'Update the pipelines from the Agents repo',
  `Files changed:\n\n${changes.map((c) => `- ${c.path} (${c.operation === 'create' ? 'new' : 'changed'})`).join('\n')}`)
console.log(`opened ${pr.html_url}`)
if (merge) {
  const merged = await forge.merge(repo, pr.number)
  console.log(merged.merged ? `merged pull request #${pr.number}` : `pull request #${pr.number} did not merge`)
}
