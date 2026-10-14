// The AWS calls the ops scripts share, each response parsed with zod. The
// clients find their region and credentials the SDK's usual way: the instance's
// role on AWS, the signed-in profile on this Mac.

import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import {
  AddTagsToResourceCommand, GetParameterCommand, ParameterAlreadyExists, ParameterNotFound, PutParameterCommand, type SSMClient,
} from '@aws-sdk/client-ssm'
import { z } from 'zod'
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

export async function upload(s3: S3Client, file: string, bucket: string, key: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: statSync(file).size }))
}

// Every key under a prefix, page by page.
export async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    // S3 leaves Contents out when nothing matches.
    keys.push(...z.array(z.object({ Key: z.string() })).parse(page.Contents ?? []).map((object) => object.Key))
    token = page.NextContinuationToken
  } while (token)
  return keys
}

export async function download(s3: S3Client, bucket: string, key: string, file: string): Promise<void> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!(out.Body instanceof Readable)) throw new Error(`s3://${bucket}/${key} came back without a body`)
  await pipeline(out.Body, createWriteStream(file, { mode: 0o600 }))
}
