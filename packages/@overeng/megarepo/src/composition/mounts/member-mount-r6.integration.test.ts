import { chmod, lstat, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import { expect } from 'vitest'

import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import {
  assertOwnedCpAMountIdentity,
  computeR6SourcePathIdentity,
  encodeOwnedCpAMountMetadata,
  inspectOwnedCpAMount,
  makeOwnedCpAMountMetadata,
  ownedCpAMountMetadataPath,
  readOwnedCpAMountMetadata,
  scanR6BuildArtifactTree,
  scanR6ProtectedMount,
  scanR6ProtectedTree,
  scanR6Source,
  writeOwnedCpAMountMetadata,
  type OwnedCpAMountExpectedIdentity,
} from './member-mount-r6.ts'

const withNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const makeTree = ({
  root,
  capabilities = true,
  capabilityRoots = false,
}: {
  root: string
  capabilities?: boolean
  capabilityRoots?: boolean
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(NodePath.join(root, 'empty'), { recursive: true })
    yield* fs.makeDirectory(NodePath.join(root, 'dir'), { recursive: true })
    yield* fs.writeFileString(NodePath.join(root, 'plain.txt'), 'plain\n')
    yield* fs.writeFileString(NodePath.join(root, 'script.sh'), '#!/bin/sh\nexit 0\n')
    yield* fs.chmod(NodePath.join(root, 'script.sh'), 0o755)
    yield* fs.writeFileString(NodePath.join(root, 'dir', 'target.txt'), 'target\n')
    yield* fs.symlink('../plain.txt', NodePath.join(root, 'dir', 'safe-link'))
    if (capabilities === true) {
      yield* fs.makeDirectory(NodePath.join(root, '.buck2', 'capabilities', 'nested'), {
        recursive: true,
      })
      yield* fs.writeFileString(
        NodePath.join(root, '.buck2', 'capabilities', 'defs.bzl'),
        'TOOLS = {}\n',
      )
      yield* fs.makeDirectory(NodePath.join(root, '.buck2', 'capabilities', 'empty'), {
        recursive: true,
      })
    }
    if (capabilityRoots === true) {
      yield* fs.makeDirectory(NodePath.join(root, '.buck2', 'capability-roots', 'a'.repeat(64)), {
        recursive: true,
      })
      yield* fs.writeFileString(
        NodePath.join(root, '.buck2', 'capability-roots', 'a'.repeat(64), 'sentinel'),
        'ignored by repository identity\n',
      )
    }
  })

const setTreeModes = ({
  root,
  policy,
}: {
  root: string
  policy: 'artifact' | 'source' | 'protected'
}): Effect.Effect<void> =>
  Effect.promise(async () => {
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path)
      if (info.isSymbolicLink() === true) return
      if (info.isDirectory() === true) {
        for (const child of await readdir(path)) await visit(NodePath.join(path, child))
        await chmod(path, policy === 'protected' ? 0o555 : 0o755)
      } else if (info.isFile() === true) {
        const executable = (info.mode & 0o111) !== 0
        await chmod(
          path,
          policy === 'artifact'
            ? executable === true
              ? 0o755
              : 0o644
            : executable === true
              ? 0o555
              : 0o444,
        )
      }
    }
    await visit(root)
  })

const setTreeWritable = (root: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path)
      if (info.isSymbolicLink() === true) return
      if (info.isDirectory() === true) {
        await chmod(path, 0o755)
        for (const child of await readdir(path)) await visit(NodePath.join(path, child))
      } else if (info.isFile() === true) {
        await chmod(path, 0o644)
      }
    }
    await visit(root).catch(() => undefined)
  })

const makeFixture = (
  policy: 'artifact' | 'source' | 'protected',
  options?: { capabilities?: boolean; capabilityRoots?: boolean },
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const parent = yield* makeCanonicalTempDirectoryScoped()
    const root = NodePath.join(parent, 'tree')
    yield* fs.makeDirectory(root, { recursive: true })
    yield* Effect.addFinalizer(() => setTreeWritable(root).pipe(Effect.ignore))
    yield* makeTree({
      root,
      ...(options?.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options?.capabilityRoots === undefined
        ? {}
        : { capabilityRoots: options.capabilityRoots }),
    })
    yield* setTreeModes({ root, policy })
    return root
  })

