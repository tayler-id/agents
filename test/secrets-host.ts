// Builds an agent's secrets as a page of their own, beside the app in app/dist, since nothing in the app
// mounts them yet. The agent panel's Secrets card will. The page runs under the app's own policy with its
// own styles and its zod setting, so what a check or a person sees is what the app would show. Open it at
// /secrets-host/index.html#agent=<the agent's id> on any API that serves app/dist.
//   node test/secrets-host.ts     builds it, for an instance that agentsctl started

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './onboarding-kit.ts'

// The files the page is built from. They are made here and not kept, so the build reads the app's own
// index.html and its policy.
export const HOST = join(ROOT, '.scratch', 'secrets-host')
const BUILT = join(ROOT, 'app', 'dist', 'secrets-host')

// What it runs, with the app's zod setting first, as the app's own entry has it, and the app's styles.
const ENTRY = `import '../../app/src/zod-config.ts'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentSecrets } from '../../app/src/Secrets.tsx'
import '../../app/src/styles.css'
import './host.css'
const agentId = new URLSearchParams(location.hash.slice(1)).get('agent') ?? ''
createRoot(document.getElementById('root')).render(createElement(AgentSecrets, { agentId }))
`
const HOST_CSS = '#root { height: auto; min-height: 100%; max-width: 720px; padding: 16px; }\n'
const CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: ${JSON.stringify(HOST)},
  base: '/secrets-host/',
  plugins: [react()],
  build: { outDir: ${JSON.stringify(BUILT)}, emptyOutDir: true, rolldownOptions: { output: { strictExecutionOrder: true } } },
})
`

export function buildHost() {
  rmSync(HOST, { recursive: true, force: true })
  mkdirSync(HOST, { recursive: true })
  const index = readFileSync(join(ROOT, 'app', 'index.html'), 'utf8')
  const page = index.replace('<script type="module" src="/src/main.tsx"></script>', '<script type="module" src="./entry.jsx"></script>')
  if (page === index) throw new Error("the app's index.html no longer loads /src/main.tsx the way this builder expects")
  writeFileSync(join(HOST, 'index.html'), page)
  writeFileSync(join(HOST, 'entry.jsx'), ENTRY)
  writeFileSync(join(HOST, 'host.css'), HOST_CSS)
  writeFileSync(join(HOST, 'vite.config.ts'), CONFIG)
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', join(HOST, 'vite.config.ts'), '--logLevel', 'error'], { cwd: ROOT })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHost()
  console.log(`built ${BUILT}`)
}
