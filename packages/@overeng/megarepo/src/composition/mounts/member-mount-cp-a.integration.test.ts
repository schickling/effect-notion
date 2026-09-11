import { spawn } from 'node:child_process'
import { constants, watch } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Fiber, type Scope } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import { expect } from 'vitest'

import { resolvePinnedCoreutils } from '../../test-utils/coreutils.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import { publishDistOverlay } from '../overlays/dist-overlay-lifecycle.ts'
import {
  cpAMemberMountDestinationPath,
  cpAMemberMountTransactionPath,
  type CpAMemberMountRequest,
} from './member-mount-cp-a-schema.ts'
import {
  materializeCpAMemberMount,
  recoverCpAMemberMount,
  teardownCpAMemberMount,
  type CpAMemberMountRuntime,
} from './member-mount-cp-a.ts'
import { ownedCpAMountMetadataPath, readOwnedCpAMountMetadata } from './member-mount-r6.ts'

const withNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const forceRemoveTree = (root: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path)
      if (info.isSymbolicLink() === true || info.isDirectory() === false) return
      await chmod(path, 0o755)
      const children = await readdir(path)
      const visitChild = async (index: number): Promise<void> => {
        const child = children[index]
        if (child === undefined) return
        await visit(NodePath.join(path, child))
        return visitChild(index + 1)
      }
      await visitChild(0)
    }
    await visit(root).catch(() => undefined)
  })

interface Fixture {
  readonly workspaceRoot: string
  readonly sourceA: string
  readonly sourceB: string
  readonly capabilities: string
  readonly cpPath: string
  readonly mvPath: string
  readonly member: string
  readonly destinationPath: string
  readonly transactionPath: string
}

const writeSource = ({ root, version }: { root: string; version: string }): Effect.Effect<void> =>
  Effect.promise(async () => {
    await mkdir(NodePath.join(root, 'dir', 'empty'), { recursive: true })
    await mkdir(NodePath.join(root, '.buck2', 'capabilities'), { recursive: true })
    await writeFile(NodePath.join(root, 'version.txt'), `${version}\n`)
    await writeFile(NodePath.join(root, 'version-left.txt'), `${version}\n`)
    await writeFile(NodePath.join(root, 'version-right.txt'), `${version}\n`)
    await writeFile(NodePath.join(root, 'dir', 'data.txt'), `data-${version}\n`)
    await writeFile(NodePath.join(root, 'run.sh'), '#!/bin/sh\nexit 0\n')
    await writeFile(NodePath.join(root, '.buck2', 'capabilities', 'stale.bzl'), 'STALE = True\n')
    await symlink('dir/data.txt', NodePath.join(root, 'literal-link'))
    await chmod(NodePath.join(root, 'version.txt'), 0o444)
    await chmod(NodePath.join(root, 'version-left.txt'), 0o444)
    await chmod(NodePath.join(root, 'version-right.txt'), 0o444)
    await chmod(NodePath.join(root, 'dir', 'data.txt'), 0o444)
    await chmod(NodePath.join(root, 'run.sh'), 0o555)
    await chmod(NodePath.join(root, '.buck2', 'capabilities', 'stale.bzl'), 0o444)
  })

const makeFixture = (): Effect.Effect<
  Fixture,
  PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeCanonicalTempDirectoryScoped()
    yield* Effect.addFinalizer(() => forceRemoveTree(workspaceRoot))
    const sourceA = NodePath.join(workspaceRoot, 'store-a')
    const sourceB = NodePath.join(workspaceRoot, 'store-b')
    const capabilities = NodePath.join(workspaceRoot, 'capabilities')
    yield* Effect.promise(async () => {
      await mkdir(NodePath.join(workspaceRoot, 'repos'), { recursive: true })
      await mkdir(sourceA, { recursive: true })
      await mkdir(sourceB, { recursive: true })
      await mkdir(NodePath.join(capabilities, 'nested'), { recursive: true })
      await writeFile(NodePath.join(capabilities, 'defs.bzl'), 'CAP = "projected"\n')
      await writeFile(NodePath.join(capabilities, 'nested', 'tool.bzl'), 'TOOL = True\n')
      await chmod(NodePath.join(capabilities, 'defs.bzl'), 0o444)
      await chmod(NodePath.join(capabilities, 'nested', 'tool.bzl'), 0o444)
    })
    yield* writeSource({ root: sourceA, version: 'A' })
    yield* writeSource({ root: sourceB, version: 'B' })
    const { cpPath, mvPath } = yield* Effect.promise(() => resolvePinnedCoreutils())
    const member = 'dep'
    return {
      workspaceRoot,
      sourceA,
      sourceB,
      capabilities,
      cpPath,
      mvPath,
      member,
      destinationPath: cpAMemberMountDestinationPath({ workspaceRoot, member }),
      transactionPath: cpAMemberMountTransactionPath({ workspaceRoot, member }),
    }
  })

