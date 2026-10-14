// Stores one secret in SSM Parameter Store, encrypted, from this Mac signed in
// with `aws configure sso`. The value comes from a file or from stdin, and is
// never printed or put on a command line. The server and the box host read their
// own secrets at boot, and nothing else can.
//   node ops/aws/secrets.ts put <name> [--file <path>] [--dry-run]
//   pbpaste | node ops/aws/secrets.ts put tailscale-server
// Names: tailscale-server and tailscale-boxes (the hosts' Tailscale auth keys),
// box-claude-token (from `claude setup-token`), and hook-secret and forge-json,
// which ops/aws/export.ts puts at cutover.

import { readFileSync } from 'node:fs'
import { SSMClient } from '@aws-sdk/client-ssm'
import { putSecret } from './aws.ts'
import { SECRET_PARAMETERS, SecretName } from './config.ts'
import { isDryRun, perform } from './steps.ts'

const [command, rawName] = process.argv.slice(2)
if (command !== 'put' || !rawName) throw new Error(`usage: node ops/aws/secrets.ts put <${SecretName.options.join('|')}> [--file <path>] [--dry-run]`)
const name = SecretName.parse(rawName)
const flag = process.argv.indexOf('--file')
const file = flag === -1 ? undefined : process.argv[flag + 1]

await perform([{
  say: `store ${file ? `the contents of ${file}` : 'what arrives on stdin'} as the SecureString ${SECRET_PARAMETERS[name]}`,
  act: async () => {
    // File descriptor 0 is stdin.
    const value = readFileSync(file ?? 0, 'utf8').trim()
    if (!value) throw new Error(`no value for ${name}: the ${file ? 'file' : 'input'} is empty`)
    const outcome = await putSecret(new SSMClient({}), name, value)
    console.log(`${outcome} ${SECRET_PARAMETERS[name]} (${value.length} characters)`)
  },
}], isDryRun())
