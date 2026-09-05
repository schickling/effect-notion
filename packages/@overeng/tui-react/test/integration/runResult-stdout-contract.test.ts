/**
 * Subprocess-level integration tests for the `runResult` stdout/stderr contract.
 *
 * The regressions this locks down (schickling/dotfiles#730, effect-utils#542)
 * only reproduce at the kernel fd boundary — a real child process, real stdio
 * inheritance, real `fstatSync` on fd 1. Unit tests with mocked output streams
 * cannot catch them.
 *
 * Two fd shapes exercised:
 *   - `execFile`: socketpair stdout (what `child_process.spawn` uses on macOS
 *     and Linux). This was the #542 regression surface.
 *   - `> file` redirect: regular file on fd 1. This was the #730 regression
 *     surface.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, test, expect } from 'vitest'

const execFileAsync = promisify(execFile)

const FIXTURE = path.resolve(__dirname, 'fixtures', 'runResult-cli.tsx')

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

// `bun run` executes .tsx directly.
const BUN = requireTool('BUN_BIN')

const ENV_WITHOUT_AGENT = (): NodeJS.ProcessEnv => {
  const clean = { ...process.env }
  // The agent-env allowlist would force `json` mode and skip the visual view.
  // Clear those so we exercise the "no TTY, no agent, subprocess capture"
  // branch — the bug's original environment.
  delete clean.AGENT
  delete clean.CLAUDE_PROJECT_DIR
  delete clean.CLAUDECODE
  delete clean.OPENCODE
  delete clean.CLINE_ACTIVE
  delete clean.CODEX_SANDBOX
  return clean
}

describe('runResult subprocess stdout contract', () => {
  test('execFile: stdout is byte-clean; view (if any) goes to stderr', async () => {
    const env = ENV_WITHOUT_AGENT()
    env.TEST_PAYLOAD = 'secret-payload-abc'

    const { stdout, stderr } = await execFileAsync(BUN, ['run', FIXTURE], {
      env,
    })

    // stdout is the raw result plus a trailing newline — nothing else.
    expect(stdout).toBe('secret-payload-abc\n')
    // Payload must never bleed into stderr (view text only).
    expect(stderr).not.toContain('secret-payload-abc')
  })

  test('failure: exits 1 with the formatted cause on stderr, stdout untouched', async () => {
    // The exit code is derived from the fiber Exit, so a failing program must land
    // on 1 in a real process — and the result channel (stdout) stays empty rather
    // than emitting a partial payload.
    const env = ENV_WITHOUT_AGENT()
    env.TEST_PAYLOAD = 'never-emitted-payload'
    env.TEST_FAIL = '1'

    const failure = await execFileAsync(BUN, ['run', FIXTURE], { env }).then(
      () => {
        throw new Error('fixture exited 0 but was expected to fail')
      },
      (error: NodeJS.ErrnoException & { code?: number; stdout: string; stderr: string }) => error,
    )

    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain('boom: fixture failure')
    expect(failure.stdout).toBe('')
  })

  test('> file redirect: file contains only the raw result', async () => {
    const env = ENV_WITHOUT_AGENT()
    env.TEST_PAYLOAD = 'redirected-value-xyz'

    const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tui-react-redirect-'))
    const outPath = path.join(tmpdir, 'stdout.txt')
    try {
      const outFd = fs.openSync(outPath, 'w')
      const errFd = fs.openSync(path.join(tmpdir, 'stderr.txt'), 'w')
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(BUN, ['run', FIXTURE], {
            env,
            stdio: ['ignore', outFd, errFd],
          })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`fixture exited with code ${code}`))
          })
        })
      } finally {
        fs.closeSync(outFd)
        fs.closeSync(errFd)
      }

      const fileContents = await fs.promises.readFile(outPath, 'utf8')
      const stderrContents = await fs.promises.readFile(path.join(tmpdir, 'stderr.txt'), 'utf8')

      // Byte-clean: just the result and a trailing newline.
      expect(fileContents).toBe('redirected-value-xyz\n')
      // Payload never lands on the view channel.
      expect(stderrContents).not.toContain('redirected-value-xyz')
    } finally {
      await fs.promises.rm(tmpdir, { recursive: true, force: true })
    }
  })
})
