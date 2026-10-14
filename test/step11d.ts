// AWS step 11d: the AWS stack, by its synthesized template. No AWS account is
// needed: the two lookups the CDK CLI would make (the zones and the Amazon Linux
// image) are filled in, as cdk.context.json fills them after the first deploy.
// The template must have what docs/design/aws.md says: nothing open to the
// internet, one rule to the machine port and one to Postgres, IMDSv2 with a hop
// limit of 1, the database and bucket settings, the tag on every resource, roles
// that read only their own parameters, and the alarms. The app itself synthesizes
// from the environment and stops on a missing setting.
//   node --env-file=.env --env-file=.env.test test/step11d.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { z } from 'zod'
import { DeploySettings, SECRET_PARAMETERS } from '../ops/aws/config.ts'
import { AgentsStack } from '../ops/aws/stack.ts'

const ROOT = new URL('..', import.meta.url).pathname
const ACCOUNT = '111111111111'
const REGION = 'us-east-1'
const IMAGE = 'ami-0123456789abcdef0'
const work = mkdtempSync(join(tmpdir(), 'agents-step11d-'))
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// What the CDK CLI would look up, as cdk.context.json holds it after the first deploy.
const context = {
  [`availability-zones:account=${ACCOUNT}:region=${REGION}`]: [`${REGION}a`, `${REGION}b`, `${REGION}c`],
  [`ssm:account=${ACCOUNT}:parameterName=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64:region=${REGION}`]: IMAGE,
}
const bundle = join(work, 'agents.bundle')
execFileSync('git', ['bundle', 'create', bundle, 'HEAD'], { cwd: ROOT, stdio: 'ignore' })

function synth(env: Record<string, string>, teardown = false) {
  const settings = DeploySettings.parse({ CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: REGION, AGENTS_AWS_ALARM_EMAIL: 'ops@example.com', ...env })
  const app = new App({ context, outdir: mkdtempSync(join(work, 'out-')) })
  const stack = new AgentsStack(app, 'Agents', { env: { account: ACCOUNT, region: REGION }, settings, codeBundle: bundle, teardown })
  return Template.fromStack(stack)
}

// A CloudFormation value, rendered with Ref and GetAtt as their target's id, so
// a policy or a parameter can be read as text.
const Resource = z.object({ Type: z.string(), Properties: z.record(z.string(), z.unknown()).default({}), DeletionPolicy: z.string().optional() })
type Resource = z.infer<typeof Resource>
const resourcesOf = (template: Template) => z.object({ Resources: z.record(z.string(), Resource) }).parse(template.toJSON()).Resources
function rendered(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(rendered).join(',')
  if (typeof value !== 'object' || value === null) return ''
  const record = z.record(z.string(), z.unknown()).parse(value)
  if ('Ref' in record) return `{${rendered(record.Ref)}}`
  if ('Fn::GetAtt' in record) return `{${rendered(record['Fn::GetAtt'])}}`
  if ('Fn::Join' in record) {
    const [separator, parts] = z.tuple([z.string(), z.array(z.unknown())]).parse(record['Fn::Join'])
    return parts.map(rendered).join(separator)
  }
  return Object.entries(record).map(([key, inner]) => `${key}=${rendered(inner)}`).join(';')
}
const ofType = (resources: Record<string, Resource>, type: string) => Object.entries(resources).filter(([, r]) => r.Type === type)
const idOf = (resources: Record<string, Resource>, type: string, prefix: string) =>
  ofType(resources, type).find(([id]) => id.startsWith(prefix))?.[0] ?? `no ${type} named ${prefix}`

