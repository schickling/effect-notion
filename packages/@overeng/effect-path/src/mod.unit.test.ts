import { NodeServices as NodeContext } from '@effect/platform-node'
import { Effect, FileSystem, Result, Schema } from 'effect'
import { expect, it } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  EffectPath,
  type AbsoluteDirPath,
  type AbsoluteFilePath,
  type RelativeDirPath,
  type RelativeFilePath,
} from './mod.ts'

// =============================================================================
// Convention-Based Parsing Tests
// =============================================================================

Vitest.describe('convention parsing', () => {
  Vitest.describe('absoluteFile', () => {
    Vitest.it.effect('parses absolute file path (Unix)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFile('/home/user/file.txt')
        expect(result).toBe('/home/user/file.txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    Vitest.it.effect('fails on relative path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('relative/path.txt')
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    Vitest.it.effect('fails on directory path (trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('/path/to/dir/')
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('absoluteDir', () => {
    Vitest.it.effect('parses absolute directory path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDir('/home/user/')
        expect(result).toBe('/home/user/')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    Vitest.it.effect('fails on file path (no trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDir('/path/to/file').pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('relativeFile', () => {
    Vitest.it.effect('parses relative file path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.relativeFile('src/mod.ts')
        expect(result).toBe('src/mod.ts')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('relativeDir', () => {
    Vitest.it.effect('parses relative directory path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.relativeDir('src/components/')
        expect(result).toBe('src/components/')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('absoluteFileInfo', () => {
    Vitest.it.effect('parses absolute file path and returns PathInfo', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFileInfo('/home/user/file.txt')
        expect(result.normalized).toBe('/home/user/file.txt')
        expect(result.baseName).toBe('file')
        expect(result.extension).toBe('txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    Vitest.it.effect('parses file with multiple extensions', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFileInfo('/path/to/archive.tar.gz')
        expect(result.baseName).toBe('archive')
        expect(result.extension).toBe('gz')
        expect(result.fullExtension).toBe('tar.gz')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('absoluteDirInfo', () => {
    Vitest.it.effect('parses absolute directory path and returns PathInfo', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDirInfo('/home/user/')
        expect(result.normalized).toBe('/home/user/')
        expect(result.baseName).toBe('user')
        expect(result.extension).toBeUndefined()
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })
})

// =============================================================================
// Unsafe Constructor Tests
// =============================================================================

Vitest.describe('unsafe constructors', () => {
  it('absoluteFile creates branded type', () => {
    const path: AbsoluteFilePath = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
    expect(path).toBe('/home/user/file.txt')
  })

  it('absoluteDir creates branded type with trailing slash', () => {
    const path: AbsoluteDirPath = EffectPath.unsafe.absoluteDir('/home/user/')
    expect(path).toBe('/home/user/')
  })

  it('absoluteDir adds trailing slash if missing', () => {
    const path: AbsoluteDirPath = EffectPath.unsafe.absoluteDir('/home/user')
    expect(path).toBe('/home/user/')
  })

  it('relativeFile creates branded type', () => {
    const path: RelativeFilePath = EffectPath.unsafe.relativeFile('src/mod.ts')
    expect(path).toBe('src/mod.ts')
  })

  it('relativeDir creates branded type', () => {
    const path: RelativeDirPath = EffectPath.unsafe.relativeDir('src/')
    expect(path).toBe('src/')
  })
})

// =============================================================================
// Path Operations Tests
// =============================================================================

Vitest.describe('path operations', () => {
  Vitest.describe('join', () => {
    it('joins directory with file', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/user/')
      const file = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, file)
      expect(result).toBe('/home/user/file.txt')
    })

    it('joins multiple segments', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/')
      const seg1 = EffectPath.unsafe.relativeDir('user/')
      const seg2 = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, seg1, seg2)
      expect(result).toBe('/home/user/file.txt')
    })

    it('joins from root directory without double slashes', () => {
      const dir = EffectPath.unsafe.absoluteDir('/')
      const file = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, file)
      expect(result).toBe('/file.txt')
    })
  })

  Vitest.describe('parent', () => {
    it('gets parent directory of file', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      const dir = EffectPath.ops.parent(file)
      expect(dir).toBe('/home/user/')
    })

    it('gets parent directory of directory', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/user/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('/home/')
    })

    it('gets parent of directory directly under root', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('/')
    })

    it('gets parent of relative directory at root', () => {
      const dir = EffectPath.unsafe.relativeDir('foo/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('./')
    })
  })

  Vitest.describe('baseName', () => {
    it('gets filename without extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      expect(EffectPath.ops.baseName(file)).toBe('file')
    })

    it('gets directory name', () => {
      const dir = EffectPath.unsafe.absoluteDir('/path/to/folder/')
      expect(EffectPath.ops.baseName(dir)).toBe('folder')
    })
  })

  Vitest.describe('extension', () => {
    it('gets file extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      expect(EffectPath.ops.extension(file)).toBe('txt')
    })

    it('returns undefined for files without extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/Makefile')
      expect(EffectPath.ops.extension(file)).toBeUndefined()
    })
  })

  Vitest.describe('fullExtension', () => {
    it('gets full extension for multi-extension files', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/archive.tar.gz')
      expect(EffectPath.ops.fullExtension(file)).toBe('tar.gz')
    })
  })

  Vitest.describe('withExtension', () => {
    it('changes file extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      const result = EffectPath.ops.withExtension({
        path: file,
        extension: 'md',
      })
      expect(result).toBe('/path/to/file.md')
    })

    it('adds extension to file without one', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/Makefile')
      const result = EffectPath.ops.withExtension({
        path: file,
        extension: 'bak',
      })
      expect(result).toBe('/path/to/Makefile.bak')
    })
  })

  Vitest.describe('withBaseName', () => {
    it('changes file name preserving extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/old.txt')
      const result = EffectPath.ops.withBaseName({ path: file, name: 'new' })
      expect(result).toBe('/path/to/new.txt')
    })
  })
})

