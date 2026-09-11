import { NodeServices as NodeContext } from '@effect/platform-node'
import { Effect, FileSystem, type PlatformError, Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  EffectPath,
  type AbsoluteFileInfo,
  type InvalidPathError,
  type NotAFileError,
  type NotAbsoluteError,
  type NotRelativeError,
  type ConventionError,
  type PathNotFoundError,
  type PermissionError,
  type TraversalError,
  type RelativePath,
} from './mod.ts'

const summarizeFileInfo = (info: AbsoluteFileInfo) => ({
  original: info.original,
  normalized: info.normalized,
  segments: info.segments,
  baseName: info.baseName,
  extension: info.extension,
  fullExtension: info.fullExtension,
  parent: {
    normalized: info.parent.normalized,
    segments: info.parent.segments,
    baseName: info.parent.baseName,
  },
})

const escapeNullBytes = (path: string): string => path.replaceAll('\0', '\\0')

type ConventionBaselineError =
  | InvalidPathError
  | NotAbsoluteError
  | NotRelativeError
  | ConventionError

const summarizeConventionError = (error: ConventionBaselineError) => {
  switch (error._tag) {
    case 'InvalidPathError':
      return {
        _tag: error._tag,
        message: error.message,
        path: escapeNullBytes(error.path),
        position: error.position,
        reason: error.reason,
      }
    case 'NotAbsoluteError':
      return {
        _tag: error._tag,
        message: error.message,
        path: error.path,
        suggestedAbsolute: error.suggestedAbsolute,
      }
    case 'NotRelativeError':
      return {
        _tag: error._tag,
        absolutePrefix: error.absolutePrefix,
        message: error.message,
        path: error.path,
      }
    case 'ConventionError':
      return {
        _tag: error._tag,
        expected: error.expected,
        message: error.message,
        path: error.path,
        violation: error.violation,
      }
  }
}

const summarizeTraversalError = (error: TraversalError) => ({
  _tag: error._tag,
  escapedTo: error.escapedTo,
  escapingSegments: error.escapingSegments,
  message: error.message,
  path: error.path,
  sandboxRoot: error.sandboxRoot,
})

const left = <A, E>(result: Result.Result<A, E>, message = 'expected failure'): E => {
  if (Result.isSuccess(result) === true) {
    throw new Error(message)
  }
  return result.failure
}

const summarizePlatformError = (error: PlatformError.PlatformError) => ({
  _tag: error._tag,
  reason: error.reason._tag,
  module: error.reason.module,
  method: error.reason.method,
})

type VerifiedFileBaselineError =
  | InvalidPathError
  | NotAFileError
  | NotAbsoluteError
  | PathNotFoundError
  | PermissionError

const summarizePathError = (error: VerifiedFileBaselineError, normalizeRoot: string) => {
  switch (error._tag) {
    case 'PathNotFoundError':
      return {
        _tag: error._tag,
        expectedType: error.expectedType,
        message: error.message.replace(normalizeRoot, '<tmp>'),
      }
    case 'PermissionError':
      return {
        _tag: error._tag,
        operation: error.operation,
        message: error.message.replace(normalizeRoot, '<tmp>'),
      }
    default:
      throw new Error(`expected filesystem failure, received ${error._tag}`)
  }
}

