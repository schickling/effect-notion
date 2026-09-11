/**
 * Integration tests for text overflow and line truncation using VirtualTerminal.
 *
 * PROBLEM: "Soft Wrapping with Reflow Artifacts"
 * When text exceeds terminal width, terminals perform "soft wrapping" - automatically
 * continuing the text on the next row. During differential re-renders (e.g., spinner updates),
 * the renderer overwrites what it thinks is "1 line" but the wrapped content spans multiple
 * rows, leaving "ghost lines" - fragments of previous wrapped content.
 *
 * These tests reproduce:
 * - Text overflow beyond terminal width
 * - Soft wrapping causing multi-row content
 * - Reflow artifacts / ghost lines during updates
 * - Solutions: truncation, word wrap, overflow hidden
 */

import { describe, expect, it } from 'vitest'

import { InlineRenderer } from '@overeng/tui-core'

import { truncateLines } from '../../src/truncate.ts'
import { createVirtualTerminal } from '../helpers/mod.ts'

describe('Long Lines Handling (VirtualTerminal)', () => {
  describe('line wrapping behavior', () => {
    it('handles lines longer than terminal width', async () => {
      // Narrow terminal to trigger wrapping
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer({ terminal })

      const longLine = 'This is a very long line that exceeds the terminal width of 40 characters'

      renderer.render([longLine])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      // The long line should wrap or be truncated
      // Current behavior: wraps to multiple lines (this may be the bug)
      console.log('Rendered lines:', lines)
      console.log('Line count:', lines.length)

      renderer.dispose()
      terminal.dispose()
    })

    it('updates with long lines should not cause extra scrolling', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 10 })
      const renderer = new InlineRenderer({ terminal })

      const longServiceName = 'authentication-and-authorization-microservice-with-oauth2'
      const longMessage = `Waiting for health check endpoint GET /api/v1/health/ready to return 200 OK...`

      // First render - short content
      renderer.render(['Deploying 0/3 services', `  ○ ${longServiceName}`])
      await terminal.flush()

      const cursorBefore = terminal.getCursor()
      console.log('Cursor after first render:', cursorBefore)

      // Second render - add long status message
      renderer.render(['Deploying 1/3 services', `  ⠋ ${longServiceName} - ${longMessage}`])
      await terminal.flush()

      const cursorAfter = terminal.getCursor()
      console.log('Cursor after second render:', cursorAfter)

      const lines = terminal.getVisibleLines()
      console.log('Visible lines:', lines)

      // The cursor should not have jumped significantly due to wrapping
      // If long lines wrap, the cursor position will be wrong

      renderer.dispose()
      terminal.dispose()
    })

    it('progressive updates with long lines maintain correct line count', async () => {
      const cols = 50
      const terminal = createVirtualTerminal({ cols, rows: 15 })
      const renderer = new InlineRenderer({ terminal })

      const longNames = [
        'api-gateway-service-with-very-long-name',
        'authentication-microservice-oauth2-saml',
        'background-worker-processor-service',
      ]

      // Simulate progressive deployment updates
      const states = [
        // State 1: All pending
        [
          'Deploying 0/3 services',
          `  ○ ${longNames[0]}`,
          `  ○ ${longNames[1]}`,
          `  ○ ${longNames[2]}`,
        ],
        // State 2: First starting with long message
        [
          'Deploying 0/3 services',
          `  ⠋ ${longNames[0]} (pulling) - Pulling image from gcr.io/org/service:v1.2.3...`,
          `  ○ ${longNames[1]}`,
          `  ○ ${longNames[2]}`,
        ],
        // State 3: First healthy, second starting
        [
          'Deploying 1/3 services',
          `  ✓ ${longNames[0]}`,
          `  ⠋ ${longNames[1]} (healthcheck) - Waiting for /health endpoint...`,
          `  ○ ${longNames[2]}`,
        ],
        // State 4: Error with long message
        [
          'Deploying 1/3 services',
          `  ✓ ${longNames[0]}`,
          `  ✗ ${longNames[1]} - Error: Connection timeout after 30000ms to postgres.internal:5432`,
          `  ○ ${longNames[2]}`,
        ],
      ]

      for (let i = 0; i < states.length; i++) {
        // Pre-truncate lines (as createRoot would do)
        renderer.render(truncateLines({ lines: states[i]!, width: cols }))
        await terminal.flush()

        const lines = terminal.getVisibleLines()
        const cursor = terminal.getCursor()

        console.log(`\n=== State ${i + 1} ===`)
        console.log('Lines:', lines)
        console.log('Line count:', lines.length)
        console.log('Cursor:', cursor)

        // After truncation fix: each state should render exactly 4 lines
        // (no more soft wrapping / ghost lines)
        expect(lines.filter((l: string) => l.trim()).length).toBe(4)
      }

      renderer.dispose()
      terminal.dispose()
    })

    it('truncates lines to terminal width to prevent wrapping', async () => {
      const cols = 40
      const terminal = createVirtualTerminal({ cols, rows: 10 })
      const renderer = new InlineRenderer({ terminal })

      const longLine = 'This is a very long line that exceeds the terminal width of 40 characters'

      // Pre-truncate lines (as createRoot would do)
      renderer.render(truncateLines({ lines: [longLine], width: cols }))
      await terminal.flush()

      const lines = terminal.getVisibleLines()

      // Line should be truncated to 40 cols with ellipsis
      expect(lines.length).toBe(1)
      expect(lines[0]).toBe('This is a very long line that exceeds t…')
      expect(lines[0]!.length).toBeLessThanOrEqual(40)

      renderer.dispose()
      terminal.dispose()
    })

    it('truncated lines show ellipsis to indicate overflow', async () => {
      const cols = 50
      const terminal = createVirtualTerminal({ cols, rows: 10 })
      const renderer = new InlineRenderer({ terminal })

      // Pre-truncate lines (as createRoot would do)
      renderer.render(
        truncateLines({
          lines: ['This is a very long line that definitely exceeds fifty characters in width'],
          width: cols,
        }),
      )
      await terminal.flush()

      const lines = terminal.getVisibleLines()

      // Should end with ellipsis character
      expect(lines[0]).toMatch(/…$/)

      renderer.dispose()
      terminal.dispose()
    })
  })

  describe('static region with long lines', () => {
    it('long log messages should not affect dynamic region', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 15 })
      const renderer = new InlineRenderer({ terminal })

      // Add long static log message
      const longLog =
        '[10:15:30] [INFO] Starting deployment to production-us-east-1-kubernetes-cluster with rolling update strategy'
      renderer.appendStatic([longLog])

      // Render dynamic content
      renderer.render(['Progress: 50%', 'Services: 2/4 healthy'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      console.log('Lines with long static:', lines)

      // Verify dynamic content is still in correct position
      // (not pushed down by wrapped static content)

      renderer.dispose()
      terminal.dispose()
    })
  })
})
