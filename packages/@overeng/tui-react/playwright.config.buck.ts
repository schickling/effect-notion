import { fileURLToPath } from 'node:url'

import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './e2e',
  webServer: {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command: `${process.execPath} node_modules/storybook/dist/bin/dispatcher.js dev --port {{port}} --no-open`,
    timeout: 120_000,
  },
})
