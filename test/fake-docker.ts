// A stand-in for docker, for step22, so the check never touches the Mac's Docker.
// It adds each call to the file STEP22_FAKE_DOCKER_LOG names. A build waits until
// it is killed when STEP22_FAKE_DOCKER_HANG is set, as a stuck build would.

import { appendFileSync } from 'node:fs'

const log = process.env.STEP22_FAKE_DOCKER_LOG
if (!log) {
  console.error('fake docker: STEP22_FAKE_DOCKER_LOG is not set')
  process.exit(1)
}
const argv = process.argv.slice(2)
appendFileSync(log, `${argv.join(' ')}\n`)
if (argv[0] === 'build' && process.env.STEP22_FAKE_DOCKER_HANG) setInterval(() => undefined, 1000)