const makeProtectedTreeAt = (
  path: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path, { recursive: true })
    yield* Effect.addFinalizer(() => setTreeWritable(path).pipe(Effect.ignore))
    yield* makeTree({ root: path })
    yield* setTreeModes({ root: path, policy: 'protected' })
    return path
  })

const makeOwnedFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspaceRoot = yield* makeCanonicalTempDirectoryScoped()
    const member = 'dep'
    const mountPath = NodePath.join(workspaceRoot, 'repos', member)
    yield* fs.makeDirectory(mountPath, { recursive: true })
    yield* Effect.addFinalizer(() => setTreeWritable(mountPath).pipe(Effect.ignore))
    yield* makeTree({ root: mountPath })
    yield* setTreeModes({ root: mountPath, policy: 'protected' })
    const scan = yield* scanR6ProtectedMount({ root: mountPath })
    const expected: OwnedCpAMountExpectedIdentity = {
      member,
      lockedCommit: 'a'.repeat(40),
      sourcePathIdentity: `sha256:${'b'.repeat(64)}`,
      publishedPath: mountPath,
    }
    const metadata = makeOwnedCpAMountMetadata({ ...expected, scan })
    return { workspaceRoot, mountPath, expected, metadata, scan }
  })

const rewriteProtectedFile = ({
  path,
  content,
  mode = 0o444,
}: {
  path: string
  content: string
  mode?: 0o444 | 0o555
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.chmod(path, 0o644)
    yield* fs.writeFileString(path, content)
    yield* fs.chmod(path, mode)
  })

const changeProtectedDirectory = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.chmod(path, 0o755)
    return yield* effect.pipe(Effect.ensuring(fs.chmod(path, 0o555).pipe(Effect.ignore)))
  })

const exchangeDirectories = async ({
  left,
  right,
}: {
  left: string
  right: string
}): Promise<void> => {
  const temporary = `${left}.exchange-test`
  await chmod(left, 0o755)
  await chmod(right, 0o755)
  try {
    await rename(left, temporary)
    await rename(right, left)
    await rename(temporary, right)
  } finally {
    await Promise.all(
      [left, right, temporary].map((path) =>
        chmod(path, 0o555).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== 'ENOENT') throw cause
        }),
      ),
    )
  }
}

