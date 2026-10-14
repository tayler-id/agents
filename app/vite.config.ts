import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The lazy Screen view makes the bundler move modules both halves use into a chunk that runs before
    // the entry chunk. zod-config.ts, which main.tsx imports first, then ran after schemas built in that
    // chunk, and each one probed for eval, which Firefox logs as a policy error. This keeps source order.
    rolldownOptions: { output: { strictExecutionOrder: true } },
  },
})