describe('effect-path baselines (cross-major invariant)', () => {
  it('pins PathInfo schema encoded bytes and re-encoded identity', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const normalizedSchema = EffectPath.schema.AbsoluteFileInfo()
        const originalSchema = EffectPath.schema.AbsoluteFileInfo({ encodeAs: 'original' })
        const decoded = yield* Schema.decodeEffect(normalizedSchema)('/repo//pkg/archive.tar.gz')

        return {
          decoded: summarizeFileInfo(decoded),
          encodedDefault: yield* Schema.encodeEffect(normalizedSchema)(decoded),
          encodedOriginal: yield* Schema.encodeEffect(originalSchema)(decoded),
        }
      }),
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "decoded": {
          "baseName": "archive",
          "extension": "gz",
          "fullExtension": "tar.gz",
          "normalized": "/repo/pkg/archive.tar.gz",
          "original": "/repo//pkg/archive.tar.gz",
          "parent": {
            "baseName": "pkg",
            "normalized": "/repo/pkg/",
            "segments": [
              "repo",
              "pkg",
            ],
          },
          "segments": [
            "repo",
            "pkg",
            "archive.tar.gz",
          ],
        },
        "encodedDefault": "/repo/pkg/archive.tar.gz",
        "encodedOriginal": "/repo//pkg/archive.tar.gz",
      }
    `)
  })

  it('pins convention parser failure partitions', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const absoluteFileFromRelative = yield* EffectPath.convention
          .absoluteFile('relative/file.txt')
          .pipe(Effect.result)
        const relativeFileFromAbsolute = yield* EffectPath.convention
          .relativeFile('/absolute/file.txt')
          .pipe(Effect.result)
        const fileFromDirectoryConvention = yield* EffectPath.convention
          .absoluteFile('/absolute/dir/')
          .pipe(Effect.result)
        const invalidPath = yield* EffectPath.convention
          .relativeFile('bad\0path.txt')
          .pipe(Effect.result)

        return [
          left(absoluteFileFromRelative),
          left(relativeFileFromAbsolute),
          left(fileFromDirectoryConvention),
          left(invalidPath),
        ].map(summarizeConventionError)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "_tag": "NotAbsoluteError",
          "message": "Expected absolute path",
          "path": "relative/file.txt",
          "suggestedAbsolute": undefined,
        },
        {
          "_tag": "NotRelativeError",
          "absolutePrefix": "/",
          "message": "Expected relative path",
          "path": "/absolute/file.txt",
        },
        {
          "_tag": "ConventionError",
          "expected": "file",
          "message": "File path must not end with a separator",
          "path": "/absolute/dir/",
          "violation": "trailing_slash_on_file",
        },
        {
          "_tag": "InvalidPathError",
          "message": "Path contains null byte",
          "path": "bad\\0path.txt",
          "position": 3,
          "reason": "null_byte",
        },
      ]
    `)
  })

  it('pins path operation byte output across join, normalization, and sandbox checks', () => {
    const root = EffectPath.unsafe.absoluteDir('/repo//root')
    const joined = EffectPath.ops.join(root, EffectPath.unsafe.relativeFile('src/../index.ts'))
    const normalized = EffectPath.normalize.lexicalPure(joined)
    const sandbox = EffectPath.sandbox(EffectPath.unsafe.absoluteDir('/repo/root/'))
    const allowed = sandbox.resolve(EffectPath.unsafe.relativeFile('src/../index.ts'))
    const escaped = sandbox.resolve(EffectPath.unsafe.relativeFile('../outside.ts') as RelativePath)

    expect({
      joined,
      normalized,
      allowed: Result.isSuccess(allowed) === true ? allowed.success : allowed.failure,
      escaped:
        Result.isFailure(escaped) === true
          ? summarizeTraversalError(escaped.failure)
          : escaped.success,
    }).toMatchInlineSnapshot(`
      {
        "allowed": "/repo/root/index.ts",
        "escaped": {
          "_tag": "TraversalError",
          "escapedTo": undefined,
          "escapingSegments": [
            "..",
          ],
          "message": "Path escapes sandbox root: ../outside.ts",
          "path": "../outside.ts",
          "sandboxRoot": "/repo/root/",
        },
        "joined": "/repo//root/src/../index.ts",
        "normalized": "/repo/root/index.ts",
      }
    `)
  })

  it('pins real ENOENT and EEXIST platform failure fields and the public missing-path partition', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const missing = `${root}/missing.txt`

        const enoent = left(yield* fs.stat(missing).pipe(Effect.result))
        const missingPath = left(
          yield* EffectPath.verified.absoluteFile(missing).pipe(Effect.result),
        )
        // effect-path has no public create/write API or EEXIST branch. This real failure pins the
        // platform wrapper fields only; it does not claim a package-owned EEXIST partition.
        const eexist = left(yield* fs.makeDirectory(root).pipe(Effect.result))

        return {
          enoent: {
            platform: summarizePlatformError(enoent),
            public: summarizePathError(missingPath, root),
          },
          eexist: {
            platform: summarizePlatformError(eexist),
          },
        }
      }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "eexist": {
          "platform": {
            "_tag": "PlatformError",
            "method": "makeDirectory",
            "module": "FileSystem",
            "reason": "AlreadyExists",
          },
        },
        "enoent": {
          "platform": {
            "_tag": "PlatformError",
            "method": "stat",
            "module": "FileSystem",
            "reason": "NotFound",
          },
          "public": {
            "_tag": "PathNotFoundError",
            "expectedType": "any",
            "message": "Path not found: <tmp>/missing.txt",
          },
        },
      }
    `)
  })

  it.skipIf(process.getuid?.() === 0)(
    'pins real EACCES platform fields and the public permission partition',
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped()
          const blocked = `${root}/blocked`
          const blockedFile = `${blocked}/data.txt`

          yield* fs.makeDirectory(blocked)
          yield* fs.writeFileString(blockedFile, 'blocked')
          yield* fs.chmod(blocked, 0o000)

          return yield* Effect.gen(function* () {
            const eacces = left(yield* fs.stat(blockedFile).pipe(Effect.result))
            const permission = left(
              yield* EffectPath.verified.absoluteFile(blockedFile).pipe(Effect.result),
            )

            return {
              platform: summarizePlatformError(eacces),
              public: summarizePathError(permission, root),
            }
          }).pipe(Effect.ensuring(fs.chmod(blocked, 0o700).pipe(Effect.ignore)))
        }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
      )

      expect(result).toMatchInlineSnapshot(`
        {
          "platform": {
            "_tag": "PlatformError",
            "method": "stat",
            "module": "FileSystem",
            "reason": "PermissionDenied",
          },
          "public": {
            "_tag": "PermissionError",
            "message": "Permission denied: <tmp>/blocked/data.txt",
            "operation": "stat",
          },
        }
      `)
    },
  )
})
