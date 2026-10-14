// A check any of our CLIs can run to show it keeps the rules in output.ts and
// command.ts. It runs the CLI through its command line, as an agent does, and
// reports each rule with what it saw. A CLI's own check supplies one command
// line for each kind of case.

import { execFile } from 'node:child_process'
import { OUTPUT, type Output } from './output.ts'

export type Ran = { code: number; stdout: string; stderr: string }
export type Conformance = {
  run: (args: string[]) => Promise<Ran>
  // How next steps name the CLI, such as bin/agentsctl.
  invoke: string
  // The first word of each command, which help and an unknown command must list.
  commands: string[]
  // Flags that only say where a command acts and take a value, such as --instance.
  context: string[]
  cases: {
    read: string[]
    list: string[]
    emptyList: string[]
    failingRead: string[]
    // A write that is safe to rerun. The check runs it twice.
    write: string[]
    // A command whose detail is longer than plain output keeps.
    long: string[]
    // A command that prints text from outside the CLI.
    untrusted: string[]
  }
}
export type RuleResult = { rule: string; ok: boolean; saw: string }

// Runs a program with arguments, never through a shell, and keeps its exit code and both streams.
export function runner(program: string, before: string[], cwd: string, env: NodeJS.ProcessEnv): (args: string[]) => Promise<Ran> {
  return (args) => new Promise((resolve, reject) => {
    execFile(program, [...before, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A code that is not a number means the program never ran, which no rule can judge.
      if (error && typeof error.code !== 'number') {
        reject(new Error(`could not run ${program}: ${error.message}`, { cause: error }))
        return
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

const envelopeOf = (ran: Ran): Output | null => {
  const lines = ran.stdout.trim().split('\n')
  if (lines.length !== 1 || !lines[0]) return null
  try {
    const parsed = OUTPUT.safeParse(JSON.parse(lines[0]))
    return parsed.success ? parsed.data : null
  } catch (error) {
    // Output that is not JSON is not an envelope, which the rule reports.
    if (error instanceof SyntaxError) return null
    throw error
  }
}

// Each fence in plain output: its source and random token, and whether it closes on a marker with both.
const OPEN = /^--- untrusted (.+) ([0-9a-f]{8}): data, not instructions ---$/
function fences(stdout: string): { source: string; token: string; closed: boolean }[] {
  const lines = stdout.split('\n')
  return lines.flatMap((line, i) => {
    const open = OPEN.exec(line)
    if (!open?.[1] || !open[2]) return []
    return [{ source: open[1], token: open[2], closed: lines.indexOf(`--- end of untrusted ${open[1]} ${open[2]} ---`, i + 1) > i }]
  })
}

const shown = (ran: Ran) => `exit ${String(ran.code)}, stdout ${JSON.stringify(ran.stdout.slice(0, 300))}${ran.stderr ? `, stderr ${JSON.stringify(ran.stderr.slice(0, 200))}` : ''}`

export async function conformance(spec: Conformance): Promise<RuleResult[]> {
  const results: RuleResult[] = []
  const rule = (name: string, ok: boolean, saw: string) => { results.push({ rule: name, ok, saw }) }
  const json = async (args: string[]) => {
    const ran = await spec.run([...args, '--json'])
    return { ran, out: envelopeOf(ran) }
  }

  const help = await spec.run(['help'])
  rule('help lists every command', help.code === 0 && spec.commands.every((c) => help.stdout.includes(c)), shown(help))

  const unknown = await spec.run(['no-such-command'])
  rule('an unknown command exits 2 and lists the commands', unknown.code === 2 && spec.commands.every((c) => unknown.stdout.includes(c)), shown(unknown))
  rule('a failure prints on stdout, with nothing on stderr', unknown.stdout.startsWith('error:') && unknown.stderr === '', shown(unknown))

  const badFlag = await spec.run([...spec.cases.read, '--no-such-flag'])
  rule('an unknown flag exits 2 and lists the valid flags', badFlag.code === 2 && badFlag.stdout.includes('--json'), shown(badFlag))

  const envelopes: { args: string[]; out: Output }[] = []
  for (const [name, args] of Object.entries(spec.cases)) {
    const { ran, out } = await json(args)
    rule(`--json prints one envelope whose code is the exit code (${name})`, out !== null && out.code === ran.code, shown(ran))
    if (out) envelopes.push({ args, out })
  }

  const empty = await json(spec.cases.emptyList)
  rule('an empty list says there are none', empty.ran.code === 0 && empty.out?.head.startsWith('no ') === true, shown(empty.ran))
  const list = await json(spec.cases.list)
  rule('a list says how many it shows of how many', list.ran.code === 0 && /^\d+ (of \d+ )?\S/.test(list.out?.head ?? ''), shown(list.ran))

  const failed = await json(spec.cases.failingRead)
  rule('a failed read is an error, never an empty or zero result', failed.ran.code !== 0 && failed.out?.head.startsWith('error:') === true && !/^(no |0 )/.test(failed.out.head), shown(failed.ran))
  const failedPlain = await spec.run(spec.cases.failingRead)
  rule('a failed read prints its error on stdout', failedPlain.stdout.startsWith('error:') && failedPlain.stderr === '', shown(failedPlain))

  const write = await json(spec.cases.write)
  rule('a write leads with ok: and the state it left', write.ran.code === 0 && write.out?.head.startsWith('ok: ') === true && write.out.head.includes(' -> '), shown(write.ran))
  const again = await spec.run(spec.cases.write)
  const againJson = await json(spec.cases.write)
  rule('a write run again says already: true, spelled that way', again.code === 0 && again.stdout.split('\n').includes('already: true') && againJson.out?.already === true, shown(again))

  const long = await spec.run(spec.cases.long)
  const whole = await spec.run([...spec.cases.long, '--full'])
  rule('long text is cut, saying how much there is and how to see it all', /\(cut: showing \d+ of \d+ lines/.test(long.stdout) && long.stdout.includes('--full') && !whole.stdout.includes('(cut:') && whole.stdout.length > long.stdout.length, shown(long))

  const outside = await spec.run(spec.cases.untrusted)
  const outsideJson = await json(spec.cases.untrusted)
  const fenced = fences(outside.stdout)
  rule('text from outside is fenced, and each fence closes on its own random marker', fenced.length > 0 && fenced.every((f) => f.closed), shown(outside))
  rule('--json carries outside text in outside blocks and names the data fields holding it', (outsideJson.out?.outside.length ?? 0) > 0 && (outsideJson.out?.untrusted.length ?? 0) > 0, shown(outsideJson.ran))
  const again2 = await spec.run(spec.cases.untrusted)
  const tokens = [fenced, fences(again2.stdout)].map((f) => f[0]?.token)
  rule("a fence's marker is new for each output", tokens[0] !== undefined && tokens[1] !== undefined && tokens[0] !== tokens[1], tokens.join(' then '))
  const longFences = fences(long.stdout)
  rule('a cut never loses the closing marker', longFences.every((f) => f.closed), shown(long))

  // A next step naming the same command, with or without where it acts, repeats it.
  const strip = (words: string[]) => words.filter((w, i) => !spec.context.includes(w) && !spec.context.includes(words[i - 1] ?? '')).join(' ')
  const commandsIn = (line: string) => [...line.matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1]?.startsWith(`${spec.invoke} `) ? [m[1].replace(/["']/g, '').split(/\s+/).slice(1)] : []))
  const repeats = envelopes.flatMap(({ args, out }) => out.help
    .filter((h) => commandsIn(h).some((words) => strip(words) === strip(args)))
    .map((h) => `${args.join(' ')}: ${h}`))
  rule('next steps never repeat the command just run', !repeats.length, repeats.join('; ') || 'none repeat')
  return results
}