describe('R6 source and protected scans', () => {
  it.effect(
    'includes empty directories and preserves executable versus non-executable file modes',
    Effect.fnUntraced(function* () {
      const root = yield* makeFixture('source')
      const scan = yield* scanR6Source({ root: root })
      const byPath = new Map(scan.repository.manifest.entries.map((entry) => [entry.path, entry]))

      expect(byPath.get('empty')).toEqual({
        path: 'empty',
        kind: 'directory',
        mode: 0o555,
        payload: null,
      })
      expect(byPath.get('plain.txt')?.mode).toBe(0o444)
      expect(byPath.get('script.sh')?.mode).toBe(0o555)
      expect(scan.repository.count).toBe(scan.repository.manifest.entries.length)
    }, withNode),
  )

  it.effect(
    'normalizes only source directory 0755 to protected 0555 and yields equal manifests',
    Effect.fnUntraced(function* () {
      const source = yield* makeFixture('source')
      const mount = yield* makeFixture('protected')
      const sourceScan = yield* scanR6Source({ root: source })
      const mountScan = yield* scanR6ProtectedMount({ root: mount })

      expect(sourceScan.repository).toEqual(mountScan.repository)
      expect(sourceScan.capabilities).toEqual(mountScan.capabilities)
    }, withNode),
  )

  it.effect(
    'excludes durable capability roots from protected repository identity',
    Effect.fnUntraced(function* () {
      const unrooted = yield* makeFixture('protected')
      const rooted = yield* makeFixture('protected', { capabilityRoots: true })
      const unrootedScan = yield* scanR6ProtectedMount({ root: unrooted })
      const rootedScan = yield* scanR6ProtectedMount({ root: rooted })

      expect(rootedScan.repository).toEqual(unrootedScan.repository)
      expect(rootedScan.capabilities).toEqual(unrootedScan.capabilities)
      expect(
        rootedScan.repository.manifest.entries.some((entry) =>
          entry.path.startsWith('.buck2/capability-roots'),
        ),
      ).toBe(false)
    }, withNode),
  )

  it.effect(
    'normalizes writable Buck artifact modes into the protected R6 identity',
    Effect.fnUntraced(function* () {
      const artifact = yield* makeFixture('artifact')
      const protectedTree = yield* makeFixture('protected')

      expect(yield* scanR6BuildArtifactTree({ root: artifact })).toEqual(
        yield* scanR6ProtectedTree({ root: protectedTree }),
      )
    }, withNode),
  )

  it.effect(
    'rejects writable source files and source directories not exactly 0755',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const writableFileRoot = yield* makeFixture('source')
      yield* fs.chmod(NodePath.join(writableFileRoot, 'plain.txt'), 0o644)
      const fileResult = yield* scanR6Source({ root: writableFileRoot }).pipe(Effect.result)
      expect(fileResult._tag).toBe('Failure')
      if (fileResult._tag === 'Failure') expect(fileResult.failure.reason).toBe('UnexpectedMode')

      const wrongDirRoot = yield* makeFixture('source')
      yield* fs.chmod(NodePath.join(wrongDirRoot, 'empty'), 0o555)
      const dirResult = yield* scanR6Source({ root: wrongDirRoot }).pipe(Effect.result)
      expect(dirResult._tag).toBe('Failure')
      if (dirResult._tag === 'Failure') expect(dirResult.failure.reason).toBe('UnexpectedMode')
    }, withNode),
  )

  it.effect(
    'rejects protected files or directories with unexpected modes',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeFixture('protected')
      yield* fs.chmod(NodePath.join(root, 'plain.txt'), 0o644)
      const result = yield* scanR6ProtectedMount({ root: root }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('UnexpectedMode')
    }, withNode),
  )

  it.effect(
    'changes repository digest for content, mode, link target, and entry count changes',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeFixture('protected')
      const initial = yield* scanR6ProtectedMount({ root: root })

      yield* rewriteProtectedFile({ path: NodePath.join(root, 'plain.txt'), content: 'changed\n' })
      const content = yield* scanR6ProtectedMount({ root: root })
      expect(content.repository.digest).not.toBe(initial.repository.digest)

      yield* fs.chmod(NodePath.join(root, 'plain.txt'), 0o555)
      const mode = yield* scanR6ProtectedMount({ root: root })
      expect(mode.repository.digest).not.toBe(content.repository.digest)

      yield* changeProtectedDirectory(
        NodePath.join(root, 'dir'),
        Effect.gen(function* () {
          yield* fs.remove(NodePath.join(root, 'dir', 'safe-link'))
          yield* fs.symlink('../script.sh', NodePath.join(root, 'dir', 'safe-link'))
        }),
      )
      const link = yield* scanR6ProtectedMount({ root: root })
      expect(link.repository.digest).not.toBe(mode.repository.digest)

      yield* changeProtectedDirectory(
        root,
        Effect.gen(function* () {
          yield* fs.makeDirectory(NodePath.join(root, 'another-empty'))
          yield* fs.chmod(NodePath.join(root, 'another-empty'), 0o555)
        }),
      )
      const count = yield* scanR6ProtectedMount({ root: root })
      expect(count.repository.count).toBe(link.repository.count + 1)
      expect(count.repository.digest).not.toBe(link.repository.digest)
    }, withNode),
  )

  it.effect(
    'excludes .buck2/capabilities from repository identity and binds it separately',
    Effect.fnUntraced(function* () {
      const root = yield* makeFixture('protected')
      const before = yield* scanR6ProtectedMount({ root: root })
      yield* rewriteProtectedFile({
        path: NodePath.join(root, '.buck2', 'capabilities', 'defs.bzl'),
        content: 'TOOLS = {"changed": True}\n',
      })
      const after = yield* scanR6ProtectedMount({ root: root })

      expect(after.repository).toEqual(before.repository)
      expect(after.capabilities.present).toBe(true)
      expect(after.capabilities.digest).not.toBe(before.capabilities.digest)
      expect(
        after.repository.manifest.entries.some((entry) =>
          entry.path.startsWith('.buck2/capabilities'),
        ),
      ).toBe(false)
    }, withNode),
  )

  it.effect(
    'excludes only declared overlay subtrees while binding protected content separately',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeFixture('protected')
      const declaredOverlays = [{ target: '//pkg:dist', destination: 'dir/dist' }] as const
      const before = yield* scanR6ProtectedMount({ root, declaredOverlays })
      expect(before.overlays).toHaveLength(1)
      expect(before.overlays[0]?.present).toBe(false)

      yield* changeProtectedDirectory(
        NodePath.join(root, 'dir'),
        Effect.gen(function* () {
          const destination = NodePath.join(root, 'dir', 'dist')
          yield* fs.makeDirectory(destination)
          yield* fs.writeFileString(NodePath.join(destination, 'bundle.js'), 'one\n')
          yield* fs.chmod(NodePath.join(destination, 'bundle.js'), 0o444)
          yield* fs.chmod(destination, 0o555)
        }),
      )
      const published = yield* scanR6ProtectedMount({ root, declaredOverlays })
      expect(published.repository).toEqual(before.repository)
      expect(published.overlays[0]?.present).toBe(true)
      expect(published.overlays[0]?.count).toBe(1)
      expect(
        published.repository.manifest.entries.some((entry) => entry.path.startsWith('dir/dist')),
      ).toBe(false)

      yield* rewriteProtectedFile({
        path: NodePath.join(root, 'dir', 'dist', 'bundle.js'),
        content: 'two\n',
      })
      const changed = yield* scanR6ProtectedMount({ root, declaredOverlays })
      expect(changed.repository).toEqual(before.repository)
      expect(changed.overlays[0]?.digest).not.toBe(published.overlays[0]?.digest)
    }, withNode),
  )

  it.effect(
    'requires immutable source trees to omit every declared overlay destination',
    Effect.fnUntraced(function* () {
      const root = yield* makeFixture('source')
      const result = yield* scanR6Source({
        root,
        declaredOverlays: [{ target: '//pkg:dist', destination: 'dir' }],
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('PathCollision')
    }, withNode),
  )

  it.effect(
    'distinguishes a missing capability tree from a present empty tree',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const missingRoot = yield* makeFixture('protected', { capabilities: false })
      const presentRoot = yield* makeFixture('protected', { capabilities: false })
      yield* changeProtectedDirectory(
        presentRoot,
        Effect.gen(function* () {
          yield* fs.makeDirectory(NodePath.join(presentRoot, '.buck2', 'capabilities'), {
            recursive: true,
          })
          yield* fs.chmod(NodePath.join(presentRoot, '.buck2'), 0o555)
          yield* fs.chmod(NodePath.join(presentRoot, '.buck2', 'capabilities'), 0o555)
        }),
      )

      const missing = yield* scanR6ProtectedMount({ root: missingRoot })
      const present = yield* scanR6ProtectedMount({ root: presentRoot })
      expect(missing.capabilities.present).toBe(false)
      expect(present.capabilities.present).toBe(true)
      expect(missing.capabilities.digest).toBe(present.capabilities.digest)
    }, withNode),
  )

  it.effect(
    'rejects case-colliding paths and forbidden symlinks during a real scan',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const collision = yield* makeFixture('source')
      yield* fs.writeFileString(NodePath.join(collision, 'Readme'), 'a')
      yield* fs.writeFileString(NodePath.join(collision, 'README'), 'b')
      yield* fs.chmod(NodePath.join(collision, 'Readme'), 0o444)
      yield* fs.chmod(NodePath.join(collision, 'README'), 0o444)
      const [readme, uppercaseReadme] = yield* Effect.promise(() =>
        Promise.all([
          lstat(NodePath.join(collision, 'Readme')),
          lstat(NodePath.join(collision, 'README')),
        ]),
      )
      if (readme.dev !== uppercaseReadme.dev || readme.ino !== uppercaseReadme.ino) {
        const collisionResult = yield* scanR6Source({ root: collision }).pipe(Effect.result)
        expect(collisionResult._tag).toBe('Failure')
        if (collisionResult._tag === 'Failure')
          expect(collisionResult.failure.reason).toBe('PathCollision')
      }

      const forbidden = yield* makeFixture('source')
      yield* fs.symlink('../../escape', NodePath.join(forbidden, 'dir', 'escape-link'))
      const linkResult = yield* scanR6Source({ root: forbidden }).pipe(Effect.result)
      expect(linkResult._tag).toBe('Failure')
      if (linkResult._tag === 'Failure') expect(linkResult.failure.reason).toBe('ForbiddenSymlink')
    }, withNode),
  )

  it.effect(
    'rejects filesystem special files',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeFixture('protected')
      const socketPath = NodePath.join(root, 'special.sock')
      const server = createServer()
      yield* fs.chmod(root, 0o755)
      yield* Effect.callback<void>((resume) => {
        server.once('error', (cause) => resume(Effect.die(cause)))
        server.listen(socketPath, () => resume(Effect.void))
      })
      yield* fs.chmod(root, 0o555)
      const result = yield* scanR6ProtectedMount({ root: root }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('SpecialFile')
      yield* closeServer(server)
      yield* Effect.promise(() => unlink(socketPath).catch(() => undefined))
    }, withNode),
  )
  it.effect(
    'admits only existing absolute links whose realpath is inside a valid Nix store object',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const actualStoreTarget = yield* Effect.promise(() => realpath(process.execPath))
      expect(actualStoreTarget).toMatch(
        /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/.*)?$/u,
      )
      const admitted = yield* makeFixture('source')
      yield* fs.symlink(actualStoreTarget, NodePath.join(admitted, 'store-tool'))
      const admittedScan = yield* scanR6Source({ root: admitted })
      expect(
        admittedScan.repository.manifest.entries.some((entry) => entry.path === 'store-tool'),
      ).toBe(true)

      const nonexistent = yield* makeFixture('source')
      yield* fs.symlink(
        `/nix/store/${'0'.repeat(32)}-missing-object/bin/tool`,
        NodePath.join(nonexistent, 'store-tool'),
      )
      const nonexistentResult = yield* scanR6Source({ root: nonexistent }).pipe(Effect.result)
      expect(nonexistentResult._tag).toBe('Failure')
      if (nonexistentResult._tag === 'Failure') {
        expect(nonexistentResult.failure.reason).toBe('ForbiddenSymlink')
      }

      const invalidObject = yield* makeFixture('source')
      yield* fs.symlink(
        '/nix/store/not-a-valid-object/bin/tool',
        NodePath.join(invalidObject, 'store-tool'),
      )
      const invalidResult = yield* scanR6Source({ root: invalidObject }).pipe(Effect.result)
      expect(invalidResult._tag).toBe('Failure')
      if (invalidResult._tag === 'Failure') {
        expect(invalidResult.failure.reason).toBe('ForbiddenSymlink')
      }
    }, withNode),
  )

  it.effect(
    'rejects a deterministic A/B directory exchange during a scan',
    Effect.fnUntraced(function* () {
      const original = yield* makeFixture('protected')
      const replacement = yield* makeProtectedTreeAt(`${original}.replacement`)
      const result = yield* scanR6ProtectedMount({
        root: original,
        hooks: {
          afterInitialRootIdentity: () =>
            exchangeDirectories({ left: original, right: replacement }),
        },
      }).pipe(Effect.result)

      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toMatchObject({
          reason: 'InvalidRoot',
          message: expect.stringContaining('identity changed'),
        })
      }
    }, withNode),
  )
})

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void))
  })

