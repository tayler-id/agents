// Takes the AWS deployment down, from this Mac signed in with `aws configure
// sso`, with the same settings as the deploy. It deploys the stack once with
// deletion and termination protection off, then destroys it. RDS leaves a final
// snapshot. The backup bucket and the SecureString parameters stay, unless
// --delete-backups and --delete-secrets say to delete them too. It asks you to
// type the stack's name first.
//   node ops/aws/down.ts [--delete-backups] [--delete-secrets] [--dry-run]
// Afterwards, remove agents-server and agents-boxes in Tailscale's admin console.

import { createInterface } from 'node:readline/promises'
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3'
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm'
import { z } from 'zod'
import { hostConfig } from './aws.ts'
import { SECRET_PARAMETERS, STACK_NAME } from './config.ts'
import { isDryRun, perform, run } from './steps.ts'

const HERE = new URL('.', import.meta.url).pathname
const deleteBackups = process.argv.includes('--delete-backups')
const deleteSecrets = process.argv.includes('--delete-secrets')
const dryRun = isDryRun()
const ssm = new SSMClient({})
const cdk = (...args: string[]) => { run('npx', ['cdk', ...args], { cwd: HERE }) }
let bucket = ''

// S3 deletes up to 1000 keys a call.
const DELETE_BATCH = 1000
const Version = z.object({ Key: z.string(), VersionId: z.string() })

async function emptyAndDelete(s3: S3Client, name: string) {
  for (;;) {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: name, MaxKeys: DELETE_BATCH }))
    const versions = z.array(Version).parse([...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
    if (!versions.length) break
    await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: versions, Quiet: true } }))
  }
  await s3.send(new DeleteBucketCommand({ Bucket: name }))
}

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
  ...(deleteBackups ? [{ say: 'empty the backup bucket, every version, and delete it', act: () => emptyAndDelete(new S3Client({}), bucket) }] : []),
  ...(deleteSecrets ? [{
    say: `delete ${Object.values(SECRET_PARAMETERS).join(', ')}`,
    act: async () => { await ssm.send(new DeleteParametersCommand({ Names: Object.values(SECRET_PARAMETERS) })) },
  }] : []),
]
await perform(steps, dryRun)
console.log(`\nStill there: the database's final snapshot (RDS, Snapshots)${deleteBackups ? '' : ', the backup bucket'}${deleteSecrets ? '' : ', the SecureString parameters under /agents/'}, `
  + 'the CDKToolkit stack from cdk bootstrap, and the two machines in Tailscale\'s admin console.')
