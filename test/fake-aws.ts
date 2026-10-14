// A fake AWS for checks, speaking each service's real wire protocol: SSM and
// Secrets Manager's JSON 1.1, CloudWatch's JSON 1.0, and S3's REST API, path
// style, with its chunked uploads and its object listing. Like real AWS it
// refuses an unsigned request. Scripts reach it through AWS_ENDPOINT_URL, the
// SDK's own setting, so the code under test runs unchanged.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
// A script runs as its own process while the check's keeps serving this fake, so
// it is awaited, never run synchronously. One that takes longer than this is stuck.
const SCRIPT_MS = 120_000

export type Call = { service: string; operation: string; body: string }
export type Parameter = { value: string; type: string; tags: Record<string, string> }
export type Metric = { namespace: string; name: string; value: number; host: string }
export type Ran = { status: number | null; out: string }

const SsmGet = z.object({ Name: z.string(), WithDecryption: z.boolean().optional() })
const SsmPut = z.object({ Name: z.string(), Value: z.string(), Type: z.string(), Overwrite: z.boolean().optional() })
const SsmTags = z.object({ ResourceId: z.string(), Tags: z.array(z.object({ Key: z.string(), Value: z.string() })) })
const SecretGet = z.object({ SecretId: z.string() })
const PutMetrics = z.object({
  Namespace: z.string(),
  MetricData: z.array(z.object({ MetricName: z.string(), Value: z.number(), Dimensions: z.array(z.object({ Name: z.string(), Value: z.string() })) })),
})

// S3 sends a streamed body in aws-chunked framing: hex size, data, and a checksum trailer after the last chunk.
function unchunk(body: Buffer): Buffer {
  const parts: Buffer[] = []
  let at = 0
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at)
    const size = parseInt(body.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '', 16)
    if (!(size > 0)) return Buffer.concat(parts)
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
    at = lineEnd + 2 + size + 2
  }
}

const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const json = (res: ServerResponse, status: number, body: unknown, type: string) => {
  res.writeHead(status, { 'content-type': type }).end(JSON.stringify(body))
}

export async function startFakeAws(port: number, bucket: string, region = 'us-east-1') {
  const calls: Call[] = []
  const parameters = new Map<string, Parameter>()
  const secrets = new Map<string, string>()
  // Objects are kept as bucket/key.
  const objects = new Map<string, Buffer>()
  const metrics: Metric[] = []
  const children: ChildProcess[] = []

  function answer(req: IncomingMessage, raw: Buffer, res: ServerResponse) {
    if (!(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) return void res.writeHead(403).end()
    const target = req.headers['x-amz-target']
    const body = raw.toString('utf8')
    if (typeof target === 'string') {
      const [service = '', operation = ''] = target.split('.')
      calls.push({ service, operation, body })
      const json11 = 'application/x-amz-json-1.1'
      if (target === 'AmazonSSM.GetParameter') {
        const { Name } = SsmGet.parse(JSON.parse(body))
        const found = parameters.get(Name)
        if (!found) return json(res, 400, { __type: 'ParameterNotFound', message: `no ${Name}` }, json11)
        return json(res, 200, { Parameter: { Name, Value: found.value, Type: found.type, Version: 1 } }, json11)
      }
      if (target === 'AmazonSSM.PutParameter') {
        const put = SsmPut.parse(JSON.parse(body))
        const existing = parameters.get(put.Name)
        if (existing && !put.Overwrite) return json(res, 400, { __type: 'ParameterAlreadyExists', message: `${put.Name} exists` }, json11)
        parameters.set(put.Name, { value: put.Value, type: put.Type, tags: existing?.tags ?? {} })
        return json(res, 200, { Version: 1, Tier: 'Standard' }, json11)
      }
      if (target === 'AmazonSSM.AddTagsToResource') {
        const tagged = SsmTags.parse(JSON.parse(body))
        const found = parameters.get(tagged.ResourceId)
        if (found) for (const tag of tagged.Tags) found.tags[tag.Key] = tag.Value
        return json(res, 200, {}, json11)
      }
      if (target === 'secretsmanager.GetSecretValue') {
        const { SecretId } = SecretGet.parse(JSON.parse(body))
        const value = secrets.get(SecretId)
        if (value === undefined) return json(res, 400, { __type: 'ResourceNotFoundException', message: `no ${SecretId}` }, json11)
        return json(res, 200, { ARN: SecretId, Name: 'agents-db', SecretString: value }, json11)
      }
      if (target === 'GraniteServiceVersion20100801.PutMetricData') {
        const put = PutMetrics.parse(JSON.parse(body))
        for (const datum of put.MetricData) {
          metrics.push({ namespace: put.Namespace, name: datum.MetricName, value: datum.Value, host: datum.Dimensions.find((d) => d.Name === 'Host')?.Value ?? '' })
        }
        return json(res, 200, {}, 'application/x-amz-json-1.0')
      }
      return json(res, 400, { __type: 'UnknownOperationException', message: target }, json11)
    }
    // S3, path style: /<bucket>/<key>, or /<bucket>?list-type=2&prefix=... to list.
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = decodeURIComponent(url.pathname.slice(1))
    if (path.replace(/\/$/, '') === bucket && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      calls.push({ service: 'S3', operation: 'ListObjectsV2', body: prefix })
      const keys = [...objects.keys()].filter((name) => name.startsWith(`${bucket}/${prefix}`)).map((name) => name.slice(`${bucket}/`.length)).sort()
      const contents = keys.map((key) => `<Contents><Key>${xmlText(key)}</Key><Size>${objects.get(`${bucket}/${key}`)?.length ?? 0}</Size>`
        + '<ETag>"fake"</ETag><StorageClass>STANDARD</StorageClass></Contents>').join('')
      return void res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0" encoding="UTF-8"?>'
        + `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlText(prefix)}</Prefix>`
        + `<KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`)
    }
    if (!path.startsWith(`${bucket}/`)) return void res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchBucket</Code></Error>')
    calls.push({ service: 'S3', operation: req.method ?? '', body: path })
    if (req.method === 'PUT') {
      objects.set(path, (req.headers['content-encoding'] ?? '').includes('aws-chunked') ? unchunk(raw) : raw)
      return void res.writeHead(200, { etag: '"fake"' }).end()
    }
    const object = objects.get(path)
    if (req.method === 'GET' && object) return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': object.length }).end(object)
    res.writeHead(404, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>no ${xmlText(path)}</Message></Error>`)
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => { answer(req, Buffer.concat(chunks), res) })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  // What points the SDK at this fake, with credentials it signs with.
  const env = {
    AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`, AWS_REGION: region, AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE', AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_EC2_METADATA_DISABLED: 'true',
  }

  // Runs a script from the repo against this fake, with what it printed, and the
  // last lines of a failing one shown, so a failure can be read without a rerun.
  function script(args: string[], extra: Record<string, string> = {}, input = ''): Promise<Ran> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString() })
      const timer = setTimeout(() => { out += `\n(stopped after ${SCRIPT_MS} ms)`; child.kill('SIGKILL') }, SCRIPT_MS)
      child.once('close', (status) => {
        clearTimeout(timer)
        if (status !== 0) console.log(`  ${args.join(' ')} exited ${String(status)}:\n${out.trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n')}`)
        resolve({ status, out })
      })
      child.stdin.end(input)
    })
  }

  return {
    calls, parameters, secrets, objects, metrics, env, script,
    async close() {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
