// Counts what a process reads from files, for a check that wants to know how much
// the daemon read. A check loads it into the daemon it starts with `node --import`,
// and names the file to write the totals to in AGENTS_READ_METER. It is not part
// of the daemon, which knows nothing of it. The totals are the bytes read from each
// path, the biggest buffer any read was given, and the CPU time the process used.

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { z } from 'zod'

const file = process.env.AGENTS_READ_METER
if (file !== undefined) {
  const { openSync, readSync, closeSync, renameSync, writeFileSync } = fs
  const paths = new Map<number, string>()
  const totals = new Map<string, number>()
  let largest = 0

  Object.defineProperty(fs, 'openSync', {
    value: (path: fs.PathLike, ...rest: unknown[]) => {
      const fd = z.number().parse(Reflect.apply(openSync, fs, [path, ...rest]))
      paths.set(fd, String(path))
      return fd
    },
  })
  Object.defineProperty(fs, 'readSync', {
    value: (fd: number, buffer: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      const bytes = z.number().parse(Reflect.apply(readSync, fs, [fd, buffer, ...rest]))
      const path = paths.get(fd)
      if (path !== undefined) totals.set(path, (totals.get(path) ?? 0) + bytes)
      largest = Math.max(largest, buffer.byteLength)
      return bytes
    },
  })
  Object.defineProperty(fs, 'closeSync', {
    value: (fd: number) => {
      paths.delete(fd)
      closeSync(fd)
    },
  })
  // The daemon imports these by name, so its imports must see the wrappers.
  syncBuiltinESMExports()

  // Written beside the file and moved over it, so a check never reads half of one.
  const write = () => {
    const cpu = process.cpuUsage()
    writeFileSync(`${file}.next`, JSON.stringify({ reads: Object.fromEntries(totals), largest, cpuMs: Math.round((cpu.user + cpu.system) / 1000) }))
    renameSync(`${file}.next`, file)
  }
  setInterval(write, 200).unref()
  process.on('exit', write)
}
