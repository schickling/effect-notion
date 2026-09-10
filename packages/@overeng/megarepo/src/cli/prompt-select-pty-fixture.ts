import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import type { QuitError } from 'effect/Terminal'
import { Prompt } from 'effect/unstable/cli'

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

// `isRaw` is declared non-optional on the TTY stream type but is absent when stdin is a pipe,
// so compare explicitly instead of coercing.
const isRaw = () => (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw === true

const prompt = (message: string) =>
  Prompt.select<'create' | 'skip' | 'abort'>({
    message,
    choices: [
      { title: 'Create branch', value: 'create' },
      { title: 'Skip this member', value: 'skip' },
      { title: 'Abort sync', value: 'abort' },
    ],
  })

// Under Effect v4 the Node terminal is a scoped resource: raw mode is restored when the
// providing scope closes, so the trace must be measured outside `Effect.scoped`.
const run = (caseId: string): Effect.Effect<PromptTrace, QuitError, never> =>
  caseId === 'select'
    ? Effect.scoped(
        Prompt.run(prompt('Choose missing-ref action')).pipe(Effect.provide(NodeServices.layer)),
      ).pipe(Effect.map((result) => ({ case: 'select', result, rawAfter: isRaw() }) as const))
    : Effect.scoped(
        Prompt.run(prompt('Abort missing-ref action')).pipe(Effect.provide(NodeServices.layer)),
      ).pipe(
        Effect.map(
          () =>
            ({
              case: 'interrupt',
              exit: 'UnexpectedSelection',
              rawAfter: isRaw(),
            }) as const,
        ),
        Effect.catchTag('QuitError', () =>
          Effect.succeed({ case: 'interrupt', exit: 'Quit', rawAfter: isRaw() } as const),
        ),
      )

const trace: PromptTrace = await Effect.runPromise(run(process.argv[2] ?? ''))
process.stdout.write(`TRACE:${Buffer.from(JSON.stringify(trace)).toString('base64')}`)
