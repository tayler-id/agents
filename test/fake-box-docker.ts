// A stand-in for the docker CLI, for the box code of the API that step25 runs, so
// the check never touches the Mac's Docker. It answers `ps` with the containers in
// the file STEP25_DOCKER_STATE names, one "<instance id> <state>" line each, as
// BOX_STATE_FORMAT asks for. `start` marks a container running and `stop` marks it
// exited. It adds every call to STEP25_DOCKER_LOG, so the check sees what the
// runner asked Docker to do. Every other command succeeds and changes nothing.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const log = process.env.STEP25_DOCKER_LOG
const stateFile = process.env.STEP25_DOCKER_STATE
if (!log || !stateFile) {
  console.error('fake docker: STEP25_DOCKER_LOG and STEP25_DOCKER_STATE must be set')
  process.exit(1)
}
const argv = process.argv.slice(2)
appendFileSync(log, `${argv.join(' ')}\n`)

const states = new Map(readFileSync(stateFile, 'utf8').split('\n').filter((line) => line !== '').map((line) => {
  const [id = '', state = ''] = line.split(' ')
  return [id, state] as const
}))
const save = () => { writeFileSync(stateFile, [...states].map(([id, state]) => `${id} ${state}\n`).join('')) }
const idOf = (container: string | undefined) => (container ?? '').replace(/^agents-box-/, '')

const [command, container] = argv
if (command === 'ps') {
  process.stdout.write([...states].map(([id, state]) => `${id} ${state}`).join('\n'))
} else if (command === 'start' || command === 'stop') {
  const id = idOf(container)
  if (!states.has(id)) {
    console.error(`Error response from daemon: No such container: ${container ?? ''}`)
    process.exit(1)
  }
  states.set(id, command === 'start' ? 'running' : 'exited')
  save()
}
