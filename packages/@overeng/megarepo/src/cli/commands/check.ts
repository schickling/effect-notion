import { Console, Effect, Option, Schema } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { EffectPath } from '@overeng/effect-path'

import { readMegarepoConfig } from '../../core/config.ts'
import { LOCK_FILE_NAME, readLockFile } from '../../core/lock.ts'
import { checkSourcePolicy, formatSourcePolicyViolation } from '../../core/source-policy.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'
import { CheckCommandError, LockFileRequiredError, NotInMegarepoError } from '../errors.ts'
import * as Observability from '../observability.ts'
import { loadOwnedIdentity, readCompositionLockFile } from './composition.ts'

/** Encodes the structured check result as pretty-printed JSON for `--json` output. */
const CheckReportJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })

const allOption = Cli.Flag.boolean('all').pipe(
  Cli.Flag.withDescription('Check member source and lock files in repos/ as well as the root'),
  Cli.Flag.withDefault(false),
)

/** Check that the megarepo is structurally valid. */
export const checkCommand = Cli.Command.make(
  'check',
  {
    all: allOption,
    json: jsonOption,
  },
  ({ all, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const rootOpt = yield* findMegarepoRoot(cwd)

      if (Option.isNone(rootOpt) === true) {
        return yield* new NotInMegarepoError({ message: 'No megarepo config found' })
      }

      const root = rootOpt.value
      const { config } = yield* readMegarepoConfig(root)
      const rootLockPath = EffectPath.ops.join(root, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME))
      const lockFileOpt =
        config.generators?.composition?.enabled === true
          ? yield* Effect.gen(function* () {
              const identity = yield* loadOwnedIdentity({ workspaceRoot: root })
              return yield* readCompositionLockFile({
                workspaceRoot: root,
                ownedMemberPath: identity.ownedSourcePath,
              })
            })
          : yield* readLockFile(rootLockPath)

      if (Option.isNone(lockFileOpt) === true) {
        return yield* new LockFileRequiredError({
          message: 'megarepo.lock is required for megarepo checks; run `mr lock` first',
        })
      }

      const sourcePolicy = yield* checkSourcePolicy({
        megarepoRoot: root,
        config,
        lockFile: lockFileOpt.value,
        includeMembers: all,
      })

      const result = {
        checks: [
          {
            name: 'source-policy',
            violations: sourcePolicy.violations,
          },
        ],
        violations: sourcePolicy.violations,
      }

      if (json === true) {
        yield* Console.log(yield* Schema.encodeEffect(CheckReportJson)(result))
      } else if (result.violations.length === 0) {
        yield* Console.log('Megarepo checks OK')
      } else {
        yield* Console.error('Megarepo check violations:')
        for (const violation of result.violations) {
          yield* Console.error(`- ${formatSourcePolicyViolation(violation)}`)
        }
      }

      const violationCount = result.violations.length
      if (violationCount > 0) {
        return yield* new CheckCommandError({
          message: `Megarepo checks failed with ${violationCount} violation(s)`,
          violationCount,
        })
      }
    }).pipe(
      Observability.withCommandSpan({
        name: 'megarepo/check',
        command: 'check',
        label: json === true ? 'check-json' : 'check',
        output: json === true ? 'json' : 'text',
        all,
      }),
    ),
).pipe(Cli.Command.withDescription('Check that the megarepo is structurally valid'))
