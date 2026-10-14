// What a box's container and home volume are called, and the label that marks a
// box's container with its instance. The server starts boxes by these names, and
// the cutover export and restore find boxes' home folders by them.

import { z } from 'zod'

export const BOX_LABEL = 'agents.instance'
export const boxContainer = (instanceId: string) => `agents-box-${instanceId}`
export const boxHomeVolume = (instanceId: string) => `${boxContainer(instanceId)}-home`

// Docker's container states.
export const ContainerState = z.enum(['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'])
export type ContainerState = z.infer<typeof ContainerState>
// With this format, `docker ps --all --filter label=<BOX_LABEL>` prints a line for
// each box container: its instance id and its state.
export const BOX_STATE_FORMAT = `{{.Label "${BOX_LABEL}"}} {{.State}}`
export const BoxLine = z.string().transform((line) => line.split(' ')).pipe(z.tuple([z.uuid(), ContainerState]))
