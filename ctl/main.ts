#!/usr/bin/env node
// agentsctl, the tool for running and driving Agents in verification:
//   bin/agentsctl          a dashboard of what runs here and what to try next
//   bin/agentsctl help     every command
// It needs Node 24 first on the PATH (~/.local/node/bin on the server Mac).
// Everything it prints goes to stdout, the stream an agent reads, and the exit
// code says whether it worked. A command that keeps running, such as preview,
// prints what it has to say as it goes, and its last result when it ends.

import { render } from '../shared/cli/output.ts'
import type { Shown } from '../shared/cli/command.ts'
import { runCli } from './cli.ts'

const show = ({ output, json, full }: Shown) => {
  process.stdout.write(`${json ? JSON.stringify(output) : render(output, full)}\n`)
}

const { code, output, json, full } = await runCli(process.argv.slice(2), show)
show({ code, output, json, full })
process.exitCode = code