const requestFor = ({
  fixture,
  sourcePath,
  lockedCommit,
  dryRun = false,
  allowVerifiedDarwinAdvance = false,
  distOverlays = [],
}: {
  fixture: Fixture
  sourcePath: string
  lockedCommit: string
  dryRun?: boolean
  allowVerifiedDarwinAdvance?: boolean
  distOverlays?: CpAMemberMountRequest['distOverlays']
}): CpAMemberMountRequest => ({
  workspaceRoot: fixture.workspaceRoot,
  member: fixture.member,
  sourcePath,
  capabilitiesPath: fixture.capabilities,
  distOverlays,
  lockedCommit,
  dryRun,
  allowVerifiedDarwinAdvance,
})

const runtimeFor = (
  fixture: Fixture,
  options: Partial<CpAMemberMountRuntime> = {},
): CpAMemberMountRuntime => ({
  cpPath: fixture.cpPath,
  mvPath: fixture.mvPath,
  platform: 'linux',
  nonce: () => 'test',
  capabilityCheck: async ({ capabilitiesPath }) => {
    const value = await readFile(NodePath.join(capabilitiesPath, 'defs.bzl'), 'utf8')
    if (value !== 'CAP = "projected"\n') throw new Error('wrong capability projection')
  },
  ...options,
})

const firstPublish = (fixture: Fixture, options: Partial<CpAMemberMountRuntime> = {}) =>
  materializeCpAMemberMount({
    request: requestFor({ fixture, sourcePath: fixture.sourceA, lockedCommit: 'a'.repeat(40) }),
    runtime: runtimeFor(fixture, options),
  })

const advance = (fixture: Fixture, options: Partial<CpAMemberMountRuntime> = {}) =>
  materializeCpAMemberMount({
    request: requestFor({ fixture, sourcePath: fixture.sourceB, lockedCommit: 'b'.repeat(40) }),
    runtime: runtimeFor(fixture, options),
  })

const pathExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(async () =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  )

const exchange = ({
  mvPath,
  left,
  right,
}: {
  mvPath: string
  left: string
  right: string
}): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(mvPath, ['-T', '--exchange', '--no-copy', left, right], {
          stdio: 'ignore',
        })
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`mv exited ${String(code)}`)),
        )
      }),
  )

const makeModeCheckingMv = ({
  fixture,
  name,
  exitCode,
}: {
  fixture: Fixture
  name: string
  exitCode?: number
}): Effect.Effect<{ readonly mvPath: string; readonly observationsPath: string }> =>
  Effect.promise(async () => {
    const mvPath = NodePath.join(fixture.workspaceRoot, `mv-mode-check-${name}`)
    const observationsPath = `${mvPath}.observations`
    const encodedMvPath = Buffer.from(fixture.mvPath).toString('base64')
    const script = [
      `#!${process.execPath}`,
      `const { appendFileSync, existsSync, statSync } = require('node:fs')`,
      `const { spawnSync } = require('node:child_process')`,
      `const mvPath = Buffer.from('${encodedMvPath}', 'base64').toString()`,
      `const operands = process.argv.slice(-2).filter((path) => existsSync(path))`,
      `const modes = operands.map((path) => statSync(path).mode & 0o777)`,
      `appendFileSync(__filename + '.observations', modes.join(',') + '\\n')`,
      `if (modes.length === 0 || modes.some((mode) => mode !== 0o755)) process.exit(91)`,
      exitCode === undefined
        ? `const result = spawnSync(mvPath, process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 1)`
        : `process.exit(${String(exitCode)})`,
      '',
    ].join('\n')
    await writeFile(mvPath, script)
    await chmod(mvPath, 0o755)
    return { mvPath, observationsPath }
  })

const modeOf = (path: string): Effect.Effect<number> =>
  Effect.promise(async () => (await lstat(path)).mode & 0o777)

const stagePath = (fixture: Fixture): string =>
  NodePath.join(NodePath.dirname(fixture.destinationPath), '.mr-stage-v1-646570-test')

