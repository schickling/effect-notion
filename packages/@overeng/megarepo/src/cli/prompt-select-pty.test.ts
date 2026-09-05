import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { requireTool } from '../test-utils/require-tool.ts'

const scriptBin = requireTool('SCRIPT_BIN')
const bashBin = requireTool('BASH_BIN')
const sttyBin = requireTool('STTY_BIN')
const bunBin = requireTool('BUN_BIN')

type PromptCase = {
  readonly id: 'select' | 'interrupt'
  readonly readiness: string
  readonly inputs: ReadonlyArray<Buffer>
}

type PromptTrace =
  | {
      readonly case: 'select'
      readonly result: 'create' | 'skip' | 'abort'
      readonly rawAfter: boolean
    }
  | {
      readonly case: 'interrupt'
      readonly exit: 'Quit' | 'UnexpectedSelection'
      readonly rawAfter: boolean
    }

type PtyResult = {
  readonly readinessObserved: boolean
  readonly trace: PromptTrace
  /** Raw PTY transcript bytes (first ESC through the last frame before the TRACE marker). */
  readonly transcript: Buffer
}

const fixturePath = fileURLToPath(new URL('./prompt-select-pty-fixture.ts', import.meta.url))
const traceMarker = Buffer.from('TRACE:')
const readinessTimeoutMillis = 5_000
const inputDelayMillis = 90

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const runPromptCase = (testCase: PromptCase): Promise<PtyResult> =>
  new Promise((resolve, reject) => {
    // `script` runs its `-c` command through `$SHELL`; pin that to the declared bash so no
    // shell is resolved through an ambient PATH or a host `/bin/sh`.
    const command = `${shellQuote(sttyBin)} cols 80 rows 24; exec ${shellQuote(bunBin)} ${shellQuote(fixturePath)} ${testCase.id}`
    const child = spawn(scriptBin, ['-qfec', command, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SHELL: bashBin },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let readinessObserved = false
    let settled = false

    const fail = (error: Error) => {
      if (settled === true) return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      reject(error)
    }

    const timeout = setTimeout(
      () =>
        fail(
          new Error(
            `PTY prompt did not reach visible readiness string ${JSON.stringify(testCase.readiness)}`,
          ),
        ),
      readinessTimeoutMillis,
    )

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      if (readinessObserved === true) return

      const output = Buffer.concat(stdout).toString('utf8')
      if (output.includes(testCase.readiness) === false) return

      readinessObserved = true
      void (async () => {
        for (const input of testCase.inputs) {
          child.stdin.write(input)
          await new Promise((continueAfterDelay) =>
            setTimeout(continueAfterDelay, inputDelayMillis),
          )
        }
      })()
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => fail(error))
    child.on('close', (code) => {
      if (settled === true) return
      clearTimeout(timeout)

      if (readinessObserved === false) {
        fail(
          new Error(
            `PTY prompt exited before visible readiness string ${JSON.stringify(testCase.readiness)}`,
          ),
        )
        return
      }

      const output = Buffer.concat(stdout)
      const markerIndex = output.indexOf(traceMarker)
      if (code !== 0 || markerIndex === -1) {
        fail(
          new Error(
            `PTY prompt exited ${code} without a structured trace\n${Buffer.concat(stderr).toString('utf8')}`,
          ),
        )
        return
      }

      const encodedTrace = output
        .subarray(markerIndex + traceMarker.length)
        .toString('utf8')
        .trim()
      const trace = JSON.parse(Buffer.from(encodedTrace, 'base64').toString('utf8')) as PromptTrace

      // Transcript = first ESC through the last frame before the TRACE marker, dropping the
      // shell's echo of the launched command (contains absolute paths). Byte-exact so the
      // baseline below pins the rc.111 rendering deliberately.
      const transcriptStart = output.indexOf(0x1b)
      const transcript = output.subarray(transcriptStart === -1 ? 0 : transcriptStart, markerIndex)

      settled = true
      resolve({ readinessObserved, trace, transcript })
    })
  })

// This harness requires util-linux `script`; BSD `script` on macOS takes incompatible arguments.
// The gate pins platform-independent Effect Prompt semantics, so Linux execution covers its migration scope.
describe.skipIf(process.platform === 'darwin')('Prompt.select real-PTY semantics', () => {
  it('selects the second value and restores cooked mode', async () => {
    const result = await runPromptCase({
      id: 'select',
      readiness: 'Choose missing-ref action',
      inputs: [Buffer.from('\u001b[B'), Buffer.from('\r')],
    })

    expect(result.readinessObserved).toBe(true)
    expect(result.trace).toEqual({ case: 'select', result: 'skip', rawAfter: false })
  })

  it('pins the rc.111 selection transcript bytes (deliberate rebaseline)', async () => {
    const result = await runPromptCase({
      id: 'select',
      readiness: 'Choose missing-ref action',
      inputs: [Buffer.from('\u001b[B'), Buffer.from('\r')],
    })

    expect(result.transcript.toString('hex')).toMatchSnapshot()
  })

  it('classifies Ctrl-C as Quit and restores cooked mode', async () => {
    const result = await runPromptCase({
      id: 'interrupt',
      readiness: 'Abort missing-ref action',
      inputs: [Buffer.from('\u0003')],
    })

    expect(result.readinessObserved).toBe(true)
    expect(result.trace).toEqual({ case: 'interrupt', exit: 'Quit', rawAfter: false })
  })

  it('pins the rc.111 interrupted transcript bytes (deliberate rebaseline)', async () => {
    const result = await runPromptCase({
      id: 'interrupt',
      readiness: 'Abort missing-ref action',
      inputs: [Buffer.from('\u0003')],
    })

    expect(result.transcript.toString('hex')).toMatchSnapshot()
  })
})
