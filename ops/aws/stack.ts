// The whole AWS deployment as one CDK stack: the network, the database, the
// server and the box host, their roles, the backup bucket and the alarms.
// CloudFormation makes it idempotent. Every resource carries the tag app=agents.
// The design, with the reasons, is docs/design/aws.md.

import { Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import {
  BOX_HOST_ADDRESS, CODE_PARAMETER, CONFIG_PARAMETER, MACHINE_PORT, METRICS_NAMESPACE, NODE, NODE_DIR, PEOPLE_PORT,
  POSTGRES_PORT, REPO, SECRET_PARAMETERS, SERVER_ADDRESS, SERVICE_USER, TAG, VPC_CIDR, VPC_RESOLVER,
  type DeploySettings, type HostConfig, type Role, type SecretName,
} from './config.ts'

export type AgentsStackProps = StackProps & {
  settings: DeploySettings
  // A git bundle of the commit to deploy. The hosts clone it at first boot.
  codeBundle: string
  // Deploy once with this set before `cdk destroy`: it turns off deletion and
  // termination protection.
  teardown: boolean
}

// Root volumes. The server holds the forge's repos and Electric's shape logs.
// The box host holds images and every box's home folder, with its workspaces.
const SERVER_DISK_GB = 30
const BOX_HOST_DISK_GB = 100
// RDS storage starts small and grows on its own up to the cap.
const DATABASE_GB = 20
const DATABASE_MAX_GB = 100
// A replication slot keeps WAL until Electric reads it. Past this much the slot is
// dropped instead of filling the disk, and Electric rebuilds its shapes.
const MAX_SLOT_WAL_MB = 10240
const BACKUP_DAYS = 35
const CUTOVER_DAYS = 14

// The commands first boot runs. User data must be shell, so it only installs
// Node, fetches the deployed commit and hands over to ops/aws/bootstrap.ts.
function firstBoot(role: Role, region: string): ec2.UserData {
  const data = ec2.UserData.forLinux()
  data.addCommands(
    'set -euo pipefail',
    `export AWS_REGION=${region}`,
    'dnf install -y git tar xz',
    `curl -fsSL -o /tmp/node.tar.xz ${NODE.url}`,
    `echo '${NODE.sha256}  /tmp/node.tar.xz' | sha256sum --check`,
    `mkdir -p ${NODE_DIR} && tar -xJf /tmp/node.tar.xz -C ${NODE_DIR} --strip-components=1`,
    `id ${SERVICE_USER} || useradd --create-home ${SERVICE_USER}`,
    `aws s3 cp "$(aws ssm get-parameter --name ${CODE_PARAMETER} --query Parameter.Value --output text)" /tmp/agents.bundle`,
    `test -d ${REPO} || sudo -u ${SERVICE_USER} -H git clone /tmp/agents.bundle ${REPO}`,
    `cd ${REPO} && sudo -u ${SERVICE_USER} -H env PATH=${NODE_DIR}/bin:/usr/bin ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`,
    `exec ${NODE_DIR}/bin/node ops/aws/bootstrap.ts ${role}`,
  )
  return data
}

export class AgentsStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props)
    const { settings, teardown } = props
    Tags.of(this).add(TAG.key, TAG.value)

    // ---- Network ----
    const zone = settings.AGENTS_AWS_ZONE ?? this.availabilityZones[0]
    const otherZone = this.availabilityZones.find((candidate) => candidate !== zone)
    if (!zone || !otherZone) throw new Error('RDS needs subnets in two availability zones, and the region offers fewer')
    const vpc = new ec2.Vpc(this, 'Network', {
      vpcName: 'agents',
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      availabilityZones: [zone, otherZone],
      // No NAT gateway. The instances get public addresses for outbound traffic only.
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    })
    const hostSubnet = vpc.publicSubnets.find((subnet) => subnet.availabilityZone === zone)
    if (!hostSubnet) throw new Error(`no public subnet in ${zone}`)

    // No group allows anything from the internet. Boxes reach the machine port,
    // and the server reaches Postgres, each named by group, never by range.
    const serverGroup = new ec2.SecurityGroup(this, 'ServerGroup', {
      vpc, allowAllOutbound: true, description: 'agents server: inbound only from the box host to the machine port',
    })
    const boxesGroup = new ec2.SecurityGroup(this, 'BoxesGroup', {
      vpc, allowAllOutbound: true, description: 'agents box host: no inbound',
    })
    const databaseGroup = new ec2.SecurityGroup(this, 'DatabaseGroup', {
      vpc, allowAllOutbound: false, description: 'agents database: inbound only from the server to Postgres',
    })
    serverGroup.addIngressRule(boxesGroup, ec2.Port.tcp(MACHINE_PORT), 'boxes reach the machine port')
    databaseGroup.addIngressRule(serverGroup, ec2.Port.tcp(POSTGRES_PORT), 'the server reaches Postgres')

    // ---- Backups ----
    const bucket = new s3.Bucket(this, 'Backups', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: 'backups/', expiration: Duration.days(BACKUP_DAYS), noncurrentVersionExpiration: Duration.days(BACKUP_DAYS) },
        { prefix: 'cutover/', expiration: Duration.days(CUTOVER_DAYS), noncurrentVersionExpiration: Duration.days(CUTOVER_DAYS) },
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    })

    // ---- Database ----
    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 })
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, securityGroups: [databaseGroup],
      parameterGroup: new rds.ParameterGroup(this, 'DatabaseParameters', {
        engine,
        description: 'agents: logical replication for Electric',
        parameters: { 'rds.logical_replication': '1', max_slot_wal_keep_size: String(MAX_SLOT_WAL_MB) },
      }),
      databaseName: 'agents',
      credentials: rds.Credentials.fromGeneratedSecret('agents'),
      allocatedStorage: DATABASE_GB, maxAllocatedStorage: DATABASE_MAX_GB,
      storageType: rds.StorageType.GP3, storageEncrypted: true,
      multiAz: false, publiclyAccessible: false,
      backupRetention: Duration.days(7), deleteAutomatedBackups: false,
      preferredBackupWindow: '07:00-07:30', preferredMaintenanceWindow: 'sun:08:00-sun:08:30',
      autoMinorVersionUpgrade: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      deletionProtection: !teardown,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    })
    const databaseSecret = database.secret
    if (!databaseSecret) throw new Error('the database has no generated secret')

    // ---- What the hosts read at boot ----
    const code = new s3assets.Asset(this, 'Code', { path: props.codeBundle })
    const codeLocation = new ssm.StringParameter(this, 'CodeLocation', {
      parameterName: CODE_PARAMETER, stringValue: code.s3ObjectUrl, description: 'agents: the deployed commit, as a git bundle',
    })
    const hostConfig: HostConfig = {
      region: this.region, bucket: bucket.bucketName, databaseSecretArn: databaseSecret.secretArn,
      serverAddress: SERVER_ADDRESS, boxHostAddress: BOX_HOST_ADDRESS, resolver: VPC_RESOLVER,
      machinePort: MACHINE_PORT, peoplePort: PEOPLE_PORT,
    }
    const configParameter = new ssm.StringParameter(this, 'HostConfig', {
      parameterName: CONFIG_PARAMETER, stringValue: this.toJsonString(hostConfig), description: 'agents: what the hosts need at boot, no secrets',
    })

    // ---- Roles ----
    const secretParameters = (names: SecretName[]) => names.map((name) =>
      this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: SECRET_PARAMETERS[name].slice(1) }))
    const role = (name: Role, secrets: SecretName[]) => {
      const hostRole = new iam.Role(this, name === 'server' ? 'ServerRole' : 'BoxesRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        description: `agents ${name}: its own parameters, the code, and its metrics`,
      })
      // The bundle only. The assets bucket holds every stack's assets.
      hostRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [code.bucket.arnForObjects(code.s3ObjectKey)] }))
      codeLocation.grantRead(hostRole)
      configParameter.grantRead(hostRole)
      hostRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: secretParameters(secrets) }))
      // PutMetricData takes no resource, so the namespace is the limit.
      hostRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
      }))
      return hostRole
    }
    const serverRole = role('server', ['tailscale-server', 'hook-secret', 'box-claude-token', 'forge-json'])
    databaseSecret.grantRead(serverRole)
    bucket.grantPut(serverRole, 'backups/*')
    bucket.grantRead(serverRole, 'backups/*')
    bucket.grantRead(serverRole, 'cutover/*')
    const boxesRole = role('boxes', ['tailscale-boxes'])

    // ---- Instances ----
    const machineImage = ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64, cachedInContext: true })
    const instance = (name: Role, spec: { type: string; address: string; group: ec2.SecurityGroup; role: iam.Role; diskGb: number }) =>
      new ec2.Instance(this, name === 'server' ? 'Server' : 'BoxHost', {
        instanceName: name === 'server' ? 'agents-server' : 'agents-boxes',
        vpc, vpcSubnets: { subnets: [hostSubnet] },
        instanceType: new ec2.InstanceType(spec.type), machineImage,
        securityGroup: spec.group, role: spec.role,
        privateIpAddress: spec.address, associatePublicIpAddress: true,
        // IMDSv2 only, and a hop limit of 1, so an answer never reaches a container.
        httpTokens: ec2.HttpTokens.REQUIRED, httpPutResponseHopLimit: 1, httpEndpoint: true, instanceMetadataTags: false,
        blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(spec.diskGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) }],
        userData: firstBoot(name, this.region), userDataCausesReplacement: false,
        disableApiTermination: !teardown,
      })
    const server = instance('server', { type: 't4g.large', address: SERVER_ADDRESS, group: serverGroup, role: serverRole, diskGb: SERVER_DISK_GB })
    const boxHost = instance('boxes', {
      type: settings.AGENTS_AWS_BOX_HOST_TYPE, address: BOX_HOST_ADDRESS, group: boxesGroup, role: boxesRole, diskGb: BOX_HOST_DISK_GB,
    })

    // ---- Alarms ----
    const topic = new sns.Topic(this, 'Alarms', { displayName: 'Agents alarms' })
    topic.addSubscription(new subscriptions.EmailSubscription(settings.AGENTS_AWS_ALARM_EMAIL))
    const notify = new actions.SnsAction(topic)
    type AlarmSpec = {
      id: string; description: string; metric: cloudwatch.IMetric; threshold: number; periods: number
      above: boolean; missing: cloudwatch.TreatMissingData; also?: cloudwatch.IAlarmAction
    }
    const alarm = (spec: AlarmSpec) => {
      const made = new cloudwatch.Alarm(this, spec.id, {
        alarmDescription: spec.description, metric: spec.metric, threshold: spec.threshold,
        evaluationPeriods: spec.periods, datapointsToAlarm: spec.periods, treatMissingData: spec.missing,
        comparisonOperator: spec.above ? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD : cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      })
      made.addAlarmAction(notify)
      if (spec.also) made.addAlarmAction(spec.also)
      return made
    }
    const ours = (name: string, host: Role, period: Duration, statistic: string) =>
      new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName: name, dimensionsMap: { Host: host }, period, statistic })
    const ec2Status = (name: string, target: ec2.Instance) =>
      new cloudwatch.Metric({ namespace: 'AWS/EC2', metricName: name, dimensionsMap: { InstanceId: target.instanceId }, period: Duration.minutes(1), statistic: 'Maximum' })
    const minute = Duration.minutes(1)
    const fiveMinutes = Duration.minutes(5)
    for (const [host, target] of [['server', server], ['boxes', boxHost]] as const) {
      const label = host === 'server' ? 'Server' : 'BoxHost'
      alarm({
        id: `${label}SystemCheck`, description: `agents ${host}: AWS's hardware check failed, so the instance is moved to healthy hardware`,
        metric: ec2Status('StatusCheckFailed_System', target), threshold: 0, periods: 2, above: true,
        missing: cloudwatch.TreatMissingData.NOT_BREACHING, also: new actions.Ec2Action(actions.Ec2InstanceAction.RECOVER),
      })
      alarm({
        id: `${label}InstanceCheck`, description: `agents ${host}: the instance stopped answering its status check, so it is rebooted`,
        metric: ec2Status('StatusCheckFailed_Instance', target), threshold: 0, periods: 3, above: true,
        missing: cloudwatch.TreatMissingData.NOT_BREACHING, also: new actions.Ec2Action(actions.Ec2InstanceAction.REBOOT),
      })
      alarm({
        id: `${label}Disk`, description: `agents ${host}: the root disk is over 80% full`,
        metric: ours('DiskUsedPercent', host, fiveMinutes, 'Maximum'), threshold: 80, periods: 2, above: true,
        missing: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    }
    alarm({
      id: 'BoxHostMemory', description: 'agents boxes: memory over 85% for 15 minutes; time for m7g.2xlarge (docs/aws.md)',
      metric: ours('MemoryUsedPercent', 'boxes', fiveMinutes, 'Average'), threshold: 85, periods: 3, above: true,
      missing: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    for (const [id, metric, what] of [['ApiDown', 'ApiUp', 'the API'], ['ElectricDown', 'ElectricUp', 'Electric'], ['ForgeDown', 'ForgeUp', 'the forge']] as const) {
      alarm({
        id, description: `agents server: ${what} has not answered for 3 minutes, or the server stopped reporting`,
        metric: ours(metric, 'server', minute, 'Minimum'), threshold: 1, periods: 3, above: false,
        missing: cloudwatch.TreatMissingData.BREACHING,
      })
    }
    alarm({
      id: 'BackupOld', description: 'agents server: the last good backup is more than 30 hours old',
      metric: ours('BackupAgeHours', 'server', fiveMinutes, 'Maximum'), threshold: 30, periods: 1, above: true,
      missing: cloudwatch.TreatMissingData.BREACHING,
    })
    alarm({
      id: 'DatabaseStorage', description: 'agents database: less than 4 GiB free',
      metric: database.metricFreeStorageSpace({ period: fiveMinutes }), threshold: 4 * 1024 ** 3, periods: 1, above: false,
      missing: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    alarm({
      id: 'DatabaseCpu', description: 'agents database: CPU over 80% for 15 minutes',
      metric: database.metricCPUUtilization({ period: fiveMinutes }), threshold: 80, periods: 3, above: true,
      missing: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    alarm({
      id: 'ElectricBehind', description: "agents database: Electric's replication slot is more than 1 GiB behind",
      metric: database.metric('OldestReplicationSlotLag', { period: fiveMinutes, statistic: 'Maximum' }), threshold: 1024 ** 3, periods: 2, above: true,
      missing: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
  }
}