describe('cp-a member mount lifecycle', () => {
  it.effect(
    'initializes declared overlays as strictly unpublished metadata without changing cp-a content',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const declaredOverlays = [{ target: '//pkg:dist', destination: 'dir/dist' }] as const
      const result = yield* materializeCpAMemberMount({
        request: requestFor({
          fixture,
          sourcePath: fixture.sourceA,
          lockedCommit: 'a'.repeat(40),
          distOverlays: declaredOverlays,
        }),
        runtime: runtimeFor(fixture),
      })
      expect(result._tag).toBe('Published')
      const metadata = yield* readOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.member,
        publishedPath: fixture.destinationPath,
      })
      expect(metadata.version).toBe(2)
      expect(metadata.declaredOverlays).toEqual(declaredOverlays)
      expect(metadata.overlays).toEqual([])
      expect(yield* pathExists(NodePath.join(fixture.destinationPath, 'dir', 'dist'))).toBe(false)
    }, withNode),
  )

  it.effect(
    'preserves validated published overlays when the immutable mount authority is unchanged',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const declaration = { target: '//pkg:dist', destination: 'dir/dist' } as const
      const mountRequest = requestFor({
        fixture,
        sourcePath: fixture.sourceA,
        lockedCommit: 'a'.repeat(40),
        distOverlays: [declaration],
      })
      const mounted = yield* materializeCpAMemberMount({
        request: mountRequest,
        runtime: runtimeFor(fixture),
      })
      expect(mounted._tag).toBe('Published')
      if (mounted._tag !== 'Published') return

      const artifactPath = NodePath.join(fixture.workspaceRoot, 'artifact')
      yield* Effect.promise(async () => {
        await mkdir(artifactPath)
        await writeFile(NodePath.join(artifactPath, 'bundle.js'), 'built\n')
        await chmod(NodePath.join(artifactPath, 'bundle.js'), 0o444)
      })
      const mountInfo = yield* Effect.promise(() => lstat(fixture.destinationPath))
      const overlay = yield* publishDistOverlay({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          expectedMountIdentity: { dev: mountInfo.dev, ino: mountInfo.ino },
          expectedMetadata: mounted.metadata,
          target: declaration.target,
          destination: declaration.destination,
          artifactPath,
          cpPath: fixture.cpPath,
          mvPath: fixture.mvPath,
          dryRun: false,
        },
        runtime: {
          assertUpdateLockOwned: async () => undefined,
          nonce: () => 'mount-current',
        },
      })
      expect(overlay._tag).toBe('Published')
      if (overlay._tag !== 'Published') return

      const repeated = yield* materializeCpAMemberMount({
        request: mountRequest,
        runtime: runtimeFor(fixture),
      })
      expect(repeated._tag).toBe('AlreadyCurrent')
      if (repeated._tag !== 'AlreadyCurrent') return
      expect(repeated.metadata).toEqual(overlay.metadata)
      expect(
        yield* Effect.promise(() =>
          readFile(
            NodePath.join(fixture.destinationPath, declaration.destination, 'bundle.js'),
            'utf8',
          ),
        ),
      ).toBe('built\n')
    }, withNode),
  )

  it.effect(
    'first-publishes independent protected inodes, literal symlinks, and replaced capabilities without touching source',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const sourceInfoBefore = yield* Effect.promise(() =>
        lstat(NodePath.join(fixture.sourceA, 'version.txt')),
      )
      const sourceModeBefore = sourceInfoBefore.mode & 0o777
      const sourceContentBefore = yield* Effect.promise(() =>
        readFile(NodePath.join(fixture.sourceA, 'version.txt'), 'utf8'),
      )

      const result = yield* firstPublish(fixture)
      expect(result._tag).toBe('Published')
      const sourceInfoAfter = yield* Effect.promise(() =>
        lstat(NodePath.join(fixture.sourceA, 'version.txt')),
      )
      const mountedInfo = yield* Effect.promise(() =>
        lstat(NodePath.join(fixture.destinationPath, 'version.txt')),
      )
      expect({
        dev: sourceInfoAfter.dev,
        ino: sourceInfoAfter.ino,
        mode: sourceInfoAfter.mode & 0o777,
      }).toEqual({
        dev: sourceInfoBefore.dev,
        ino: sourceInfoBefore.ino,
        mode: sourceModeBefore,
      })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.sourceA, 'version.txt'), 'utf8'),
        ),
      ).toBe(sourceContentBefore)
      expect(mountedInfo.ino).not.toBe(sourceInfoAfter.ino)
      expect(mountedInfo.mode & 0o777).toBe(0o444)
      expect(
        (yield* Effect.promise(() => lstat(NodePath.join(fixture.destinationPath, 'dir')))).mode &
          0o777,
      ).toBe(0o555)
      expect(
        yield* Effect.promise(() =>
          readlink(NodePath.join(fixture.destinationPath, 'literal-link')),
        ),
      ).toBe('dir/data.txt')
      expect(
        yield* Effect.promise(() =>
          readFile(
            NodePath.join(fixture.destinationPath, '.buck2', 'capabilities', 'defs.bzl'),
            'utf8',
          ),
        ),
      ).toBe('CAP = "projected"\n')
      expect(
        yield* pathExists(
          NodePath.join(fixture.destinationPath, '.buck2', 'capabilities', 'stale.bzl'),
        ),
      ).toBe(false)
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
      expect(
        yield* pathExists(
          ownedCpAMountMetadataPath({
            workspaceRoot: fixture.workspaceRoot,
            member: fixture.member,
          }),
        ),
      ).toBe(true)
    }, withNode),
  )

  it.effect(
    'makes only identity-bound Darwin rename roots writable and re-protects first-publish and exchange results',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const checkedMv = yield* makeModeCheckingMv({ fixture, name: 'success' })

      const published = yield* firstPublish(fixture, {
        mvPath: checkedMv.mvPath,
        platform: 'darwin',
      })
      expect(published).toMatchObject({ _tag: 'Published', operation: 'FirstPublish' })
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)

      const advanced = yield* materializeCpAMemberMount({
        request: requestFor({
          fixture,
          sourcePath: fixture.sourceB,
          lockedCommit: 'b'.repeat(40),
          allowVerifiedDarwinAdvance: true,
        }),
        runtime: runtimeFor(fixture, {
          mvPath: checkedMv.mvPath,
          platform: 'darwin',
        }),
      })
      expect(advanced).toMatchObject({ _tag: 'Published', operation: 'Advance' })
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      expect(yield* Effect.promise(() => readFile(checkedMv.observationsPath, 'utf8'))).toBe(
        '493\n493,493\n',
      )
    }, withNode),
  )

  it.effect(
    'converts a legacy symlink by exchange and removes only the link, never its target',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const target = NodePath.join(fixture.workspaceRoot, 'legacy-target')
      yield* Effect.promise(async () => {
        await mkdir(target)
        await writeFile(NodePath.join(target, 'keep.txt'), 'keep\n')
        await symlink(target, fixture.destinationPath)
      })

      const result = yield* firstPublish(fixture)
      expect(result._tag).toBe('Published')
      if (result._tag === 'Published') expect(result.operation).toBe('LegacyConversion')
      expect((yield* Effect.promise(() => lstat(fixture.destinationPath))).isDirectory()).toBe(true)
      expect(yield* Effect.promise(() => readFile(NodePath.join(target, 'keep.txt'), 'utf8'))).toBe(
        'keep\n',
      )
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
    }, withNode),
  )

  for (const racedDestination of ['regular file', 'symlink', 'empty directory'] as const) {
    it.effect(
      `does not replace a raced ${racedDestination} during first publish`,
      Effect.fnUntraced(function* () {
        const fixture = yield* makeFixture()
        const raceTarget = NodePath.join(fixture.workspaceRoot, `race-target-${racedDestination}`)
        const result = yield* firstPublish(fixture, {
          beforeFirstPublish: async ({ destinationPath }) => {
            if (racedDestination === 'regular file') {
              await writeFile(destinationPath, 'racer\n')
            } else if (racedDestination === 'symlink') {
              await mkdir(raceTarget)
              await symlink(raceTarget, destinationPath)
            } else {
              await mkdir(destinationPath)
            }
          },
        }).pipe(Effect.result)

        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure.reason).toBe('DestinationRefused')
        expect(
          yield* Effect.promise(() =>
            readFile(NodePath.join(stagePath(fixture), 'version.txt'), 'utf8'),
          ),
        ).toBe('A\n')
        expect(yield* pathExists(fixture.transactionPath)).toBe(true)
        if (racedDestination === 'regular file') {
          expect(yield* Effect.promise(() => readFile(fixture.destinationPath, 'utf8'))).toBe(
            'racer\n',
          )
        } else if (racedDestination === 'symlink') {
          expect(yield* Effect.promise(() => readlink(fixture.destinationPath))).toBe(raceTarget)
        } else {
          expect((yield* Effect.promise(() => lstat(fixture.destinationPath))).isDirectory()).toBe(
            true,
          )
          expect(yield* Effect.promise(() => readdir(fixture.destinationPath))).toEqual([])
        }
      }, withNode),
    )
  }

  it.effect.skipIf(process.platform !== 'linux')(
    'advances A to B atomically while live readers sample only whole states',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      const samples = new Set<string>()
      let reading = true
      let resolveFirstSample!: () => void
      let resolveBPair!: () => void
      const firstSample = new Promise<void>((resolve) => {
        resolveFirstSample = resolve
      })
      const bPair = new Promise<void>((resolve) => {
        resolveBPair = resolve
      })
      const reader = (async () => {
        while (reading === true) {
          const directory = await open(
            fixture.destinationPath,
            constants.O_RDONLY | constants.O_DIRECTORY,
          )
          try {
            const directoryFdPath = `/proc/self/fd/${directory.fd}`
            const [left, right] = await Promise.all([
              readFile(NodePath.join(directoryFdPath, 'version-left.txt'), 'utf8'),
              readFile(NodePath.join(directoryFdPath, 'version-right.txt'), 'utf8'),
            ])
            const pair = `${left.trim()}:${right.trim()}`
            samples.add(pair)
            resolveFirstSample()
            if (pair === 'B:B') resolveBPair()
          } finally {
            await directory.close()
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      })()
      yield* Effect.promise(() => firstSample)
      const result = yield* advance(fixture)
      yield* Effect.promise(() => bPair)
      reading = false
      yield* Effect.promise(() => reader)

      expect(result._tag).toBe('Published')
      if (result._tag === 'Published') expect(result.operation).toBe('Advance')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
      expect([...samples].every((sample) => sample === 'A:A' || sample === 'B:B')).toBe(true)
      expect(samples.has('A:A')).toBe(true)
      expect(samples.has('B:B')).toBe(true)
      const metadata = yield* readOwnedCpAMountMetadata({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.member,
        publishedPath: fixture.destinationPath,
      })
      expect(metadata.lockedCommit).toBe('b'.repeat(40))
    }, withNode),
  )

  it.effect.skipIf(process.platform !== 'linux')(
    'notifies a root-scoped live observer when an owned mount advances',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      const observed = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const observer = watch(NodePath.join(fixture.workspaceRoot, 'repos'))
          const event = new Promise<{ eventType: string; filename: string }>((resolve, reject) => {
            observer.on('change', (eventType, filename) => {
              if (filename?.toString() !== fixture.member) return
              resolve({ eventType, filename: filename.toString() })
            })
            observer.once('error', reject)
          })
          return { observer, event }
        }),
        ({ observer }) => Effect.sync(() => observer.close()),
      )

      const result = yield* advance(fixture)
      expect(result._tag).toBe('Published')
      expect(yield* Effect.promise(() => observed.event)).toEqual({
        eventType: 'rename',
        filename: fixture.member,
      })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
    }, withNode),
  )

  it.effect(
    'refuses a dirty owned mount and preserves it',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      const path = NodePath.join(fixture.destinationPath, 'version.txt')
      yield* Effect.promise(async () => {
        await chmod(path, 0o644)
        await writeFile(path, 'DIRTY\n')
        await chmod(path, 0o444)
      })
      const result = yield* advance(fixture).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('DestinationRefused')
      expect(yield* Effect.promise(() => readFile(path, 'utf8'))).toBe('DIRTY\n')
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
    }, withNode),
  )

  it.effect(
    'tears down only a freshly verified owned directory and leaves source and external symlink targets untouched',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      const external = NodePath.join(fixture.workspaceRoot, 'external')
      yield* Effect.promise(async () => {
        await mkdir(external)
        await writeFile(NodePath.join(external, 'keep.txt'), 'keep\n')
        await chmod(fixture.destinationPath, 0o755)
        await symlink(external, NodePath.join(fixture.destinationPath, 'external-link'))
        await chmod(fixture.destinationPath, 0o555)
      })
      // The added link changes R6, so teardown must refuse until the owned state is restored.
      const refused = yield* teardownCpAMemberMount({
        request: { workspaceRoot: fixture.workspaceRoot, member: fixture.member, dryRun: false },
      }).pipe(Effect.result)
      expect(refused._tag).toBe('Failure')
      yield* Effect.promise(async () => {
        await chmod(fixture.destinationPath, 0o755)
        await unlink(NodePath.join(fixture.destinationPath, 'external-link'))
        await chmod(fixture.destinationPath, 0o555)
      })
      const result = yield* teardownCpAMemberMount({
        request: { workspaceRoot: fixture.workspaceRoot, member: fixture.member, dryRun: false },
      })
      expect(result._tag).toBe('TornDown')
      expect(yield* pathExists(fixture.destinationPath)).toBe(false)
      expect(
        yield* Effect.promise(() => readFile(NodePath.join(external, 'keep.txt'), 'utf8')),
      ).toBe('keep\n')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.sourceA, 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(
        yield* pathExists(
          ownedCpAMountMetadataPath({
            workspaceRoot: fixture.workspaceRoot,
            member: fixture.member,
          }),
        ),
      ).toBe(false)
    }, withNode),
  )

  it.effect(
    'restores retained Darwin stage and destination roots after an exchange command failure',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      const failingMv = yield* makeModeCheckingMv({ fixture, name: 'failure', exitCode: 17 })
      const result = yield* materializeCpAMemberMount({
        request: requestFor({
          fixture,
          sourcePath: fixture.sourceB,
          lockedCommit: 'b'.repeat(40),
          allowVerifiedDarwinAdvance: true,
        }),
        runtime: runtimeFor(fixture, { mvPath: failingMv.mvPath, platform: 'darwin' }),
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('CommandFailure')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(stagePath(fixture), 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)
      expect(yield* modeOf(stagePath(fixture))).toBe(0o555)
      expect(yield* Effect.promise(() => readFile(failingMv.observationsPath, 'utf8'))).toBe(
        '493,493\n',
      )
      expect(yield* pathExists(fixture.transactionPath)).toBe(true)

      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: true,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'darwin' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)
    }, withNode),
  )

  it.effect(
    'preserves both recovery paths when swapped-old validation mismatches before metadata',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const target = NodePath.join(fixture.workspaceRoot, 'legacy-mismatch-target')
      yield* Effect.promise(async () => {
        await mkdir(target)
        await writeFile(NodePath.join(target, 'keep.txt'), 'keep\n')
        await symlink(target, fixture.destinationPath)
      })
      const result = yield* firstPublish(fixture, {
        afterPhase: async (phase) => {
          if (phase !== 'Exchanged') return
          await unlink(stagePath(fixture))
          await mkdir(stagePath(fixture))
          await writeFile(NodePath.join(stagePath(fixture), 'foreign.txt'), 'foreign\n')
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure.reason).toBe('ExchangeValidationFailed')
        expect(result.failure.recoveryPaths).toContain(stagePath(fixture))
      }
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(stagePath(fixture), 'foreign.txt'), 'utf8'),
        ),
      ).toBe('foreign\n')
      expect(yield* Effect.promise(() => readFile(NodePath.join(target, 'keep.txt'), 'utf8'))).toBe(
        'keep\n',
      )
      expect(
        yield* pathExists(
          ownedCpAMountMetadataPath({
            workspaceRoot: fixture.workspaceRoot,
            member: fixture.member,
          }),
        ),
      ).toBe(false)
      expect(yield* pathExists(fixture.transactionPath)).toBe(true)
    }, withNode),
  )

  it.effect(
    'fsyncs transaction and namespace directories before acknowledging each phase',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const events: string[] = []
      const result = yield* firstPublish(fixture, {
        directoryFsync: async ({ reason, sync }) => {
          await sync()
          events.push(`fsync:${reason}`)
        },
        afterPhase: async (phase) => {
          events.push(`phase:${phase}`)
        },
      })
      expect(result._tag).toBe('Published')
      expect(events).toEqual([
        'fsync:TransactionCreate',
        'phase:Intent',
        'fsync:TransactionReplace',
        'fsync:StageCreate',
        'fsync:TransactionReplace',
        'phase:CandidateCreated',
        'fsync:TransactionReplace',
        'phase:Staged',
        'fsync:FirstPublish',
        'fsync:TransactionReplace',
        'phase:Exchanged',
        'fsync:MetadataPublish',
        'fsync:TransactionReplace',
        'phase:MetadataPublished',
        'fsync:TransactionRemove',
      ])
    }, withNode),
  )

  it.effect(
    'keeps fsync failures recoverable at transaction, publish, and metadata boundaries',
    Effect.fnUntraced(function* () {
      for (const failureReason of [
        'TransactionCreate',
        'StageCreate',
        'FirstPublish',
        'MetadataPublish',
      ] as const) {
        const fixture = yield* makeFixture()
        let failed = false
        const result = yield* firstPublish(fixture, {
          nonce: () => `fsync-${failureReason}`,
          directoryFsync: async ({ reason, sync }) => {
            if (reason === failureReason && failed === false) {
              failed = true
              throw new Error(`injected ${reason} fsync failure`)
            }
            await sync()
          },
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(yield* pathExists(fixture.transactionPath)).toBe(true)

        const recovered = yield* recoverCpAMemberMount({
          request: {
            workspaceRoot: fixture.workspaceRoot,
            member: fixture.member,
            allowVerifiedDarwinAdvance: false,
          },
          runtime: { mvPath: fixture.mvPath, platform: 'linux' },
        })
        expect(recovered).toMatchObject({
          _tag: 'Recovered',
          action:
            failureReason === 'TransactionCreate' || failureReason === 'StageCreate'
              ? 'RolledBack'
              : 'RolledForward',
        })
        expect(yield* pathExists(fixture.transactionPath)).toBe(false)
      }
    }, withNode),
  )

  it.effect(
    'refuses Darwin exchange before any mutation unless the caller opts into verified primitives',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const target = NodePath.join(fixture.workspaceRoot, 'legacy')
      yield* Effect.promise(async () => {
        await mkdir(target)
        await symlink(target, fixture.destinationPath)
      })
      let checks = 0
      const result = yield* firstPublish(fixture, {
        platform: 'darwin',
        capabilityCheck: async () => {
          checks += 1
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('PlatformAdvanceRefused')
      expect((yield* Effect.promise(() => lstat(fixture.destinationPath))).isSymbolicLink()).toBe(
        true,
      )
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      expect(checks).toBe(0)
    }, withNode),
  )

  it.effect(
    'dry-run performs nonmutating source and ownership checks and returns a plan with zero writes',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const reposBefore = yield* Effect.promise(() =>
        readdir(NodePath.join(fixture.workspaceRoot, 'repos')),
      )
      let checks = 0
      const result = yield* materializeCpAMemberMount({
        request: requestFor({
          fixture,
          sourcePath: fixture.sourceA,
          lockedCommit: 'a'.repeat(40),
          dryRun: true,
        }),
        runtime: runtimeFor(fixture, {
          capabilityCheck: async () => {
            checks += 1
          },
        }),
      })
      expect(result._tag).toBe('DryRun')
      if (result._tag === 'DryRun') {
        expect(result.plan._tag).toBe('MountPlan')
        if (result.plan._tag === 'MountPlan') expect(result.plan.operation).toBe('FirstPublish')
      }
      expect(
        yield* Effect.promise(() => readdir(NodePath.join(fixture.workspaceRoot, 'repos'))),
      ).toEqual(reposBefore)
      expect(yield* pathExists(fixture.destinationPath)).toBe(false)
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
      expect(checks).toBe(0)
    }, withNode),
  )

  it.effect(
    'cleans only its inode-bound candidate after capability failure',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const result = yield* firstPublish(fixture, {
        capabilityCheck: async () => {
          throw new Error('check failed')
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('CapabilityCheckFailed')
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.sourceA, 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
    }, withNode),
  )

  it.effect(
    'refuses a foreign real directory and never writes a transaction',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.promise(async () => {
        await mkdir(fixture.destinationPath)
        await writeFile(NodePath.join(fixture.destinationPath, 'foreign.txt'), 'mine\n')
      })
      const result = yield* firstPublish(fixture).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('DestinationRefused')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'foreign.txt'), 'utf8'),
        ),
      ).toBe('mine\n')
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
    }, withNode),
  )

  it.effect(
    'refuses a concurrent transaction collision while the first writer holds intent',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const intent = new Promise<void>((resolve) => {
        entered = resolve
      })
      const first = yield* Effect.forkChild(
        firstPublish(fixture, {
          afterPhase: async (phase) => {
            if (phase === 'Intent') {
              entered()
              await gate
            }
          },
        }),
      )
      yield* Effect.promise(() => intent)
      const second = yield* firstPublish(fixture).pipe(Effect.result)
      expect(second._tag).toBe('Failure')
      if (second._tag === 'Failure') expect(second.failure.reason).toBe('TransactionCollision')
      release()
      const completed = yield* Fiber.join(first)
      expect(completed._tag).toBe('Published')
    }, withNode),
  )
})

