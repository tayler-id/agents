// The facts every part of the AWS deployment shares, defined once: names,
// addresses, parameter paths, pinned downloads, and the schemas for the deploy
// settings and for what the hosts read at boot. The design is docs/design/aws.md.

import { z } from 'zod'

// Every resource carries this tag.
export const TAG = { key: 'app', value: 'agents' } as const
export const STACK_NAME = 'Agents'

// Fixed addresses, so nothing has to discover them. The VPC's resolver is always
// its base address plus two.
export const VPC_CIDR = '10.40.0.0/16'
export const SERVER_ADDRESS = '10.40.0.10'
export const BOX_HOST_ADDRESS = '10.40.0.20'
export const VPC_RESOLVER = '10.40.0.2'
export const MACHINE_PORT = 7700
export const PEOPLE_PORT = 7710
export const POSTGRES_PORT = 5432

// A box is an agent's computer, so it reaches the public internet over any
// protocol, as boxes on this Mac do, and nothing private except the server's
// machine port. ops/aws/box-firewall.ts drops every address the box host has, and
// these ranges, which hold the VPC, RDS, the metadata endpoint, the tailnet and
// Docker's networks, so other boxes too.
export const BOX_CLOSED_RANGES = [
  '0.0.0.0/8', // this network
  '10.0.0.0/8', // private: the VPC, the server and RDS
  '100.64.0.0/10', // shared address space: the tailnet
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local: the metadata endpoint and AWS's other local services
  '172.16.0.0/12', // private: Docker's networks, so other boxes
  '192.168.0.0/16', // private
  '198.18.0.0/15', // network testing
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, and broadcast
] as const
// Boxes look names up at these public resolvers, set in Docker's settings on the
// box host, so they never need the VPC's resolver.
export const BOX_DNS = ['1.1.1.1', '8.8.8.8'] as const

// The service user on both hosts, and where things live there.
export const SERVICE_USER = 'agents'
export const HOME = `/home/${SERVICE_USER}`
export const REPO = `${HOME}/agents`
export const APP_HOME = `${HOME}/.agents-app`
export const NODE_DIR = '/opt/node'
export const RDS_CA_FILE = `${APP_HOME}/rds-ca.pem`

// Names on the tailnet. The server joins under a temporary name and takes
// agents-server at cutover, when this Mac gives it up.
export const TAILNET = {
  serverAtFirst: 'agents-aws',
  server: 'agents-server',
  boxes: 'agents-boxes',
  serverTag: 'tag:agents-server',
  boxesTag: 'tag:agents-boxes',
} as const

// CloudWatch: our metrics' namespace, and the hosts they describe.
export const METRICS_NAMESPACE = 'Agents'
export const Role = z.enum(['server', 'boxes'])
export type Role = z.infer<typeof Role>

// SSM parameters. The stack writes the two plain ones. The SecureStrings hold
// secrets, which CloudFormation cannot create, so ops/aws/secrets.ts and
// ops/aws/export.ts write them from this Mac.
export const CONFIG_PARAMETER = '/agents/config'
export const CODE_PARAMETER = '/agents/code'
export const SecretName = z.enum(['tailscale-server', 'tailscale-boxes', 'hook-secret', 'box-claude-token', 'forge-json'])
export type SecretName = z.infer<typeof SecretName>
export const SECRET_PARAMETERS: Record<SecretName, string> = {
  'tailscale-server': '/agents/tailscale/server',
  'tailscale-boxes': '/agents/tailscale/boxes',
  'hook-secret': '/agents/server/hook-secret',
  'box-claude-token': '/agents/server/box-claude-token',
  'forge-json': '/agents/server/forge-json',
}

// Downloads the hosts make at first boot, pinned to a version and its SHA-256
// from the publisher's checksum list. Node 24 matches this Mac's. Compose matches
// this Mac's too. Buildx is the newest release at least two weeks old.
export const NODE = {
  version: 'v24.16.0',
  url: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-arm64.tar.xz',
  sha256: '524659219d6a207a7400f2bde15d19ba060ffbe0d32a8643319ad67e3bb64c78',
} as const
export const DOCKER_PLUGINS = [
  {
    name: 'docker-compose',
    url: 'https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-linux-aarch64',
    sha256: '733ec76717ceb59052a9609b9dadfb523b2df8eab57a54212872d10a58078ea2',
  },
  {
    name: 'docker-buildx',
    url: 'https://github.com/docker/buildx/releases/download/v0.37.1/buildx-v0.37.1.linux-arm64',
    sha256: 'e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2',
  },
] as const

// What `cdk synth` and `cdk deploy` read from the environment. The CDK CLI sets
// the account and region from the signed-in profile.
export const DeploySettings = z.object({
  CDK_DEFAULT_ACCOUNT: z.string().regex(/^\d{12}$/, 'the AWS account id; the CDK CLI sets it from your signed-in profile'),
  CDK_DEFAULT_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, 'an AWS region such as us-east-1; the CDK CLI sets it from your profile'),
  AGENTS_AWS_ALARM_EMAIL: z.email(),
  AGENTS_AWS_BOX_HOST_TYPE: z.enum(['m7g.xlarge', 'm7g.2xlarge']).default('m7g.xlarge'),
  // The zone for both instances. Unset, the region's first zone. Set it when
  // that zone does not offer the instance types.
  AGENTS_AWS_ZONE: z.string().regex(/^[a-z]{2}-[a-z]+-\d[a-z]$/).optional(),
})
export type DeploySettings = z.infer<typeof DeploySettings>

// What both hosts read from CONFIG_PARAMETER at boot. It holds no secrets.
export const HostConfig = z.object({
  region: z.string().min(1),
  bucket: z.string().min(1),
  databaseSecretArn: z.string().startsWith('arn:'),
  serverAddress: z.ipv4(),
  boxHostAddress: z.ipv4(),
  resolver: z.ipv4(),
  machinePort: z.number().int(),
  peoplePort: z.number().int(),
})
export type HostConfig = z.infer<typeof HostConfig>

// The secret RDS generates for the master user, as Secrets Manager returns it.
export const DatabaseSecret = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int(),
  dbname: z.string().min(1),
})
export type DatabaseSecret = z.infer<typeof DatabaseSecret>

// What ops/aws/backup.ts records in the app's home after each good backup, and
// ops/aws/health.ts reads to report the backup's age.
export const BACKUP_STATE = 'backup-state.json'
export const BackupState = z.object({ lastSuccess: z.iso.datetime(), location: z.string() })
export type BackupState = z.infer<typeof BackupState>

// Parses settings from the environment, or stops with the names of what is wrong.
export function settingsFrom<T extends z.ZodType>(schema: T, what: string, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(env)
  if (!parsed.success) throw new Error(`${what} are wrong\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