// =============================================================================
// Normalization Tests
// =============================================================================

Vitest.describe('normalization', () => {
  Vitest.describe('lexicalPure', () => {
    it('normalizes path with . and ..', () => {
      const path = EffectPath.unsafe.absoluteFile('/home/user/../admin/./file.txt')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/admin/file.txt')
    })

    it('normalizes multiple slashes', () => {
      const path = EffectPath.unsafe.absoluteFile('/home//user///file.txt')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/user/file.txt')
    })

    it('preserves trailing slash for directories', () => {
      const path = EffectPath.unsafe.absoluteDir('/home/user/../admin/')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/admin/')
    })

    it('handles relative paths', () => {
      const path = EffectPath.unsafe.relativeFile('src/../lib/file.ts')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('lib/file.ts')
    })
  })

  Vitest.describe('lexical (Effect-based)', () => {
    Vitest.it.effect('normalizes path using platform Path service', () =>
      Effect.gen(function* () {
        const path = EffectPath.unsafe.absoluteFile('/home/user/../admin/file.txt')
        const result = yield* EffectPath.normalize.lexical(path)
        expect(result).toBe('/home/admin/file.txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })
})

// =============================================================================
// Schema Tests
// =============================================================================

Vitest.describe('schema', () => {
  Vitest.describe('AbsoluteFilePath', () => {
    Vitest.it.effect('decodes valid absolute file path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteFilePath)(
          '/home/user/file.txt',
        )
        expect(result).toBe('/home/user/file.txt')
      }),
    )

    Vitest.it.effect('rejects relative path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteFilePath)(
          'relative/file.txt',
        ).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }),
    )

    Vitest.it.effect('rejects directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteFilePath)(
          '/path/to/dir/',
        ).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('AbsoluteDirPath', () => {
    Vitest.it.effect('decodes valid absolute directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteDirPath)('/home/user/')
        expect(result).toBe('/home/user/')
      }),
    )

    Vitest.it.effect('rejects file path (no trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteDirPath)(
          '/home/user/file.txt',
        ).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('RelativeFilePath', () => {
    Vitest.it.effect('decodes valid relative file path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.RelativeFilePath)('src/mod.ts')
        expect(result).toBe('src/mod.ts')
      }),
    )
  })

  Vitest.describe('RelativeDirPath', () => {
    Vitest.it.effect('decodes valid relative directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.RelativeDirPath)(
          'src/components/',
        )
        expect(result).toBe('src/components/')
      }),
    )
  })

  Vitest.describe('AbsoluteFileInfo', () => {
    Vitest.it.effect('decodes to PathInfo structure', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteFileInfo())(
          '/path/to/file.txt',
        )
        expect(result.original).toBe('/path/to/file.txt')
        expect(result.baseName).toBe('file')
        expect(result.extension).toBe('txt')
      }),
    )

    Vitest.it.effect('encodes back to normalized string by default', () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(EffectPath.schema.AbsoluteFileInfo())(
          '/path/to/file.txt',
        )
        const encoded = yield* Schema.encodeEffect(EffectPath.schema.AbsoluteFileInfo())(decoded)
        expect(encoded).toBe('/path/to/file.txt')
      }),
    )
  })

  Vitest.describe('RelativeFileInfo', () => {
    Vitest.it.effect('uses ./ as parent for root-level relative files', () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(EffectPath.schema.RelativeFileInfo())('file.txt')
        expect(decoded.parent.normalized).toBe('./')
      }),
    )
  })
})

// =============================================================================
// Sandbox Tests
// =============================================================================

