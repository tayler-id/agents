// The git proxy reads a push's command lines and streams the rest. Checked on
// pushes built here, with no forge: the refs come out right, every byte of the
// push comes through in order, a gzipped push reads the same once unzipped,
// and a push that is not one, or that never ends its command lines, is refused.
//   node --env-file=.env --env-file=.env.test test/step16f.ts

import { randomBytes } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { createGunzip, gzipSync } from 'node:zlib'
import { plainBody, readCommands } from '../server/git.ts'

const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`
const sha = (c: string) => c.repeat(40)
const commands = pkt(`${sha('0')} ${sha('1')} refs/heads/task/one\0report-status side-band-64k`) + pkt(`${sha('2')} ${sha('3')} refs/heads/main`) + '0000'
// A pack far bigger than the command lines, sent in many chunks.
const pack = randomBytes(5 * 1024 * 1024)
const whole = Buffer.concat([Buffer.from(commands, 'latin1'), pack])
const chunked = (bytes: Buffer, size: number) => Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)))
const drain = async (stream: Readable) => {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
  return Buffer.concat(parts)
}
const refusal = (input: Readable) => readCommands(input).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)))

try {
  const { refs, stream } = await readCommands(chunked(whole, 7))
  check(refs.join(' ') === 'refs/heads/task/one refs/heads/main', `the refs a push updates are read from its command lines: ${refs.join(' ')}`)
  check((await drain(stream)).equals(whole), 'every byte of a push read in seven-byte chunks comes through, in order')

  const zipped = await readCommands(chunked(gzipSync(whole), 4096).pipe(createGunzip()))
  check(zipped.refs.length === 2 && (await drain(zipped.stream)).equals(whole), 'a gzipped push reads the same once unzipped')

  check((await refusal(Readable.from([Buffer.from('zzzz not a push')])))?.includes('not a git push'), 'a body that is not a push is refused')
  const endless = Readable.from(Array.from({ length: 2048 }, () => Buffer.from(pkt(`${sha('0')} ${sha('1')} refs/heads/task/${'x'.repeat(900)}`), 'latin1')))
  check((await refusal(endless))?.includes('more command lines'), 'command lines that never end are refused before they fill memory')
  // A request that fails partway through its gzipped body fails the reader,
  // instead of leaving it waiting for bytes that never come.
  const cut = new PassThrough()
  cut.on('error', (error) => { console.log(`the request failed: ${error.message}`) })
  cut.write(gzipSync(whole).subarray(0, 12))
  setTimeout(() => { cut.destroy(new Error('the client went away')) }, 50)
  const failed = await Promise.race([refusal(plainBody(cut, 'gzip')), new Promise<string>((resolve) => { setTimeout(() => { resolve('still waiting') }, 5000) })])
  check(failed !== null && failed !== 'still waiting', `a gzipped push whose request fails partway fails its reader: ${failed ?? 'it read a push'}`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}

console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'}`)
process.exit(failures.length ? 1 : 0)
