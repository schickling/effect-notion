import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  webServer: {
    command: `${process.execPath} node_modules/vite/bin/vite.js --port {{port}}`,
  },
})