describe('cp-a transaction recovery fault matrix', () => {
  it.effect(
    'rolls back intent-only state',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const interrupted = yield* firstPublish(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'Intent') throw new Error('crash')
        },
      }).pipe(Effect.result)
      expect(interrupted._tag).toBe('Failure')
      expect(yield* pathExists(fixture.destinationPath)).toBe(false)
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'linux' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledBack' })
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
    }, withNode),
  )

  it.effect(
    're-protects a writable staged root before rolling forward a Darwin first publish',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'Staged') throw new Error('crash')
        },
      }).pipe(Effect.result)
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(stagePath(fixture), 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      yield* Effect.promise(() => chmod(stagePath(fixture), 0o755))
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'darwin' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)
    }, withNode),
  )

  it.effect(
    're-protects exchanged roots left writable by a Darwin crash before rolling forward',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      yield* advance(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'Staged') throw new Error('crash')
        },
      }).pipe(Effect.result)
      yield* Effect.promise(async () => {
        await chmod(stagePath(fixture), 0o755)
        await chmod(fixture.destinationPath, 0o755)
      })
      yield* exchange({
        mvPath: fixture.mvPath,
        left: stagePath(fixture),
        right: fixture.destinationPath,
      })
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: true,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'darwin' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      expect(yield* modeOf(fixture.destinationPath)).toBe(0o555)
    }, withNode),
  )

  it.effect(
    'finishes cleanup after metadata publication',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      yield* advance(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'MetadataPublished') throw new Error('crash')
        },
      }).pipe(Effect.result)
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'version.txt'), 'utf8'),
        ),
      ).toBe('B\n')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(stagePath(fixture), 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'linux' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
    }, withNode),
  )

  it.effect(
    'continues inode-bound cleanup after partial directory unprotection and deletion',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture)
      yield* advance(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'Cleanup') throw new Error('crash')
        },
      }).pipe(Effect.result)
      yield* Effect.promise(async () => {
        await chmod(stagePath(fixture), 0o755)
        await unlink(NodePath.join(stagePath(fixture), 'version.txt'))
      })
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'linux' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
      expect(yield* pathExists(fixture.transactionPath)).toBe(false)
    }, withNode),
  )

  it.effect(
    'rolls back an inode-bound partial candidate after candidate creation',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      yield* firstPublish(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'CandidateCreated') throw new Error('crash')
        },
      }).pipe(Effect.result)
      expect(yield* pathExists(stagePath(fixture))).toBe(true)
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'linux' },
      })
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledBack' })
      expect(yield* pathExists(stagePath(fixture))).toBe(false)
    }, withNode),
  )

  it.effect(
    'preserves both paths and refuses ambiguous foreign replacement',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const target = NodePath.join(fixture.workspaceRoot, 'legacy-target')
      yield* Effect.promise(async () => {
        await mkdir(target)
        await symlink(target, fixture.destinationPath)
      })
      yield* firstPublish(fixture, {
        afterPhase: async (phase) => {
          if (phase === 'Staged') throw new Error('crash')
        },
      }).pipe(Effect.result)
      yield* Effect.promise(async () => {
        await unlink(fixture.destinationPath)
        await mkdir(fixture.destinationPath)
        await writeFile(NodePath.join(fixture.destinationPath, 'foreign.txt'), 'foreign\n')
      })
      const recovered = yield* recoverCpAMemberMount({
        request: {
          workspaceRoot: fixture.workspaceRoot,
          member: fixture.member,
          allowVerifiedDarwinAdvance: false,
        },
        runtime: { mvPath: fixture.mvPath, platform: 'linux' },
      }).pipe(Effect.result)
      expect(recovered._tag).toBe('Failure')
      if (recovered._tag === 'Failure') {
        expect(recovered.failure.reason).toBe('AmbiguousRecovery')
        expect(recovered.failure.recoveryPaths).toEqual([
          fixture.destinationPath,
          stagePath(fixture),
          fixture.transactionPath,
        ])
      }
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.destinationPath, 'foreign.txt'), 'utf8'),
        ),
      ).toBe('foreign\n')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(stagePath(fixture), 'version.txt'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(yield* pathExists(fixture.transactionPath)).toBe(true)
    }, withNode),
  )
})
