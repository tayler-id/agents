// A fake AWS for checks, speaking each service's real wire protocol: SSM and
// Secrets Manager's JSON 1.1, CloudWatch's JSON 1.0, and S3's REST API, path
// style, with its chunked uploads, multipart uploads with CRC32 checksums, its
// object and version listings, and its batch delete. Like real AWS it refuses an
// unsigned request. Scripts reach it through AWS_ENDPOINT_URL, the SDK's own
// setting, so the code under test runs unchanged.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { crc32 } from 'node:zlib'
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

// S3 sends a streamed body in aws-chunked framing: hex size, data, and after the
// last chunk, trailers such as the checksum, a "name:value" line each.
function unchunk(body: Buffer): { data: Buffer; trailers: Map<string, string> } {
  const parts: Buffer[] = []
  let at = 0
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at)
    const size = parseInt(body.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '', 16)
    if (!(size > 0)) {
      const trailers = body.subarray(lineEnd + 2).toString('latin1').split('\r\n').filter((line) => line.includes(':'))
        .map((line) => [line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1).trim()] as const)
      return { data: Buffer.concat(parts), trailers: new Map(trailers) }
    }
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
    at = lineEnd + 2 + size + 2
  }
}

// S3 gives a CRC32 as the base64 of its four bytes, most significant first.
function crc32Of(data: Buffer): string {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(crc32(data))
  return bytes.toString('base64')
}

const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlUnescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const S3_XMLNS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
const json = (res: ServerResponse, status: number, body: unknown, type: string) => {
  res.writeHead(status, { 'content-type': type }).end(JSON.stringify(body))
}