Vitest.describe('sandbox', () => {
  const sandbox = EffectPath.sandbox(EffectPath.unsafe.absoluteDir('/home/user/'))

  Vitest.describe('validate', () => {
    it('validates safe relative path', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('file.txt'))
      expect(Result.isSuccess(result)).toBe(true)
    })

    it('validates nested relative path', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('sub/dir/file.txt'))
      expect(Result.isSuccess(result)).toBe(true)
    })

    it('rejects path escaping with ..', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('../../../etc/passwd'))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) === true) {
        expect(result.failure._tag).toBe('TraversalError')
      }
    })

    it('rejects paths that escape and then re-enter', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('../safe/file.txt'))
      expect(Result.isFailure(result)).toBe(true)
    })

    it('rejects absolute paths passed as relative', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('/etc/passwd'))
      expect(Result.isFailure(result)).toBe(true)
    })

    it('allows .. that stays within sandbox', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('sub/../file.txt'))
      expect(Result.isSuccess(result)).toBe(true)
    })
  })

  Vitest.describe('resolve', () => {
    it('resolves relative path to absolute', () => {
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('file.txt'))
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result) === true) {
        expect(result.success).toBe('/home/user/file.txt')
      }
    })

    it('resolves nested path', () => {
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('sub/dir/file.txt'))
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result) === true) {
        expect(result.success).toBe('/home/user/sub/dir/file.txt')
      }
    })

    it('rejects escaping path', () => {
      // Need at least 3 .. to escape /home/user/ (which is 2 levels deep)
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('../../../etc/passwd'))
      expect(Result.isFailure(result)).toBe(true)
    })
  })

  Vitest.describe('contains', () => {
    it('returns true for paths inside sandbox', () => {
      const inside = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      expect(sandbox.contains(inside)).toBe(true)
    })

    it('returns true for nested paths inside sandbox', () => {
      const inside = EffectPath.unsafe.absoluteFile('/home/user/sub/dir/file.txt')
      expect(sandbox.contains(inside)).toBe(true)
    })

    it('returns false for paths outside sandbox', () => {
      const outside = EffectPath.unsafe.absoluteFile('/etc/passwd')
      expect(sandbox.contains(outside)).toBe(false)
    })

    it('returns false for sibling paths', () => {
      const sibling = EffectPath.unsafe.absoluteFile('/home/other/file.txt')
      expect(sandbox.contains(sibling)).toBe(false)
    })

    it('returns true for the root itself', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      expect(sandbox.contains(root)).toBe(true)
    })
  })
})

// =============================================================================
// Utility Function Tests
// =============================================================================

Vitest.describe('utility functions', () => {
  Vitest.describe('validatePath', () => {
    it('validates path stays in sandbox', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const path = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.validatePath({ root, path })
      expect(Result.isSuccess(result)).toBe(true)
    })
  })

  Vitest.describe('isContained', () => {
    it('checks if absolute path is in directory', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const inside = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      expect(EffectPath.isContained({ root, path: inside })).toBe(true)
    })

    it('returns false for paths outside', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const outside = EffectPath.unsafe.absoluteFile('/etc/passwd')
      expect(EffectPath.isContained({ root, path: outside })).toBe(false)
    })
  })
})

// =============================================================================
// Edge Case Tests
// =============================================================================

Vitest.describe('edge cases', () => {
  Vitest.describe('path validation', () => {
    Vitest.it.effect('rejects empty path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFile('').pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    Vitest.it.effect('rejects path with null byte', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('/path/to\0file.txt')
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  Vitest.describe('root directory handling', () => {
    it('handles root directory', () => {
      const root = EffectPath.unsafe.absoluteDir('/')
      expect(root).toBe('/')
    })

    it('parent of root returns undefined', () => {
      const root = EffectPath.unsafe.absoluteDir('/')
      const parentDir = EffectPath.ops.parent(root)
      expect(parentDir).toBeUndefined()
    })
  })

  Vitest.describe('hidden files', () => {
    it('handles dotfiles', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/.bashrc')
      // Dotfiles without a second dot have no extension - .bashrc is the full filename
      expect(EffectPath.ops.baseName(file)).toBe('.bashrc')
      expect(EffectPath.ops.extension(file)).toBe(undefined)
    })

    it('handles dotfiles with extensions', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/.config.json')
      expect(EffectPath.ops.baseName(file)).toBe('.config')
      expect(EffectPath.ops.extension(file)).toBe('json')
    })
  })
})

// =============================================================================
// Symlink Tests
// =============================================================================

Vitest.describe('symlink', () => {
  Vitest.it.effect('detects and reads symlinks', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()

      const target = EffectPath.unsafe.absoluteFile(`${tmp}/target.txt`)
      const link = EffectPath.unsafe.absoluteFile(`${tmp}/link.txt`)

      yield* fs.writeFileString(target, 'hello')
      yield* fs.symlink(target, link)

      expect(yield* EffectPath.symlink.is(link)).toBe(true)
      expect(yield* EffectPath.symlink.is(target)).toBe(false)

      const resolvedTarget = yield* EffectPath.symlink.readLink(link)
      expect(resolvedTarget).toBe(target)

      const chain = yield* EffectPath.symlink.chain(link)
      expect(chain).toEqual([link, target])
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
  )
})
