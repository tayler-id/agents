// Moves a host to the commit the last `npx cdk deploy` uploaded: fetches the git
// bundle /agents/code names and checks that commit out. On the server it then
// installs and builds, rebuilds the box image on the box host, and restarts the
// API. Boxes pick up the new image when they are recreated (server/boxes.ts
// recreate). On the box host it installs, then restarts the firewall, so a
// change to its rules takes effect.
//   sudo -iu agents node agents/ops/aws/update.ts server|boxes [--dry-run]
// It refuses when the checkout has changes of its own, so nothing is lost.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { SSMClient } from '@aws-sdk/client-ssm'
import { download, readParameter, S3Location } from './aws.ts'
import { CODE_PARAMETER, Role } from './config.ts'
import { isDryRun, output, perform, run, type Step } from './steps.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const role = Role.parse(process.argv[2])
const work = mkdtempSync(join(tmpdir(), 'agents-update-'))
const bundle = join(work, 'agents.bundle')
const npm = join(process.execPath, '..', 'npm')
const inRepo = { cwd: ROOT, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', PATH: `${join(process.execPath, '..')}:${process.env.PATH ?? ''}` } }

const shared: Step[] = [
  {
    say: `check that ${ROOT} has no changes of its own`,
    act: () => {
      const changes = output('git', ['status', '--porcelain'], { cwd: ROOT })
      if (changes) throw new Error(`the checkout has changes of its own, so it was left alone:\n${changes}`)
    },
  },
  {
    say: `download the bundle that ${CODE_PARAMETER} names`,
    act: async () => {
      const location = await readParameter(new SSMClient({}), CODE_PARAMETER)
      if (location === undefined) throw new Error(`there is no ${CODE_PARAMETER}: deploy the stack first`)
      const { bucket, key } = S3Location.parse(location)
      await download(new S3Client({}), bucket, key, bundle)
    },
  },
  { say: 'check out its commit', act: () => { run('git', ['fetch', bundle, 'HEAD'], inRepo); run('git', ['checkout', '--detach', 'FETCH_HEAD'], inRepo) } },
  { say: 'install the dependencies', act: () => { run(npm, ['ci'], inRepo) } },
]
const steps: Record<Role, Step[]> = {
  server: [
    ...shared,
    { say: 'build the app', act: () => { run(npm, ['run', 'app:build'], inRepo) } },
    { say: 'build the box image on the box host', act: () => { run(process.execPath, ['--env-file=.env', 'server/boxes.ts', 'build'], inRepo) } },
    { say: 'restart the API', act: () => { run('sudo', ['systemctl', 'restart', 'agents-api.service']) } },
  ],
  boxes: [
    ...shared,
    { say: 'restart the firewall', act: () => { run('sudo', ['systemctl', 'restart', 'agents-box-firewall.service']) } },
  ],
}

try {
  await perform(steps[role], isDryRun())
  if (!isDryRun()) console.log(`the ${role} runs ${output('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
