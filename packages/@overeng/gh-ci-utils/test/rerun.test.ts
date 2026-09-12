import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  isRunAttemptReady,
  isRunCreatedForDispatch,
  validateMutationWorkflowMatch,
  validateWorkflowDispatchExit,
} from '../src/node/commands/rerun.ts'

describe('isRunCreatedForDispatch', () => {
  const dispatchedAt = new Date('2026-09-12T12:34:56.789Z')

  it('accepts GitHub timestamps rounded down within the dispatch second', () => {
    expect(
      isRunCreatedForDispatch({
        runCreatedAt: new Date('2026-09-12T12:34:56.000Z'),
        dispatchedAt,
      }),
    ).toBe(true)
  })

  it('rejects a run created in an earlier second', () => {
    expect(
      isRunCreatedForDispatch({
        runCreatedAt: new Date('2026-09-12T12:34:55.000Z'),
        dispatchedAt,
      }),
    ).toBe(false)
  })
})

describe('isRunAttemptReady', () => {
  it('keeps waiting while GitHub still returns the completed previous attempt', () => {
    expect(isRunAttemptReady({ runAttempt: 3, previousRunAttempt: 3 })).toBe(false)
  })

  it('accepts the incremented rerun attempt', () => {
    expect(isRunAttemptReady({ runAttempt: 4, previousRunAttempt: 3 })).toBe(true)
  })
})

describe('validateWorkflowDispatchExit', () => {
  it('fails with gh stderr when workflow dispatch exits nonzero', () => {
    const error = Effect.runSync(
      Effect.flip(
        validateWorkflowDispatchExit({
          exitCode: 1,
          stderr: 'could not find any workflows named CI',
          workflow: 'CI',
          repo: 'example-org/example-repo',
          branch: 'main',
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: 'ConfigError',
      message: "Failed to trigger workflow 'CI' for example-org/example-repo on ref 'main'",
      cause: 'could not find any workflows named CI',
    })
  })
})

describe('validateMutationWorkflowMatch', () => {
  it.each(['rerun', 'cancel'] as const)(
    'rejects %s when explicit workflow resolution fell back to another workflow',
    (action) => {
      const error = Effect.runSync(
        Effect.flip(
          validateMutationWorkflowMatch({
            action,
            resolved: {
              runId: 123,
              repo: 'example-org/example-repo',
              selection: {
                prNumber: null,
                expectedHeadSha: null,
                expectedWorkflow: 'release.yml',
                matchedExpectedWorkflow: false,
                runHeadSha: 'abc123',
              },
            },
          }),
        ),
      )

      expect(error).toMatchObject({
        _tag: 'ConfigError',
        message: `No run matching workflow 'release.yml' was found in example-org/example-repo; refusing to ${action} run 123`,
        cause: 'workflow not found',
      })
    },
  )
})
