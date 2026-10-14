// Takes the AWS deployment down, from this Mac signed in with `aws configure
// sso`, with the same settings as the deploy. It deploys the stack once with
// deletion and termination protection off, then destroys it. RDS leaves a final
// snapshot. The backup bucket and the SecureString parameters stay, unless
// --delete-backups and --delete-secrets say to delete them too. It asks you to
// type the stack's name first.
//   node ops/aws/down.ts [--delete-backups] [--delete-secrets] [--dry-run]
// Afterwards, remove agents-server and agents-boxes in Tailscale's admin console.

import { createInterface } from 'node:readline/promises'
import { S3Client } from '@aws-sdk/client-s3'
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm'
import { deleteBucket, hostConfig } from './aws.ts'
import { SECRET_PARAMETERS, STACK_NAME } from './config.ts'
import { isDryRun, perform, run } from './steps.ts'

const HERE = new URL('.', import.meta.url).pathname
const deleteBackups = process.argv.includes('--delete-backups')
const deleteSecrets = process.argv.includes('--delete-secrets')
const dryRun = isDryRun()
const ssm = new SSMClient({})
const cdk = (...args: string[]) => { run('npx', ['cdk', ...args], { cwd: HERE }) }
let bucket = ''

const steps = [
  {
    say: `ask you to type ${STACK_NAME} to go on`,
    act: async () => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await prompt.question(`This deletes the ${STACK_NAME} stack: the server, the box host, the database (a final snapshot stays). Type ${STACK_NAME} to go on: `)
      prompt.close()
      if (answer.trim() !== STACK_NAME) throw new Error('nothing was deleted')
    },
  },
  { say: 'read the backup bucket from /agents/config, before the stack takes it away', act: async () => { bucket = (await hostConfig(ssm)).bucket } },
  { say: 'deploy once with deletion and termination protection off', act: () => { cdk('deploy', '--context', 'agents:teardown=true', '--require-approval', 'never') } },
  { say: `destroy the ${STACK_NAME} stack`, act: () => { cdk('destroy', '--force') } },
  ...(deleteBackups ? [{ say: 'empty the backup bucket, every version, and delete it', act: () => deleteBucket(new S3Client({}), bucket) }] : []),
  ...(deleteSecrets ? [{
    say: `delete ${Object.values(SECRET_PARAMETERS).join(', ')}`,
    act: async () => { await ssm.send(new DeleteParametersCommand({ Names: Object.values(SECRET_PARAMETERS) })) },
  }] : []),
]
await perform(steps, dryRun)
console.log(`\nStill there: the database's final snapshot (RDS, Snapshots)${deleteBackups ? '' : ', the backup bucket'}${deleteSecrets ? '' : ', the SecureString parameters under /agents/'}, `
  + 'the CDKToolkit stack from cdk bootstrap, and the two machines in Tailscale\'s admin console.')
