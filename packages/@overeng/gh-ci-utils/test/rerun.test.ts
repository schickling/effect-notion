import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  classifyRunWatch,
  isRunAttemptReady,
  validateMutationRunSelection,
} from '../src/node/commands/rerun.ts'

describe('isRunAttemptReady', () => {
  it('keeps waiting while GitHub still returns the completed previous attempt', () => {
    expect(isRunAttemptReady({ runAttempt: 3, previousRunAttempt: 3 })).toBe(false)
  })

  it('accepts the incremented rerun attempt', () => {
    expect(isRunAttemptReady({ runAttempt: 4, previousRunAttempt: 3 })).toBe(true)
  })
})

describe('classifyRunWatch', () => {
  it('treats a completed neutral run as non-blocking success', () => {
    expect(
      classifyRunWatch({
        runStatus: 'completed',
        runConclusion: 'neutral',
        jobConclusions: ['neutral'],
        failFast: false,
      }),
    ).toBe('success')
  })

  it('keeps watching an active neutral job in first-failure mode', () => {
    expect(
      classifyRunWatch({
        runStatus: 'in_progress',
        runConclusion: null,
        jobConclusions: ['neutral'],
        failFast: true,
      }),
    ).toBe('continue')
  })

  it.each([[[]], [['success']]] as const)(
    'treats a completed cancelled run as terminal non-success with job conclusions %j',
    (jobConclusions) => {
      expect(
        classifyRunWatch({
          runStatus: 'completed',
          runConclusion: 'cancelled',
          jobConclusions,
          failFast: false,
        }),
      ).toBe('cancelled')
    },
  )
})

describe('validateMutationRunSelection', () => {
  it.each(['rerun', 'cancel'] as const)(
    'rejects %s when explicit workflow resolution fell back to another workflow',
    (action) => {
      const error = Effect.runSync(
        Effect.flip(
          validateMutationRunSelection({
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

  it('rejects a stale PR head selection before rerunning', () => {
    const error = Effect.runSync(
      Effect.flip(
        validateMutationRunSelection({
          action: 'rerun',
          resolved: {
            runId: 456,
            repo: 'example-org/example-repo',
            selection: {
              prNumber: 42,
              expectedHeadSha: 'current-head-sha',
              expectedWorkflow: 'ci.yml',
              matchedExpectedWorkflow: true,
              runHeadSha: 'stale-head-sha',
            },
          },
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: 'ConfigError',
      message:
        'Run 456 targets stale-head-sha, not expected PR head current-head-sha; refusing to rerun the stale run',
      cause: 'stale run selection',
    })
  })
})
