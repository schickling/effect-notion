import { test, expect } from '@playwright/test'

const deployStoryUrl = '/iframe.html?id=examples-03-cli-deploy--demo&viewMode=story'
const tabs = ['tty', 'alt-screen', 'ci', 'ci-plain', 'log', 'json', 'ndjson'] as const

test.describe('TuiStoryPreview Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(deployStoryUrl)
    await expect(page.getByTestId('tui-preview-tabs')).toBeVisible({ timeout: 30_000 })
  })

  test('renders every output mode tab', async ({ page }) => {
    for (const tab of tabs) {
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential assertions
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible()
    }
  })

  test('TTY tab is active by default', async ({ page }) => {
    await expect(page.getByTestId('tab-tty')).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
  })

  test('can switch to alternate-screen rendering', async ({ page }) => {
    const alternateScreenTab = page.getByTestId('tab-alt-screen')
    await alternateScreenTab.click()
    await expect(alternateScreenTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
    await expect(page.getByTestId('tab-tty')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)')
  })

  test('can switch to CI tab', async ({ page }) => {
    const ciTab = page.getByTestId('tab-ci')
    await ciTab.click()

    await expect(ciTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
  })

  test('can switch to Log tab', async ({ page }) => {
    const logTab = page.getByTestId('tab-log')
    await logTab.click()

    await expect(logTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
  })

  test('can switch to JSON tab and see formatted JSON', async ({ page }) => {
    const jsonTab = page.getByTestId('tab-json')
    await jsonTab.click()

    await expect(jsonTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')

    // JSON tab should display a <pre> element with JSON content (inside #storybook-root)
    const preElement = page.locator('#storybook-root pre')
    await expect(preElement).toBeVisible()

    // Should contain JSON-like content (opening brace or bracket)
    const content = await preElement.textContent()
    expect(content).toMatch(/[{[]/)
  })

  test('can switch to NDJSON tab', async ({ page }) => {
    const ndjsonTab = page.getByTestId('tab-ndjson')
    await ndjsonTab.click()

    await expect(ndjsonTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
  })

  test('tabs cycle through all modes correctly', async ({ page }) => {
    for (const activeTab of tabs) {
      const tab = page.getByTestId(`tab-${activeTab}`)
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential interaction
      await tab.click()
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential assertion
      await expect(tab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')

      for (const inactiveTab of tabs) {
        if (inactiveTab !== activeTab) {
          // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential assertion
          await expect(page.getByTestId(`tab-${inactiveTab}`)).toHaveCSS(
            'border-bottom-color',
            'rgba(0, 0, 0, 0)',
          )
        }
      }
    }
  })
})

test.describe('TuiStoryPreview Timeline Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(deployStoryUrl)
    await expect(page.getByTestId('tui-preview-tabs')).toBeVisible({ timeout: 30_000 })
  })

  test('has playback controls when timeline is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /play|pause/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /reset/i })).toBeVisible()
    await expect(page.locator('input[type="range"]')).toBeVisible()
  })

  test('can pause and resume playback', async ({ page }) => {
    const pauseButton = page.getByRole('button', { name: 'Pause' })
    await expect(pauseButton).toBeVisible()
    await pauseButton.click()
    const playButton = page.getByRole('button', { name: 'Play' })
    await expect(playButton).toBeVisible()
    await playButton.click()
    await expect(pauseButton).toBeVisible()
  })

  test('reset button returns to initial state and pauses', async ({ page }) => {
    const slider = page.locator('input[type="range"]')
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(slider).toHaveValue('0')
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  })
})
