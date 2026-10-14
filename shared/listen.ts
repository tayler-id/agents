// Where the API's machine port listens: AGENTS_API_PORT, MACHINE_PORT unless
// set, on AGENTS_MACHINE_HOST, a comma-separated list of IP addresses, or
// 127.0.0.1 when unset. The API listens on each, and the cutover export probes
// each to know the API has stopped.

import { z } from 'zod'

export const MACHINE_PORT = 7700
// A TCP port, as a setting.
export const Port = z.coerce.number().int().min(1).max(65535)

export const MachineHosts = z.string().default('127.0.0.1')
  .transform((value) => value.split(',').map((host) => host.trim()))
  .pipe(z.array(z.union([z.ipv4(), z.ipv6()])).min(1))
