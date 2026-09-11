import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './src/browser/__tests__',
  webServer: {
    command:
      'pnpm exec vite --config src/browser/__tests__/vite.config.ts --host 127.0.0.1 --port {{port}}',
  },
})
