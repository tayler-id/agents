// The machines a person may put a new agent on. A teammate's own box is left out,
// since agents there run on that teammate's Claude account.
import type { Instance, Me } from './data.ts'

export const machinesFor = (instances: Instance[], me: Me): Instance[] =>
  instances.filter((i) => (i.kind === 'mac' || i.claimed_by) && (!i.personal || i.owner_id === me.person.id))

// Where a form starts: the person's own box, else the first machine.
export const startMachine = (machines: Instance[]): string | undefined => (machines.find((i) => i.personal) ?? machines[0])?.id
