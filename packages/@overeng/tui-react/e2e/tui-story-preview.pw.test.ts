import { test, expect } from '@playwright/test'

/**
 * Tests for TuiStoryPreview component tabs functionality
 *
 * These tests verify that:
 * 1. All 6 output tabs are rendered and clickable
 * 2. Tab switching works correctly
 * 3. Each tab displays appropriate content
 */

// Story URL for DeployView which uses TuiStoryPreview with all tabs
const DEPLOY_STORY_URL = '/iframe.html?id=examples-03-cli-deploy--demo&viewMode=story'

test.describe('TuiStoryPreview Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DEPLOY_STORY_URL)
    // Wait for the story to load
    await page.waitForSelector('[data-testid="tui-preview-tabs"]', { timeout: 30000 })
  })

  test('renders all 6 output mode tabs', async ({ page }) => {
    // Verify all tabs are present
    await expect(page.getByTestId('tab-visual')).toBeVisible()
    await expect(page.getByTestId('tab-fullscreen')).toBeVisible()
    await expect(page.getByTestId('tab-ci')).toBeVisible()
    await expect(page.getByTestId('tab-log')).toBeVisible()
    await expect(page.getByTestId('tab-json')).toBeVisible()
    await expect(page.getByTestId('tab-ndjson')).toBeVisible()
  })

  test('visual tab is active by default', async ({ page }) => {
    const visualTab = page.getByTestId('tab-visual')
    // Check for active state styling (border-bottom color)
    await expect(visualTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')
  })

  test('can switch to fullscreen tab', async ({ page }) => {
    const fullscreenTab = page.getByTestId('tab-fullscreen')
    await fullscreenTab.click()

    // Fullscreen tab should now be active
    await expect(fullscreenTab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')

    // Visual tab should no longer be active
    const visualTab = page.getByTestId('tab-visual')
    await expect(visualTab).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)')
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
    const tabs = ['visual', 'fullscreen', 'ci', 'log', 'json', 'ndjson'] as const

    for (const tabName of tabs) {
      const tab = page.getByTestId(`tab-${tabName}`)
      await tab.click()

      // Verify tab is now active
      await expect(tab).toHaveCSS('border-bottom-color', 'rgb(0, 122, 204)')

      // Verify other tabs are inactive
      for (const otherTab of tabs) {
        if (otherTab !== tabName) {
          await expect(page.getByTestId(`tab-${otherTab}`)).toHaveCSS(
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
    await page.goto(DEPLOY_STORY_URL)
    await page.waitForSelector('[data-testid="tui-preview-tabs"]', { timeout: 30000 })
  })

  test('has playback controls when timeline is present', async ({ page }) => {
    // Look for play/pause button
    const playButton = page.getByRole('button', { name: /play|pause/i })
    await expect(playButton).toBeVisible()

    // Look for reset button
    const resetButton = page.getByRole('button', { name: /reset/i })
    await expect(resetButton).toBeVisible()

    // Look for timeline slider
    const slider = page.locator('input[type="range"]')
    await expect(slider).toBeVisible()
  })

  test('can pause and resume playback', async ({ page }) => {
    // Find the play/pause button
    const playPauseButton = page.getByRole('button', { name: /pause/i })

    // If auto-playing, should show Pause
    if ((await playPauseButton.isVisible()) === true) {
      await playPauseButton.click()
      // After clicking, should show Play
      await expect(page.getByRole('button', { name: /play/i })).toBeVisible()
    }
  })

  test('reset button returns to initial state', async ({ page }) => {
    // Wait a bit for timeline to progress
    await page.waitForTimeout(500)

    // Click reset
    const resetButton = page.getByRole('button', { name: /reset/i })
    await resetButton.click()

    // Timeline should reset to 0 - look for the time display format "0.0s / X.Xs"
    const timeDisplay = page.locator('span:has-text("0.0s /")').first()
    await expect(timeDisplay).toBeVisible()
  })
})
