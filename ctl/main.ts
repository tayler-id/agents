#!/usr/bin/env node
// agentsctl, the tool for running and driving Agents in verification:
//   bin/agentsctl          a dashboard of what runs here and what to try next
//   bin/agentsctl help     every command
// It needs Node 24 first on the PATH (~/.local/node/bin on the server Mac).

import { render } from './output.ts'
import { runCli } from './cli.ts'

const { code, output, json, full } = await runCli(process.argv.slice(2))
if (json) process.stdout.write(`${JSON.stringify(output)}\n`)
else if (output.ok) process.stdout.write(`${render(output, full)}\n`)
else process.stderr.write(`${render(output, full)}\n`)
process.exitCode = code
