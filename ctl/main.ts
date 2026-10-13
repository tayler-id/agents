#!/usr/bin/env node
// agentsctl, the tool for running and driving Agents in verification:
//   bin/agentsctl help
// It needs Node 24 first on the PATH (~/.local/node/bin on the server Mac).

import { runCli } from './cli.ts'

const { code, output, json } = await runCli(process.argv.slice(2))
if (json) process.stdout.write(`${JSON.stringify(output)}\n`)
else if (output.ok) process.stdout.write(`${output.summary}\n`)
else process.stderr.write(`agentsctl ${output.command}: ${output.summary}\n`)
process.exitCode = code