try {
  const template = synth({})
  const resources = resourcesOf(template)
  const serverGroup = idOf(resources, 'AWS::EC2::SecurityGroup', 'ServerGroup')
  const boxesGroup = idOf(resources, 'AWS::EC2::SecurityGroup', 'BoxesGroup')
  const databaseGroup = idOf(resources, 'AWS::EC2::SecurityGroup', 'DatabaseGroup')

  // ---- Network ----
  const inline = ofType(resources, 'AWS::EC2::SecurityGroup').flatMap(([, r]) => z.array(z.unknown()).default([]).parse(r.Properties.SecurityGroupIngress))
  const rules = ofType(resources, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties)
  check(inline.length === 0 && rules.every((rule) => rule.CidrIp === undefined && rule.CidrIpv6 === undefined),
    'no security group lets in anything by address range, so nothing on the internet')
  const into = (group: string) => rules.filter((rule) => rendered(rule.GroupId) === `{${group},GroupId}`)
  const [serverRule] = into(serverGroup)
  check(into(serverGroup).length === 1 && serverRule?.IpProtocol === 'tcp' && serverRule.FromPort === 7700 && serverRule.ToPort === 7700
    && rendered(serverRule.SourceSecurityGroupId) === `{${boxesGroup},GroupId}`,
  "the server's group has one inbound rule: TCP 7700 from the box host's group")
  const [databaseRule] = into(databaseGroup)
  check(into(databaseGroup).length === 1 && databaseRule?.FromPort === 5432 && rendered(databaseRule.SourceSecurityGroupId) === `{${serverGroup},GroupId}`,
    "the database's group has one inbound rule: TCP 5432 from the server's group")
  check(into(boxesGroup).length === 0, "the box host's group has no inbound rules")
  check(ofType(resources, 'AWS::EC2::NatGateway').length === 0 && ofType(resources, 'AWS::EC2::EIP').length === 0, 'there is no NAT gateway or Elastic IP to pay for')

  // ---- Instances ----
  const instances = Object.fromEntries(ofType(resources, 'AWS::EC2::Instance').map(([id, r]) => [id.startsWith('Server') ? 'server' : 'boxes', r.Properties]))
  const nic = (properties: Record<string, unknown> | undefined) =>
    z.array(z.object({ PrivateIpAddress: z.string(), AssociatePublicIpAddress: z.boolean(), SubnetId: z.unknown() })).parse(properties?.NetworkInterfaces)[0]
  const subnetOf = (properties: Record<string, unknown> | undefined) => {
    const id = rendered(nic(properties)?.SubnetId).replace(/[{}]/g, '')
    return z.object({ CidrBlock: z.string(), AvailabilityZone: z.string() }).parse(resources[id]?.Properties)
  }
  check(instances.server?.InstanceType === 't4g.large' && instances.boxes?.InstanceType === 'm7g.xlarge',
    'the server is a t4g.large and the box host an m7g.xlarge')
  check(nic(instances.server)?.PrivateIpAddress === '10.40.0.10' && nic(instances.boxes)?.PrivateIpAddress === '10.40.0.20'
    && subnetOf(instances.server).CidrBlock === '10.40.0.0/24' && subnetOf(instances.boxes).CidrBlock === '10.40.0.0/24',
  'the server is 10.40.0.10 and the box host 10.40.0.20, both in 10.40.0.0/24')
  check(['server', 'boxes'].every((host) => rendered(instances[host]?.MetadataOptions)
    === 'HttpEndpoint=enabled;HttpPutResponseHopLimit=1;HttpTokens=required;InstanceMetadataTags=disabled'),
  'both instances require IMDSv2 tokens with a hop limit of 1, so no container gets an answer')
  check(['server', 'boxes'].every((host) => {
    const properties = instances[host]
    const disks = rendered(properties?.BlockDeviceMappings)
    return properties?.DisableApiTermination === true && rendered(properties.ImageId) === IMAGE && disks.includes('Encrypted=true') && disks.includes('VolumeType=gp3')
  }), 'both have termination protection, the looked-up Amazon Linux image, and encrypted gp3 disks')
  for (const [host, label] of [['server', 'server'], ['boxes', 'box host']] as const) {
    const script = rendered(instances[host]?.UserData)
    check(script.includes('--check') && script.includes('node-v24.16.0-linux-arm64.tar.xz') && script.trimEnd().endsWith(`node ops/aws/bootstrap.ts ${host}`)
      && !/tskey|password|secret/i.test(script),
    `the ${label}'s first boot checks Node's SHA-256, hands over to bootstrap.ts ${host}, and holds no secret`)
  }

  // ---- Database ----
  const [[databaseId, database] = ['', undefined]] = ofType(resources, 'AWS::RDS::DBInstance')
  const p = database?.Properties ?? {}
  check(p.Engine === 'postgres' && p.EngineVersion === '17' && p.DBInstanceClass === 'db.t4g.small' && p.PubliclyAccessible === false
    && p.StorageEncrypted === true && p.MultiAZ === false && p.BackupRetentionPeriod === 7 && p.DeletionProtection === true && database?.DeletionPolicy === 'Snapshot',
  `the database (${databaseId}) is private, encrypted PostgreSQL 17 on db.t4g.small, keeps 7 days of backups, and leaves a snapshot if deleted`)
  check(ofType(resources, 'AWS::RDS::DBParameterGroup').some(([, r]) => rendered(r.Properties.Parameters).includes('rds.logical_replication=1')),
    'its parameter group turns on logical replication for Electric')

  // ---- Bucket ----
  const [[, bucket] = ['', undefined]] = ofType(resources, 'AWS::S3::Bucket')
  const b = rendered(bucket?.Properties)
  check(b.includes('BlockPublicAcls=true;BlockPublicPolicy=true;IgnorePublicAcls=true;RestrictPublicBuckets=true') && b.includes('Status=Enabled')
    && b.includes('ExpirationInDays=35') && b.includes('Prefix=backups/') && bucket?.DeletionPolicy === 'Retain',
  'the backup bucket blocks public access, keeps versions, expires backups after 35 days, and outlives the stack')
  check(ofType(resources, 'AWS::S3::BucketPolicy').some(([, r]) => rendered(r.Properties).includes('aws:SecureTransport=false')),
    'the bucket refuses plain HTTP')

  // ---- Tags ----
  const tagged = Object.entries(resources).filter(([, r]) => r.Properties.Tags !== undefined)
  const carries = (r: Resource) => rendered(r.Properties.Tags).includes('Key=app;Value=agents') || rendered(r.Properties.Tags).includes('app=agents')
  const kinds = new Set(tagged.map(([, r]) => r.Type))
  check(tagged.every(([, r]) => carries(r)) && ['AWS::EC2::Instance', 'AWS::EC2::SecurityGroup', 'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::S3::Bucket',
    'AWS::RDS::DBInstance', 'AWS::IAM::Role', 'AWS::SNS::Topic', 'AWS::SSM::Parameter'].every((kind) => kinds.has(kind)),
  `all ${tagged.length} resources that take tags carry app=agents, across ${kinds.size} kinds`)

  // ---- Roles ----
  const policyOf = (prefix: string) => ofType(resources, 'AWS::IAM::Policy').filter(([id]) => id.startsWith(prefix))
    .flatMap(([, r]) => z.array(z.object({ Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown(), Condition: z.unknown().optional() }))
      .parse(z.object({ Statement: z.unknown() }).parse(r.Properties.PolicyDocument).Statement))
  const secretsReadBy = (prefix: string) => policyOf(prefix).filter((s) => s.Action === 'ssm:GetParameter').map((s) => rendered(s.Resource)).join(',')
  const serverSecrets = secretsReadBy('ServerRole')
  const boxesSecrets = secretsReadBy('BoxesRole')
  check((['tailscale-server', 'hook-secret', 'box-claude-token', 'forge-json'] as const).every((name) => serverSecrets.includes(`parameter${SECRET_PARAMETERS[name]}`))
    && !serverSecrets.includes('tailscale/boxes') && boxesSecrets.endsWith(`parameter${SECRET_PARAMETERS['tailscale-boxes']}`) && !boxesSecrets.includes('/server'),
  "each host's role reads only its own secret parameters; the box host reads only its Tailscale key")
  const statements = [...policyOf('ServerRole'), ...policyOf('BoxesRole')]
  const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
  check(!actions.some((action) => action === '*' || action.startsWith('s3:Delete') || action.startsWith('iam:') || action.startsWith('ec2:')),
    'no host may delete from S3, touch IAM or EC2, or do everything')
  check(statements.filter((s) => rendered(s.Resource) === '*').every((s) => s.Action === 'cloudwatch:PutMetricData' && rendered(s.Condition) === 'StringEquals=cloudwatch:namespace=Agents'),
    'the only statement on every resource is PutMetricData, held to the Agents namespace')
  check(statements.filter((s) => rendered(s.Resource).includes('cdk-hnb659fds-assets')).every((s) => s.Action === 's3:GetObject' && !rendered(s.Resource).endsWith('/*')),
    'from the CDK assets bucket the hosts read the code bundle and nothing else')
  check(policyOf('ServerRole').some((s) => rendered(s.Action).includes('s3:PutObject') && rendered(s.Resource).endsWith('/backups/*')),
    'the server may write backups, under backups/ only')

  // ---- What the hosts read ----
  const parameters = ofType(resources, 'AWS::SSM::Parameter').map(([, r]) => r.Properties)
  const config = rendered(parameters.find((x) => x.Name === '/agents/config')?.Value)
  check(['"serverAddress":"10.40.0.10"', '"boxHostAddress":"10.40.0.20"', '"resolver":"10.40.0.2"', '"machinePort":7700'].every((part) => config.includes(part))
    && parameters.some((x) => x.Name === '/agents/code'), '/agents/config and /agents/code are written for the hosts')

  // ---- Alarms ----
  const alarms = ofType(resources, 'AWS::CloudWatch::Alarm').map(([id, r]) => ({ id, p: r.Properties, actions: rendered(r.Properties.AlarmActions) }))
  const topic = idOf(resources, 'AWS::SNS::Topic', 'Alarms')
  check(alarms.length === 14 && alarms.every((a) => a.actions.includes(`{${topic}}`)), `all ${alarms.length} alarms email the alarm topic`)
  const named = (prefix: string) => alarms.filter((a) => a.id.startsWith(prefix))
  check([...named('ServerSystemCheck'), ...named('BoxHostSystemCheck')].every((a) => a.actions.includes(':automate:') && a.actions.includes(':ec2:recover'))
    && [...named('ServerInstanceCheck'), ...named('BoxHostInstanceCheck')].every((a) => a.actions.includes(':ec2:reboot')),
  'a failed hardware check recovers the instance, and a failed instance check reboots it')
  check(['ApiDown', 'ElectricDown', 'ForgeDown', 'BackupOld'].every((prefix) => named(prefix)[0]?.p.TreatMissingData === 'breaching'),
    'the API, Electric, the forge and the backup alarm when the server stops reporting, not only on a bad value')
  check(named('BoxHostMemory')[0]?.p.Threshold === 85 && named('ElectricBehind')[0]?.p.MetricName === 'OldestReplicationSlotLag',
    "the box host's memory and Electric's replication lag have alarms")

  // ---- Sizes and teardown ----
  const bigger = resourcesOf(synth({ AGENTS_AWS_BOX_HOST_TYPE: 'm7g.2xlarge' }))
  check(ofType(bigger, 'AWS::EC2::Instance').some(([id, r]) => id.startsWith('BoxHost') && r.Properties.InstanceType === 'm7g.2xlarge'),
    'AGENTS_AWS_BOX_HOST_TYPE=m7g.2xlarge moves the box host up a size')
  const ending = resourcesOf(synth({}, true))
  check(ofType(ending, 'AWS::RDS::DBInstance').every(([, r]) => r.Properties.DeletionProtection === false)
    && ofType(ending, 'AWS::EC2::Instance').every(([, r]) => r.Properties.DisableApiTermination === false),
  'teardown mode turns off deletion and termination protection, so cdk destroy can finish')

  // ---- The app ----
  const outdir = mkdtempSync(join(work, 'app-'))
  const env = { ...process.env, CDK_OUTDIR: outdir, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: REGION, AGENTS_AWS_ALARM_EMAIL: 'ops@example.com' }
  const app = spawnSync(process.execPath, ['ops/aws/app.ts'], { cwd: ROOT, env, encoding: 'utf8' })
  check(app.status === 0 && existsSync(join(outdir, 'Agents.template.json')), 'the CDK app synthesizes from the environment, as the CDK CLI runs it')
  const { AGENTS_AWS_ALARM_EMAIL: _unset, ...missing } = env
  const refused = spawnSync(process.execPath, ['ops/aws/app.ts'], { cwd: ROOT, env: missing, encoding: 'utf8' })
  check(refused.status !== 0 && refused.stderr.includes('AGENTS_AWS_ALARM_EMAIL'), 'without an alarm email the app stops and names AGENTS_AWS_ALARM_EMAIL')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  if (!failures.length) rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures.length ? `${failures.length} failed (${work} kept)` : 'all passed'}`)
process.exit(failures.length ? 1 : 0)
