// The CDK app. The CDK CLI runs it from ops/aws, as cdk.json says:
//   cd ops/aws && npx cdk synth    the template, with no AWS calls once cdk.context.json has the lookups
//   cd ops/aws && npx cdk diff     what a deploy would change
//   cd ops/aws && npx cdk deploy   create or update everything
// Teardown is ops/aws/down.ts, which deploys once with -c agents:teardown=true.
// What the CDK writes, and the code bundle, go in the repo's ignored .scratch/.

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { z } from 'zod'
import { DeploySettings, STACK_NAME, settingsFrom } from './config.ts'
import { AgentsStack } from './stack.ts'

const HERE = new URL('.', import.meta.url).pathname

// A git bundle of the commit being deployed, which the hosts clone at first boot.
// One pack thread, so the same commit gives the same bundle and the same asset.
function bundleHead(): string {
  const dir = join(HERE, '..', '..', '.scratch', 'aws-code')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'agents.bundle')
  execFileSync('git', ['-c', 'pack.threads=1', 'bundle', 'create', file, 'HEAD'], { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] })
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim()
  console.error(`the hosts get commit ${commit}; uncommitted changes are not included`)
  return file
}

const settings = settingsFrom(DeploySettings, 'the deploy settings')
const app = new App()
const teardown = z.enum(['true', 'false']).default('false').parse(app.node.tryGetContext('agents:teardown')) === 'true'
new AgentsStack(app, STACK_NAME, {
  env: { account: settings.CDK_DEFAULT_ACCOUNT, region: settings.CDK_DEFAULT_REGION },
  description: 'Agents: the API, Electric, the forge, Postgres and the boxes (docs/aws.md)',
  settings, codeBundle: bundleHead(), teardown,
})
app.synth()
