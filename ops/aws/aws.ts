// The AWS calls the ops scripts share, each response parsed with zod. The
// clients find their region and credentials the SDK's usual way: the instance's
// role on AWS, the signed-in profile on this Mac.

import { createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteBucketCommand, DeleteObjectsCommand,
  GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, UploadPartCommand, type CompletedPart, type S3Client,
} from '@aws-sdk/client-s3'
import {
  AddTagsToResourceCommand, GetParameterCommand, ParameterAlreadyExists, ParameterNotFound, PutParameterCommand, type SSMClient,
} from '@aws-sdk/client-ssm'
import { z } from 'zod'
import { messageOf } from '../../shared/errors.ts'
import { CONFIG_PARAMETER, HostConfig, SECRET_PARAMETERS, TAG, type SecretName } from './config.ts'

// A parameter's value, decrypted, or undefined when there is no such parameter.
export async function readParameter(ssm: SSMClient, name: string): Promise<string | undefined> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    return z.string().parse(out.Parameter?.Value)
  } catch (error) {
    if (error instanceof ParameterNotFound) return undefined
    throw error
  }
}

export async function hostConfig(ssm: SSMClient): Promise<HostConfig> {
  const raw = await readParameter(ssm, CONFIG_PARAMETER)
  if (raw === undefined) throw new Error(`there is no ${CONFIG_PARAMETER}: deploy the stack first (cd ops/aws && npx cdk deploy)`)
  return HostConfig.parse(JSON.parse(raw))
}

// Stores a secret as a SecureString, tagged when it is new. PutParameter can only
// tag a parameter it creates, so an existing one is overwritten untagged.
export async function putSecret(ssm: SSMClient, name: SecretName, value: string): Promise<'created' | 'replaced'> {
  const parameter = SECRET_PARAMETERS[name]
  try {
    await ssm.send(new PutParameterCommand({ Name: parameter, Value: value, Type: 'SecureString', Overwrite: false, Description: `agents: ${name}` }))
    await ssm.send(new AddTagsToResourceCommand({ ResourceType: 'Parameter', ResourceId: parameter, Tags: [{ Key: TAG.key, Value: TAG.value }] }))
    return 'created'
  } catch (error) {
    if (!(error instanceof ParameterAlreadyExists)) throw error
    await ssm.send(new PutParameterCommand({ Name: parameter, Value: value, Type: 'SecureString', Overwrite: true }))
    return 'replaced'
  }
}

// s3://bucket/key, split.
export const S3Location = z.string().regex(/^s3:\/\/[a-z0-9.-]+\/.+$/, 'an s3://bucket/key URL').transform((url) => {
  const rest = url.slice('s3://'.length)
  return { bucket: rest.slice(0, rest.indexOf('/')), key: rest.slice(rest.indexOf('/') + 1) }
})

// Files go up in parts of this size. One PutObject stops at 5 GiB, and S3 takes
// up to 10,000 parts, so this reaches 640 GiB.
export const PART_BYTES = 64 * 1024 * 1024
const CHECKSUM = 'CRC32'

// Uploads a file as a multipart upload, a part at a time. Each part carries its
// CRC32, which S3 checks as it arrives. An upload that fails part way is given
// up, since its parts would cost storage until then.
export async function upload(s3: S3Client, file: string, bucket: string, key: string): Promise<void> {
  const started = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ChecksumAlgorithm: CHECKSUM }))
  const uploadId = z.string().min(1).parse(started.UploadId)
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const parts: CompletedPart[] = []
    // An empty file is still one part, since an upload needs at least one.
    for (let offset = 0; offset === 0 || offset < size; offset += PART_BYTES) {
      const body = Buffer.alloc(Math.min(PART_BYTES, size - offset))
      const { bytesRead } = await handle.read(body, 0, body.length, offset)
      if (bytesRead !== body.length) throw new Error(`${file} got shorter while it was uploading`)
      const PartNumber = parts.length + 1
      const sent = await s3.send(new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumber, Body: body, ContentLength: body.length, ChecksumAlgorithm: CHECKSUM,
      }))
      parts.push({ PartNumber, ETag: z.string().min(1).parse(sent.ETag), ChecksumCRC32: z.string().min(1).parse(sent.ChecksumCRC32) })
    }
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }))
  } catch (error) {
    // The upload's own failure is the one to report. Failing to give it up too is said, not thrown over it.
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch((abortError: unknown) => {
      console.error(`giving up the upload to s3://${bucket}/${key} failed too: ${messageOf(abortError)}`)
    })
    throw error
  } finally {
    await handle.close()
  }
}

export type S3Object = { key: string; size: number }

// Every object under a prefix, with its size, page by page.
export async function listObjects(s3: S3Client, bucket: string, prefix: string): Promise<S3Object[]> {
  const found: S3Object[] = []
  let token: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    // S3 leaves Contents out when nothing matches.
    const contents = z.array(z.object({ Key: z.string(), Size: z.number().int().nonnegative() })).parse(page.Contents ?? [])
    found.push(...contents.map((object) => ({ key: object.Key, size: object.Size })))
    token = page.NextContinuationToken
  } while (token)
  return found
}

export async function download(s3: S3Client, bucket: string, key: string, file: string): Promise<void> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!(out.Body instanceof Readable)) throw new Error(`s3://${bucket}/${key} came back without a body`)
  await pipeline(out.Body, createWriteStream(file, { mode: 0o600 }))
}

// S3 deletes up to 1000 keys a call. A refusal names this many of the keys S3 kept.
const DELETE_BATCH = 1000
const NAMED = 10
const Version = z.object({ Key: z.string(), VersionId: z.string() })
const DeleteError = z.object({ Key: z.string(), Code: z.string() })

// Deletes every version of every object in a bucket, then the bucket. When S3
// keeps any, it stops and names them, where listing and sending them again
// would never end.
export async function deleteBucket(s3: S3Client, name: string): Promise<void> {
  for (;;) {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: name, MaxKeys: DELETE_BATCH }))
    const versions = z.array(Version).parse([...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
    if (!versions.length) break
    const out = await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: versions, Quiet: true } }))
    const errors = z.array(DeleteError).parse(out.Errors ?? [])
    if (errors.length) {
      const named = errors.slice(0, NAMED).map((error) => `${error.Key} (${error.Code})`).join(', ')
      throw new Error(`S3 would not delete ${String(errors.length)} objects in ${name}, such as ${named}`)
    }
  }
  await s3.send(new DeleteBucketCommand({ Bucket: name }))
}
