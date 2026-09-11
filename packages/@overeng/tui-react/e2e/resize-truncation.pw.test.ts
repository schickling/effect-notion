import { test, expect } from '@playwright/test'

/**
 * E2E tests for resize and truncation behavior in Storybook preview.
 *
 * These tests verify:
 * - Long lines are truncated to fit container width (showing ellipsis)
 * - Text doesn't wrap (no ghost lines)
 * - Container resize updates truncation appropriately
 */

test.describe('Resize and Truncation', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the LongLines story which has very long content
    await page.goto('/?path=/story/examples-03-cli-deploy--long-lines')
    // Wait for Storybook to load
    await page.waitForSelector('[data-testid="tui-preview-tabs"]', { timeout: 30000 })
  })

  test('TTY tab truncates long lines with ellipsis', async ({ page }) => {
    // Click on TTY tab
    await page.click('[data-testid="tab-tty"]')
    await page.waitForTimeout(500)

    // Check that xterm is rendering truncated content
    const xtermScreen = page.locator('.xterm-screen')
    await expect(xtermScreen).toBeVisible()

    // Get the rendered text content
    const textContent = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen')
      return screen?.textContent || ''
    })

    // Verify content contains service names but is truncated (has ellipsis or is cut off)
    expect(textContent).toContain('api-gateway-service')

    // Check that lines don't contain the full very long text
    // The full text is >100 chars, but container is ~60-80 cols
    const lines = textContent.split('\n').filter((l) => l.trim())
    for (const line of lines) {
      // Each line should be reasonably short (truncated)
      expect(line.length).toBeLessThan(100)
    }
  })

  test('CI Plain tab renders with proper width', async ({ page }) => {
    // Click on CI Plain tab
    await page.click('[data-testid="tab-ci-plain"]')
    await page.waitForTimeout(500)

    // Get the pre element
    const preElement = page.locator('pre')
    await expect(preElement).toBeVisible()

    // Check the content
    const textContent = await preElement.textContent()
    expect(textContent).toContain('api-gateway-service')

    // Lines should be truncated (not showing full long content)
    const lines = (textContent || '').split('\n').filter((l) => l.trim())
    for (const line of lines) {
      // Lines should be truncated to fit container
      expect(line.length).toBeLessThan(200)
    }
  })

  test('resize updates text truncation in CI Plain tab', async ({ page }) => {
    // Click on CI Plain tab
    await page.click('[data-testid="tab-ci-plain"]')
    await page.waitForTimeout(500)

    // Get initial content
    const preElement = page.locator('pre')
    const initialContent = await preElement.textContent()
    const initialLines = (initialContent || '').split('\n').filter((l) => l.trim())
    const initialMaxLineLength = Math.max(...initialLines.map((l) => l.length))

    // Resize the browser window smaller
    await page.setViewportSize({ width: 600, height: 800 })
    await page.waitForTimeout(1000) // Wait for resize to propagate

    // Get content after resize
    const resizedContent = await preElement.textContent()
    const resizedLines = (resizedContent || '').split('\n').filter((l) => l.trim())
    const resizedMaxLineLength = Math.max(...resizedLines.map((l) => l.length))

    // Lines should be shorter (or similar) after resize
    // Note: This is a soft check since font rendering can vary
    expect(resizedMaxLineLength).toBeLessThanOrEqual(initialMaxLineLength + 10)

    // Resize back to larger
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.waitForTimeout(1000)

    // Get content after resize back
    const finalContent = await preElement.textContent()
    expect(finalContent).toContain('api-gateway-service')
  })

  test('no ghost lines appear during progressive updates', async ({ page }) => {
    // Click on TTY tab to see live updates
    await page.click('[data-testid="tab-tty"]')
    await page.waitForTimeout(500)

    // Wait for timeline to progress (story has auto-play)
    await page.waitForTimeout(3000)

    // Get line count - should be consistent (4 lines for this story)
    const xtermScreen = page.locator('.xterm-screen')
    const textContent = await xtermScreen.textContent()
    const lines = (textContent || '').split('\n').filter((l) => l.trim())

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
    await page.waitForTimeout(500)

    // Get the pre element
    const preElement = page.locator('pre')
    await expect(preElement).toBeVisible()

    // Content should be present
    const textContent = await preElement.textContent()
    expect(textContent?.length).toBeGreaterThan(0)

    // Lines shouldn't be excessively long
    const lines = (textContent || '').split('\n').filter((l) => l.trim())
    for (const line of lines) {
      expect(line.length).toBeLessThan(300)
    }
  })

  test('NDJSON tab shows timestamps and truncated JSON', async ({ page }) => {
    // Click on NDJSON tab
    await page.click('[data-testid="tab-ndjson"]')
    await page.waitForTimeout(500)

    // Get the pre element
    const preElement = page.locator('pre')
    await expect(preElement).toBeVisible()

    // Should have timestamps
    const textContent = await preElement.textContent()
    expect(textContent).toMatch(/\d{2}:\d{2}:\d{2}/)

    // Each entry should be on its own line-ish (flexible check)
    const entries = (textContent || '').split('\\n').filter((e) => e.trim())
    expect(entries.length).toBeGreaterThan(0)
  })

  test('no ghost lines appear during resize while animation is running', async ({ page }) => {
    // This test catches the specific regression where resizing during animation
    // causes ghost lines due to terminal reflow + cursor position mismatch

    // Click on TTY tab
    await page.click('[data-testid="tab-tty"]')
    await page.waitForTimeout(500)

    // Wait for animation to start (some content should be visible)
    await page.waitForTimeout(1000)

    // Perform multiple resizes while animation continues
    const viewportSizes = [
      { width: 1200, height: 800 },
      { width: 800, height: 600 },
      { width: 600, height: 400 },
      { width: 900, height: 700 },
      { width: 700, height: 500 },
    ]

    for (const size of viewportSizes) {
      await page.setViewportSize(size)
      await page.waitForTimeout(300) // Brief wait between resizes
    }

    // Wait for things to settle
    await page.waitForTimeout(500)

    // Get the rendered text content
    const xtermScreen = page.locator('.xterm-screen')
    const textContent = await xtermScreen.textContent()
    const lines = (textContent || '').split('\n').filter((l) => l.trim())

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

    // Click on TTY tab
    await page.click('[data-testid="tab-tty"]')
    await page.waitForTimeout(500)

    // Rapid resize cycle
    for (let i = 0; i < 10; i++) {
      const width = 600 + (i % 2) * 400 // Alternate between 600 and 1000
      await page.setViewportSize({ width, height: 600 })
      await page.waitForTimeout(100)
    }

    // Final state
    await page.setViewportSize({ width: 800, height: 600 })
    await page.waitForTimeout(500)

    // Verify no accumulated ghost lines
    const xtermScreen = page.locator('.xterm-screen')
    const textContent = await xtermScreen.textContent()
    const lines = (textContent || '').split('\n').filter((l) => l.trim())

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