export async function startFakeAws(port: number, bucket: string, region = 'us-east-1') {
  const calls: Call[] = []
  const parameters = new Map<string, Parameter>()
  const secrets = new Map<string, string>()
  // Objects are kept as bucket/key.
  const objects = new Map<string, Buffer>()
  // Sizes a listing gives instead of an object's own, by key, so a check can claim an export too large to stage.
  const sizes = new Map<string, number>()
  // Keys a batch delete refuses, as S3 does for an object it may not delete.
  const undeletable = new Set<string>()
  // Keys whose multipart uploads have every part refused, as a failing upload would.
  const refusedParts = new Set<string>()
  // Multipart uploads begun and not yet completed or given up, by upload id.
  const uploads = new Map<string, { key: string; checksum: string | undefined; parts: Map<number, { etag: string; crc32: string; data: Buffer }> }>()
  let uploadCount = 0
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
    // S3, path style: /<bucket>/<key>, or the bucket itself with a query naming the operation.
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = decodeURIComponent(url.pathname.slice(1))
    const xml = (status: number, text: string) => void res.writeHead(status, { 'content-type': 'application/xml' })
      .end(`<?xml version="1.0" encoding="UTF-8"?>${text}`)
    const keysUnder = (prefix: string) => [...objects.keys()].filter((name) => name.startsWith(`${bucket}/${prefix}`))
      .map((name) => name.slice(`${bucket}/`.length)).sort()
    const listedSize = (key: string) => sizes.get(key) ?? objects.get(`${bucket}/${key}`)?.length ?? 0
    if (path.replace(/\/$/, '') === bucket) {
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        calls.push({ service: 'S3', operation: 'ListObjectsV2', body: prefix })
        const keys = keysUnder(prefix)
        const contents = keys.map((key) => `<Contents><Key>${xmlText(key)}</Key><Size>${String(listedSize(key))}</Size>`
          + '<ETag>"fake"</ETag><StorageClass>STANDARD</StorageClass></Contents>').join('')
        return xml(200, `<ListBucketResult ${S3_XMLNS}><Name>${bucket}</Name><Prefix>${xmlText(prefix)}</Prefix>`
          + `<KeyCount>${String(keys.length)}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`)
      }
      // The fake keeps no versions, so each object is its one version, "null", as S3 calls those.
      if (req.method === 'GET' && url.searchParams.has('versions')) {
        calls.push({ service: 'S3', operation: 'ListObjectVersions', body: '' })
        const versions = keysUnder('').map((key) => `<Version><Key>${xmlText(key)}</Key><VersionId>null</VersionId><IsLatest>true</IsLatest>`
          + `<LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"fake"</ETag><Size>${String(listedSize(key))}</Size>`
          + '<StorageClass>STANDARD</StorageClass></Version>').join('')
        return xml(200, `<ListVersionsResult ${S3_XMLNS}><Name>${bucket}</Name><Prefix></Prefix><MaxKeys>1000</MaxKeys>`
          + `<IsTruncated>false</IsTruncated>${versions}</ListVersionsResult>`)
      }
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const text = raw.toString('utf8')
        const keys = [...text.matchAll(/<Object>\s*<Key>([^<]*)<\/Key>/g)].map((match) => xmlUnescape(match[1] ?? ''))
        calls.push({ service: 'S3', operation: 'DeleteObjects', body: keys.join(',') })
        for (const key of keys) if (!undeletable.has(key)) objects.delete(`${bucket}/${key}`)
        const quiet = /<Quiet>true<\/Quiet>/.test(text)
        const deleted = quiet ? '' : keys.filter((key) => !undeletable.has(key))
          .map((key) => `<Deleted><Key>${xmlText(key)}</Key><VersionId>null</VersionId></Deleted>`).join('')
        const failed = keys.filter((key) => undeletable.has(key))
          .map((key) => `<Error><Key>${xmlText(key)}</Key><VersionId>null</VersionId><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`).join('')
        return xml(200, `<DeleteResult ${S3_XMLNS}>${deleted}${failed}</DeleteResult>`)
      }
      if (req.method === 'DELETE') {
        calls.push({ service: 'S3', operation: 'DeleteBucket', body: bucket })
        if (keysUnder('').length) return xml(409, `<Error><Code>BucketNotEmpty</Code><Message>${bucket} is not empty</Message></Error>`)
        return void res.writeHead(204).end()
      }
      return xml(501, `<Error><Code>NotImplemented</Code><Message>${xmlText(`${req.method ?? ''} ${req.url ?? ''}`)}</Message></Error>`)
    }
    if (!path.startsWith(`${bucket}/`)) return xml(404, '<Error><Code>NoSuchBucket</Code></Error>')
    const key = path.slice(`${bucket}/`.length)
    const chunked = (req.headers['content-encoding'] ?? '').includes('aws-chunked')
    const sent = chunked ? unchunk(raw) : { data: raw, trailers: new Map<string, string>() }
    // A multipart upload: begun, given parts, then completed into one object, or given up.
    const uploadId = url.searchParams.get('uploadId')
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `upload-${String(++uploadCount)}`
      const checksum = req.headers['x-amz-checksum-algorithm']
      uploads.set(id, { key, checksum: typeof checksum === 'string' ? checksum : undefined, parts: new Map() })
      calls.push({ service: 'S3', operation: 'CreateMultipartUpload', body: path })
      return xml(200, `<InitiateMultipartUploadResult ${S3_XMLNS}><Bucket>${bucket}</Bucket><Key>${xmlText(key)}</Key>`
        + `<UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (uploadId !== null) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) return xml(404, `<Error><Code>NoSuchUpload</Code><Message>${xmlText(uploadId)}</Message></Error>`)
      if (req.method === 'PUT') {
        if (refusedParts.has(key)) return xml(400, '<Error><Code>InvalidRequest</Code><Message>this fake refuses parts of this key</Message></Error>')
        const number = Number(url.searchParams.get('partNumber'))
        // S3 checks a part against the CRC32 sent with it, in a header or a trailer, and answers with its own.
        // An upload begun with a checksum needs one on every part.
        const declared = req.headers['x-amz-checksum-crc32'] ?? sent.trailers.get('x-amz-checksum-crc32')
        const computed = crc32Of(sent.data)
        if (upload.checksum !== undefined && declared === undefined) return xml(400, '<Error><Code>InvalidRequest</Code><Message>this part has no CRC32</Message></Error>')
        if (declared !== undefined && declared !== computed) return xml(400, '<Error><Code>BadDigest</Code><Message>the CRC32 does not match</Message></Error>')
        const etag = `"part-${String(number)}-${String(sent.data.length)}"`
        upload.parts.set(number, { etag, crc32: computed, data: sent.data })
        calls.push({ service: 'S3', operation: 'UploadPart', body: `${path} part ${String(number)}, ${String(sent.data.length)} bytes` })
        return void res.writeHead(200, { etag, 'x-amz-checksum-crc32': computed }).end()
      }
      if (req.method === 'POST') {
        // The parts named, in order, each with the ETag, and the CRC32 when the upload has one, that its part was given.
        const named = [...raw.toString('utf8').matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((match) => ({
          number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(match[1] ?? '')?.[1]),
          etag: xmlUnescape(/<ETag>([^<]*)<\/ETag>/.exec(match[1] ?? '')?.[1] ?? ''),
          crc32: /<ChecksumCRC32>([^<]*)<\/ChecksumCRC32>/.exec(match[1] ?? '')?.[1],
        }))
        const parts = named.map((part) => upload.parts.get(part.number))
        const wrong = named.some((part, index) => {
          const found = parts[index]
          return found === undefined || found.etag !== part.etag || (upload.checksum !== undefined && found.crc32 !== part.crc32)
        })
        if (!named.length || wrong) return xml(400, '<Error><Code>InvalidPart</Code><Message>a part named was not uploaded, or its ETag or CRC32 differs</Message></Error>')
        objects.set(path, Buffer.concat(parts.map((part) => part?.data ?? Buffer.alloc(0))))
        uploads.delete(uploadId)
        calls.push({ service: 'S3', operation: 'CompleteMultipartUpload', body: `${path}, ${String(named.length)} parts` })
        return xml(200, `<CompleteMultipartUploadResult ${S3_XMLNS}><Location>http://fake/${xmlText(path)}</Location><Bucket>${bucket}</Bucket>`
          + `<Key>${xmlText(key)}</Key><ETag>"fake-${String(named.length)}"</ETag></CompleteMultipartUploadResult>`)
      }
      if (req.method === 'DELETE') {
        uploads.delete(uploadId)
        calls.push({ service: 'S3', operation: 'AbortMultipartUpload', body: path })
        return void res.writeHead(204).end()
      }
    }
    calls.push({ service: 'S3', operation: req.method ?? '', body: path })
    if (req.method === 'PUT') {
      objects.set(path, sent.data)
      return void res.writeHead(200, { etag: '"fake"' }).end()
    }
    const object = objects.get(path)
    if (req.method === 'GET' && object) return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': object.length }).end(object)
    xml(404, `<Error><Code>NoSuchKey</Code><Message>no ${xmlText(path)}</Message></Error>`)
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
  // One still running after limitMs is stopped, and says so.
  function script(args: string[], extra: Record<string, string> = {}, input = '', limitMs = SCRIPT_MS): Promise<Ran> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString() })
      const timer = setTimeout(() => { out += `\n(stopped after ${String(limitMs)} ms)`; child.kill('SIGKILL') }, limitMs)
      child.once('close', (status) => {
        clearTimeout(timer)
        if (status !== 0) console.log(`  ${args.join(' ')} exited ${String(status)}:\n${out.trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n')}`)
        resolve({ status, out })
      })
      child.stdin.end(input)
    })
  }

  return {
    calls, parameters, secrets, objects, sizes, undeletable, refusedParts, uploads, metrics, env, script,
    async close() {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
