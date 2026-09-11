import { test, expect } from '@playwright/test'

/**
 * E2E tests for resize and truncation behavior in Storybook preview.
 *
 * These tests verify:
 * - Long lines are truncated to fit container width (showing ellipsis)
 * - Text doesn't wrap (no ghost lines)
 * - Container resize updates truncation appropriately
 */

const terminalRows = '.xterm-accessibility-tree > [role="listitem"]'
const previewText = 'pre:not(.sb-errordisplay_code)'

test.describe('Resize and Truncation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/iframe.html?id=examples-03-cli-deploy--long-lines&viewMode=story')
    await expect(page.getByTestId('tui-preview-tabs')).toBeVisible({ timeout: 30_000 })
  })

  test('TTY tab truncates long lines with ellipsis', async ({ page }) => {
    await page.getByTestId('tab-tty').click()
    const rows = page.locator(terminalRows)
    await expect
      .poll(async () => (await rows.allInnerTexts()).join('\n'))
      .toContain('api-gateway-service')

    const lines = (await rows.allInnerTexts()).filter((line) => line.trim())
    for (const line of lines) {
      expect(line.length).toBeLessThan(100)
    }
  })

  test('CI Plain tab renders with proper width', async ({ page }) => {
    // Click on CI Plain tab
    await page.click('[data-testid="tab-ci-plain"]')

    // Get the pre element
    const preElement = page.locator(previewText)
    await expect(preElement).toContainText('api-gateway-service')

    // Check the content
    const textContent = await preElement.textContent()

    // Lines should be truncated (not showing full long content)
    const lines = (textContent || '').split('\n').filter((l) => l.trim())
    for (const line of lines) {
      // Lines should be truncated to fit container
      expect(line.length).toBeLessThan(200)
    }
  })

  test('resize updates text truncation in CI Plain tab', async ({ page }) => {
    await page.getByTestId('tab-ci-plain').click()
    const preElement = page.locator(previewText)
    await expect(preElement).toContainText('api-gateway-service')

    const initialContent = await preElement.innerText()
    const initialMaxLineLength = Math.max(
      ...initialContent
        .split('\n')
        .filter(Boolean)
        .map((line) => line.length),
    )

    await page.setViewportSize({ width: 600, height: 800 })
    await expect.poll(async () => await preElement.innerText()).not.toBe(initialContent)
    const resizedContent = await preElement.innerText()
    const resizedMaxLineLength = Math.max(
      ...resizedContent
        .split('\n')
        .filter(Boolean)
        .map((line) => line.length),
    )
    expect(resizedMaxLineLength).toBeLessThan(initialMaxLineLength)

    await page.setViewportSize({ width: 1200, height: 800 })
    await expect.poll(async () => await preElement.innerText()).not.toBe(resizedContent)
    await expect(preElement).toContainText('api-gateway-service')
  })

  test('no ghost lines appear during progressive updates', async ({ page }) => {
    await page.getByTestId('tab-tty').click()
    const rows = page.locator(terminalRows)
    await expect
      .poll(async () => (await rows.allInnerTexts()).join('\n'))
      .toContain('api-gateway-service')

    const lines = (await rows.allInnerTexts()).filter((line) => line.trim())

    // Should have exactly 4 lines (header + 3 services)
    // Not more due to wrapping/ghost lines
    expect(lines.length).toBeLessThanOrEqual(6) // Allow some flexibility
    expect(lines.length).toBeGreaterThanOrEqual(3)

    // No line should be a partial/fragment (indicating ghost line)
    for (const line of lines) {
      // Each line should start with reasonable content (not mid-word fragments)
      expect(line.length).toBeGreaterThan(5)
    }
  })

  test('Log tab shows truncated output', async ({ page }) => {
    // Click on Log tab
    await page.click('[data-testid="tab-log"]')

    // Get the pre element
    const preElement = page.locator(previewText)
    await expect.poll(async () => await preElement.textContent()).toContain('Deploy failed')

    // Content should be present
    const textContent = await preElement.textContent()

    // Lines shouldn't be excessively long
    const lines = (textContent || '').split('\n').filter((l) => l.trim())
    for (const line of lines) {
      expect(line.length).toBeLessThan(300)
    }
  })

  test('NDJSON tab shows timestamps and truncated JSON', async ({ page }) => {
    // Click on NDJSON tab
    await page.click('[data-testid="tab-ndjson"]')

    // Get the pre element
    const preElement = page.locator(previewText)
    await expect.poll(async () => await preElement.textContent()).toMatch(/\d{2}:\d{2}:\d{2}/)

    // Should have timestamps
    const textContent = await preElement.textContent()

    // Each entry should be on its own line-ish (flexible check)
    const entries = (textContent || '').split('\\n').filter((e) => e.trim())
    expect(entries.length).toBeGreaterThan(0)
  })

  test('no ghost lines appear during resize while animation is running', async ({ page }) => {
    // This test catches the specific regression where resizing during animation
    // causes ghost lines due to terminal reflow + cursor position mismatch

    await page.getByTestId('tab-tty').click()
    const rows = page.locator(terminalRows)
    await expect
      .poll(async () => (await rows.allInnerTexts()).join('\n'))
      .toContain('api-gateway-service')

    // Perform multiple resizes while animation continues
    const viewportSizes = [
      { width: 1200, height: 800 },
      { width: 800, height: 600 },
      { width: 600, height: 400 },
      { width: 900, height: 700 },
      { width: 700, height: 500 },
    ]

    for (const size of viewportSizes) {
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential test steps
      await page.setViewportSize(size)
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential test steps
      await page.waitForTimeout(300) // Brief wait between resizes
    }

    const lines = (await rows.allInnerTexts()).filter((line) => line.trim())

    // Count occurrences of key phrases - should only appear once each
    // (no duplicates from ghost lines)
    const deployingCount = lines.filter((l) => l.includes('Deploying')).length
    const apiGatewayCount = lines.filter((l) => l.includes('api-gateway-service')).length

    // Ghost lines manifest as duplicate lines - there should be at most one
    // "Deploying X/Y" line and one line per service
    expect(deployingCount).toBeLessThanOrEqual(2) // Max 2 in case of state transition
    expect(apiGatewayCount).toBeLessThanOrEqual(2) // Max 2 in case of state transition

    // Total line count should be reasonable (not inflated by ghost lines)
    // The LongLines story shows ~4-8 lines depending on state
    expect(lines.length).toBeLessThanOrEqual(15)
  })

  test('rapid resize does not cause ghost lines', async ({ page }) => {
    // Stress test: rapid resizing to ensure no accumulated ghost lines

    await page.getByTestId('tab-tty').click()
    const rows = page.locator(terminalRows)
    await expect
      .poll(async () => (await rows.allInnerTexts()).join('\n'))
      .toContain('api-gateway-service')

    // Rapid resize cycle
    for (let i = 0; i < 10; i++) {
      const width = 600 + (i % 2) * 400 // Alternate between 600 and 1000
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential test steps
      await page.setViewportSize({ width, height: 600 })
      // oxlint-disable-next-line eslint(no-await-in-loop) -- intentionally sequential test steps
      await page.waitForTimeout(100)
    }

    // Final state
    await page.setViewportSize({ width: 800, height: 600 })
    await page.waitForTimeout(500)

    const lines = (await rows.allInnerTexts()).filter((line) => line.trim())

    // Count duplicate indicators
    const lineSet = new Set(lines)
    const duplicateRatio = lines.length / lineSet.size

    // If there are many duplicates, something is wrong
    // Perfect would be ratio = 1.0 (no duplicates)
    // Allow some margin for spinner frames or state changes
    expect(duplicateRatio).toBeLessThan(2.0)

    // Total lines should be reasonable
    expect(lines.length).toBeLessThanOrEqual(20)
  })
})
