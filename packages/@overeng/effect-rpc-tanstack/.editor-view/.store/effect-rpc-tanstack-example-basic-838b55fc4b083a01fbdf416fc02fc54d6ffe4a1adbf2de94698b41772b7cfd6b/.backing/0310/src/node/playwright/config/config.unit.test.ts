import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { createPlaywrightConfig } from './mod.ts'

Vitest.describe('createPlaywrightConfig', () => {
  Vitest.it('passes web server environment variables to Playwright', async () => {
    const config = await createPlaywrightConfig({
      testDir: './tests',
      webServer: {
        command: 'vite --port {{port}}',
        env: {
          CATALOG_API_URL: 'http://127.0.0.1:43210',
          DEVENV_TASK_PASSTHROUGH: '1',
        },
      },
    })

    expect(config.webServer).toMatchObject({
      env: {
        CATALOG_API_URL: 'http://127.0.0.1:43210',
        DEVENV_TASK_PASSTHROUGH: '1',
      },
    })
  })
})
