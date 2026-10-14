// Where the API's machine port listens: AGENTS_MACHINE_HOST, a comma-separated
// list of IP addresses, or 127.0.0.1 when unset. The API listens on each, and the
// cutover export probes each to know the API has stopped.

import { z } from 'zod'

export const MachineHosts = z.string().default('127.0.0.1')
  .transform((value) => value.split(',').map((host) => host.trim()))
  .pipe(z.array(z.union([z.ipv4(), z.ipv6()])).min(1))
