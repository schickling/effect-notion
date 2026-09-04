/**
 * Integration tests for BroadcastLogger using Playwright.
 *
 * Tests the full SharedWorker → Tab log bridging flow in a real browser environment
 * with actual Effect code running in the worker.
 */
import { expect, test } from '@playwright/test'

test.describe('BroadcastLogger integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-page.html')
    await expect(page.locator('#status')).toHaveText('Worker ready')
  })

  test('broadcasts log entries from SharedWorker to tab via BroadcastChannel', async ({ page }) => {
    // Tell worker to emit logs
    await page.evaluate(() => {
      window.workerPort?.postMessage({ type: 'emit-logs', count: 3 })
    })

    // Wait for worker to finish
    await expect(page.locator('#status')).toHaveText('Worker done', {
      timeout: 5000,
    })

    await expect
      .poll(async () => page.evaluate(() => window.receivedLogs.length), {
        timeout: 5000,
      })
      .toBe(3)

    // Check received logs
    const logs = await page.evaluate(() => window.receivedLogs)

    expect(logs).toHaveLength(3)
    expect(logs[0]!.level).toBe('INFO')
    expect(logs[0]!.message).toContain('Test message 1')
    expect(logs[0]!.source).toBe('test-worker')
    expect(logs[1]!.message).toContain('Test message 2')
    expect(logs[2]!.message).toContain('Test message 3')
  })

  test('includes span information in log entries', async ({ page }) => {
    // Tell worker to emit log with span
    await page.evaluate(() => {
      window.workerPort?.postMessage({ type: 'emit-with-span' })
    })

    await expect(page.locator('#status')).toHaveText('Worker done', {
      timeout: 5000,
    })

    await expect
      .poll(async () => page.evaluate(() => window.receivedLogs.length), {
        timeout: 5000,
      })
      .toBe(1)

    const logs = await page.evaluate(() => window.receivedLogs)

    expect(logs).toHaveLength(1)
    expect(logs[0]!.message).toContain('Inside span')
    expect(logs[0]!.spans).toContain('test-span')
  })

  test('handles error logs with annotations', async ({ page }) => {
    // Tell worker to emit error log
    await page.evaluate(() => {
      window.workerPort?.postMessage({ type: 'emit-error' })
    })

    await expect(page.locator('#status')).toHaveText('Worker done', {
      timeout: 5000,
    })

    await expect
      .poll(async () => page.evaluate(() => window.receivedLogs.length), {
        timeout: 5000,
      })
      .toBe(1)

    const logs = await page.evaluate(() => window.receivedLogs)

    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('ERROR')
    expect(logs[0]!.message).toContain('Something went wrong')
  })
})