describe('owned cp-a metadata and inspection', () => {
  it.effect(
    'atomically writes and strictly reads metadata with no temporary sibling',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeOwnedFixture()
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      const decoded = yield* readOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.expected.member,
        publishedPath: fixture.mountPath,
      })
      expect(decoded).toEqual(fixture.metadata)

      const metadataPath = ownedCpAMountMetadataPath({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.expected.member,
      })
      expect(
        (yield* fs.readDirectory(NodePath.dirname(metadataPath))).filter((name) =>
          name.includes('.tmp-'),
        ),
      ).toEqual([])
    }, withNode),
  )

  it.effect(
    'rejects a metadata published-path mismatch on read',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      const result = yield* readOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.expected.member,
        publishedPath: `${fixture.mountPath}-other`,
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('OwnedCpAMountMetadataError')
      }
    }, withNode),
  )

  it.effect(
    'returns Owned only after identity and both fresh manifests match',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      const result = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(result._tag).toBe('Owned')
    }, withNode),
  )

  it.effect(
    'keeps a real directory with missing metadata as loud InvalidOwned',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      const result = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(result).toMatchObject({ _tag: 'InvalidOwned', reason: 'MetadataMissing' })
    }, withNode),
  )

  it.effect(
    'rejects corrupt and unknown-field metadata',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeOwnedFixture()
      const metadataPath = ownedCpAMountMetadataPath({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.expected.member,
      })
      yield* fs.makeDirectory(NodePath.dirname(metadataPath), { recursive: true })
      yield* fs.writeFileString(metadataPath, '{"version":1,"unknown":true}\n')
      const corrupt = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(corrupt).toMatchObject({ _tag: 'InvalidOwned', reason: 'MetadataInvalid' })

      yield* fs.writeFileString(
        metadataPath,
        encodeOwnedCpAMountMetadata(fixture.metadata).replace(/\}\n$/u, ',  "unknown": true\n}\n'),
      )
      const unknown = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(unknown).toMatchObject({ _tag: 'InvalidOwned', reason: 'MetadataInvalid' })
    }, withNode),
  )

  it.effect(
    'rejects stale commit and wrong member metadata identities',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeOwnedFixture()
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      const stale = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: { ...fixture.expected, lockedCommit: 'c'.repeat(40) },
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(stale).toMatchObject({ _tag: 'InvalidOwned', reason: 'IdentityMismatch' })

      const metadataPath = ownedCpAMountMetadataPath({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.expected.member,
      })
      yield* fs.writeFileString(
        metadataPath,
        encodeOwnedCpAMountMetadata(fixture.metadata).replace(
          '"member": "dep"',
          '"member": "other"',
        ),
      )
      const wrongMember = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(wrongMember).toMatchObject({ _tag: 'InvalidOwned', reason: 'MetadataInvalid' })
    }, withNode),
  )

  it.effect(
    'rejects foreign replacement content and capability tampering against stale metadata',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      yield* rewriteProtectedFile({
        path: NodePath.join(fixture.mountPath, 'plain.txt'),
        content: 'foreign replacement\n',
      })
      const replacement = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(replacement).toMatchObject({ _tag: 'InvalidOwned', reason: 'ManifestMismatch' })

      yield* rewriteProtectedFile({
        path: NodePath.join(fixture.mountPath, 'plain.txt'),
        content: 'plain\n',
      })
      yield* rewriteProtectedFile({
        path: NodePath.join(fixture.mountPath, '.buck2', 'capabilities', 'defs.bzl'),
        content: 'tampered = True\n',
      })
      const capabilities = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: fixture.mountPath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(capabilities).toMatchObject({ _tag: 'InvalidOwned', reason: 'ManifestMismatch' })
    }, withNode),
  )

  it.effect(
    'preserves S0 Missing and Symlink classifications without treating them as owned',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const workspaceRoot = yield* makeCanonicalTempDirectoryScoped()
      const expected = {
        member: 'dep',
        lockedCommit: 'a'.repeat(40),
        sourcePathIdentity: `sha256:${'b'.repeat(64)}`,
        publishedPath: NodePath.join(workspaceRoot, 'repos', 'dep'),
      }
      const missing = yield* inspectOwnedCpAMount({
        workspaceRoot,
        physicalPath: expected.publishedPath,
        expected,
        expectedPreExchangeIdentity: { dev: 0, ino: 0 },
      })
      expect(missing).toEqual({ _tag: 'Missing' })

      yield* fs.makeDirectory(NodePath.dirname(expected.publishedPath), { recursive: true })
      yield* fs.symlink('/nix/store/target', expected.publishedPath)
      const symlink = yield* inspectOwnedCpAMount({
        workspaceRoot,
        physicalPath: expected.publishedPath,
        expected,
        expectedPreExchangeIdentity: { dev: 0, ino: 0 },
      })
      expect(symlink).toEqual({ _tag: 'Symlink', target: '/nix/store/target' })
    }, withNode),
  )

  it.effect(
    'rechecks the exact inode under the lifecycle seam and rejects replacement before authorization',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      expect(
        yield* assertOwnedCpAMountIdentity({
          path: fixture.mountPath,
          expected: fixture.scan.identity,
        }),
      ).toEqual(fixture.scan.identity)

      const replacement = yield* makeProtectedTreeAt(`${fixture.mountPath}.replacement`)
      const replaced = yield* assertOwnedCpAMountIdentity({
        path: fixture.mountPath,
        expected: fixture.scan.identity,
        hooks: {
          beforeLstat: () => exchangeDirectories({ left: fixture.mountPath, right: replacement }),
        },
      }).pipe(Effect.result)
      expect(replaced._tag).toBe('Failure')
      if (replaced._tag === 'Failure') {
        expect(replaced.failure._tag).toBe('OwnedCpAMountIdentityError')
      }
    }, withNode),
  )

  it.effect(
    'authorizes a swapped-old A at its staging path and refuses a foreign inode replacement',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeOwnedFixture()
      const stagePath = yield* makeProtectedTreeAt(`${fixture.mountPath}.stage`)
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        metadata: fixture.metadata,
      })
      yield* Effect.promise(() =>
        exchangeDirectories({ left: fixture.mountPath, right: stagePath }),
      )

      const swappedOld = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: stagePath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(swappedOld).toMatchObject({
        _tag: 'Owned',
        identity: fixture.scan.identity,
      })

      const foreign = yield* makeProtectedTreeAt(`${fixture.mountPath}.foreign`)
      yield* Effect.promise(() => exchangeDirectories({ left: stagePath, right: foreign }))
      const refused = yield* inspectOwnedCpAMount({
        workspaceRoot: fixture.workspaceRoot,
        physicalPath: stagePath,
        expected: fixture.expected,
        expectedPreExchangeIdentity: fixture.scan.identity,
      })
      expect(refused).toMatchObject({
        _tag: 'InvalidOwned',
        reason: 'MountIdentityMismatch',
      })
    }, withNode),
  )

  it.effect(
    'computes a stable source-path identity from realpath aliases',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const parent = yield* makeCanonicalTempDirectoryScoped()
      const source = NodePath.join(parent, 'source')
      const alias = NodePath.join(parent, 'alias')
      yield* fs.makeDirectory(source)
      yield* fs.symlink(source, alias)
      expect(yield* computeR6SourcePathIdentity(alias)).toBe(
        yield* computeR6SourcePathIdentity(source),
      )
    }, withNode),
  )
})
