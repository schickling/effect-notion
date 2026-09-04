import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname + '/fixtures',
  server: {
    headers: {
      /** Required for SharedWorker to work in some browsers */
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
})
