import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { expect } from 'vitest'

import { CompositionGeneratorConfig, EffectPath } from '../../core/config.ts'
import { requireTool } from '../../test-utils/require-tool.ts'
import {
  planCompositionRootPublication,
  publishCompositionRoot,
  teardownCompositionRoot,
  type CompositionRootPublicationError,
  type CompositionRootPublicationRuntime,
  type PlanCompositionRootPublicationOptions,
  type PublishCompositionRootOptions,
} from './composition-root-publisher.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  encodeBuckMemberManifestJson,
  generateCompositionRoot,
  type BuckMemberManifest,
} from './composition-root.ts'

const execFilePromise = promisify(execFile)
const generatedPaths = [
  '.buckroot',
  '.megarepo/bin/buck2',
  COMPOSITION_GENERATION_MANIFEST_PATH,
  'BUCK',
  '.buckconfig',
] as const

const memberManifest = ({
  memberKey,
  cell = memberKey,
  mount = `repos/${memberKey}`,
}: {
  readonly memberKey: string
  readonly cell?: string
  readonly mount?: string
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount,
  projectIgnore: [],
  distOverlays: [],
  capabilities: [],
})

interface Fixture {
  readonly root: string
  readonly workspaceRoot: ReturnType<typeof EffectPath.unsafe.absoluteDir>
  readonly buckExecutable: string
}

const makeFixture = ({
  members = ['alpha', 'beta'],
  manifests = {},
}: {
  readonly members?: ReadonlyArray<string>
  readonly manifests?: Readonly<Record<string, BuckMemberManifest | string>>
} = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(NodePath.join(tmpdir(), 'megarepo-composition-publisher-'))
      await mkdir(NodePath.join(root, 'repos'), { recursive: true })
      for (const member of members) {
        const memberRoot = NodePath.join(root, 'repos', member)
        await mkdir(memberRoot, { recursive: true })
        const manifest = manifests[member] ?? memberManifest({ memberKey: member })
        await writeFile(
          NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME),
          typeof manifest === 'string' ? manifest : encodeBuckMemberManifestJson(manifest),
        )
      }
      const buckExecutable = NodePath.join(root, 'fake-buck2')
      await writeFile(buckExecutable, `#!${requireTool('BASH_BIN')}\nprintf "%s\\n" "$@"\n`)
      await chmod(buckExecutable, 0o755)
      return {
        root,
        workspaceRoot: EffectPath.unsafe.absoluteDir(`${root}/`),
        buckExecutable,
      }
    }),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )

const compositionConfig = (platformHub = 'alpha', isolationDir = 'megarepo') =>
  new CompositionGeneratorConfig({ platformHub, isolationDir })

const runtime = (
  overrides: Partial<CompositionRootPublicationRuntime> = {},
): CompositionRootPublicationRuntime => ({
  assertCapabilityProjection: async () => undefined,
  ...overrides,
})

const optionsFor = ({
  fixture,
  memberKeys = ['alpha', 'beta'],
  ownedMemberKey = 'alpha',
  platformHub = 'alpha',
  isolationDir = 'megarepo',
  cacheValue,
  publicationRuntime = runtime(),
  lockToken = 'test-token',
  recoverToken,
  afterAuthorityPublished,
}: {
  readonly fixture: Fixture
  readonly memberKeys?: ReadonlyArray<string>
  readonly ownedMemberKey?: string
  readonly platformHub?: string
  readonly isolationDir?: string
  readonly cacheValue?: string
  readonly publicationRuntime?: CompositionRootPublicationRuntime
  readonly lockToken?: string
  readonly recoverToken?: string
  readonly afterAuthorityPublished?: () => Promise<void>
}): PublishCompositionRootOptions => ({
  workspaceRoot: fixture.workspaceRoot,
  configMemberKeys: memberKeys,
  ownedMemberKey,
  compositionConfig: compositionConfig(platformHub, isolationDir),
  resolvedBuckExecutable: fixture.buckExecutable,
  cacheSections:
    cacheValue === undefined
      ? []
      : [{ section: 'buck2_re_client', entries: [{ key: 'address', value: cacheValue }] }],
  lock: {
    owner: 'publisher-test',
    token: lockToken,
    ...(recoverToken === undefined ? {} : { recoverToken }),
  },
  runtime: publicationRuntime,
  ...(afterAuthorityPublished === undefined ? {} : { afterAuthorityPublished }),
})

const planOptionsFor = (
  input: Parameters<typeof optionsFor>[0],
  assertCapabilityProjection: CompositionRootPublicationRuntime['assertCapabilityProjection'] = async () =>
    undefined,
): PlanCompositionRootPublicationOptions => {
  const options = optionsFor(input)
  return {
    workspaceRoot: options.workspaceRoot,
    configMemberKeys: options.configMemberKeys,
    ownedMemberKey: options.ownedMemberKey,
    compositionConfig: options.compositionConfig,
    resolvedBuckExecutable: options.resolvedBuckExecutable,
    ...(options.cacheSections === undefined ? {} : { cacheSections: options.cacheSections }),
    assertCapabilityProjection,
  }
}

interface FilesystemSnapshotEntry {
  readonly path: string
  readonly kind: 'directory' | 'file' | 'symlink'
  readonly mode: number
  readonly mtimeMs: number
  readonly ino: number
  readonly bytes?: string
  readonly target?: string
}

const filesystemSnapshot = (root: string): Effect.Effect<ReadonlyArray<FilesystemSnapshotEntry>> =>
  Effect.promise(async () => {
    const entries: FilesystemSnapshotEntry[] = []
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path)
      const relativePath = NodePath.relative(root, path) || '.'
      if (info.isSymbolicLink() === true) {
        entries.push({
          path: relativePath,
          kind: 'symlink',
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ino: info.ino,
          target: await readlink(path),
        })
        return
      }
      if (info.isDirectory() === true) {
        entries.push({
          path: relativePath,
          kind: 'directory',
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ino: info.ino,
        })
        for (const child of (await readdir(path)).toSorted()) {
          await visit(NodePath.join(path, child))
        }
        return
      }
      entries.push({
        path: relativePath,
        kind: 'file',
        mode: info.mode & 0o777,
        mtimeMs: info.mtimeMs,
        ino: info.ino,
        bytes: (await readFile(path)).toString('base64'),
      })
    }
    await visit(root)
    return entries
  })

const readGenerated = (fixture: Fixture, relativePath: string): Effect.Effect<Buffer> =>
  Effect.promise(() => readFile(NodePath.join(fixture.root, relativePath)))

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      (cause: unknown) => {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return false
        }
        throw cause
      },
    ),
  )

const failureReason = <A>(
  effect: Effect.Effect<A, CompositionRootPublicationError>,
): Effect.Effect<CompositionRootPublicationError> =>
  Effect.result(effect).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Failure'
        ? Effect.succeed(result.failure)
        : Effect.die('Expected composition publication failure'),
    ),
  )

const addLegacyGeneratedStubs = async (fixture: Fixture): Promise<void> => {
  const legacyFiles = [
    { path: 'none/BUCK', bytes: Buffer.from('') },
    { path: 'toolchains/BUCK', bytes: Buffer.from('legacy toolchain projection\n') },
  ] as const
  for (const file of legacyFiles) {
    const path = NodePath.join(fixture.root, file.path)
    await mkdir(NodePath.dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
    await chmod(path, 0o644)
  }
  const manifestPath = NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    schemaVersion: 1
    files: Array<{ path: string; mode: number; sha256: string }>
  }
  manifest.files.push(
    ...legacyFiles.map((file) => ({
      path: file.path,
      mode: 0o644,
      sha256: `sha256:${createHash('sha256').update(file.bytes).digest('hex')}`,
    })),
  )
  manifest.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

describe('composition root publisher', () => {
  it.effect('plans first-create bytes without mutating the filesystem', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(planOptionsFor({ fixture }))
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(plan._tag).toBe('Create')
        expect(plan.configLast).toBe(true)
        expect(plan.files.map((file) => file.path)).toEqual(generatedPaths)
        expect(plan.files.every((file) => file.old === undefined)).toBe(true)
        expect(
          plan.files.every(
            (file) => file.new !== undefined && /^sha256:[0-9a-f]{64}$/u.test(file.new.sha256),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.effect('plans an idempotent repeat as NoChange without touching bytes or mtimes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, lockToken: 'plan-repeat-publish' }))
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(planOptionsFor({ fixture }))
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(plan).toEqual({ _tag: 'NoChange', files: [], configLast: true })
      }),
    ),
  )

  it.effect('plans updates with ordered old/new identities and config last without mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(
          optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'plan-update-publish' }),
        )
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(
          planOptionsFor({ fixture, cacheValue: 'new:5678' }),
        )
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(plan._tag).toBe('Update')
        expect(plan.configLast).toBe(true)
        expect(plan.files.at(-1)?.path).toBe('.buckconfig')
        expect(plan.files.map((file) => file.path)).toEqual([
          COMPOSITION_GENERATION_MANIFEST_PATH,
          '.buckconfig',
        ])
        for (const file of plan.files) {
          expect(file.old).toBeDefined()
          expect(file.new).toBeDefined()
          expect(file.old?.sha256).not.toBe(file.new?.sha256)
          expect([0o644, 0o755]).toContain(file.new?.mode)
        }
      }),
    ),
  )

  it.effect('plans foreign ownership as Refused without repairing or mutating it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, lockToken: 'plan-foreign-publish' }))
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), 'foreign\n'))
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(planOptionsFor({ fixture }))
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(plan._tag).toBe('Refused')
        if (plan._tag === 'Refused') {
          expect(plan.reason).toBe('ForeignPath')
          expect(plan.files).toEqual([])
          expect(plan.configLast).toBe(false)
        }
      }),
    ),
  )

  it.effect('plans a failed capability prerequisite as typed Refused without mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const checked: string[] = []
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(
          planOptionsFor({ fixture }, async ({ memberKey }) => {
            checked.push(memberKey)
            if (memberKey === 'beta') throw new Error('capability projection is stale')
          }),
        )
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(checked).toEqual(['alpha', 'beta'])
        expect(plan._tag).toBe('Refused')
        if (plan._tag === 'Refused') {
          expect(plan.reason).toBe('CapabilityPrerequisiteFailure')
          expect(plan.path).toBe(NodePath.join(fixture.root, 'repos/beta'))
          expect(plan.files).toEqual([])
          expect(plan.configLast).toBe(false)
        }
      }),
    ),
  )

  it.effect('plans an in-flight transaction as recovery-required without taking its lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'plan-transaction-token',
              publicationRuntime: runtime({
                simulateProcessFaultAfterCandidate: (path) => path === '.buckconfig',
              }),
            }),
          ),
        )
        const before = yield* filesystemSnapshot(fixture.root)
        const plan = yield* planCompositionRootPublication(planOptionsFor({ fixture }))
        const after = yield* filesystemSnapshot(fixture.root)
        expect(after).toEqual(before)
        expect(plan._tag).toBe('Refused')
        if (plan._tag === 'Refused') {
          expect(plan.reason).toBe('RecoveryRequired')
          expect(plan.message).toContain('plan-transaction-token')
        }
      }),
    ),
  )

  it.effect('publishes the pure plan with .buckconfig as the final authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const published: string[] = []
        const result = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            publicationRuntime: runtime({
              afterPublishedFile: async (path) => {
                published.push(path)
              },
            }),
          }),
        )

        expect(result.changedPaths).toEqual(published)
        expect(published.at(-1)).toBe('.buckconfig')
        for (const relativePath of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, relativePath))).toBe(true)
        }
        expect(result.memberManifests.map(({ memberKey }) => memberKey)).toEqual(['alpha', 'beta'])
      }),
    ),
  )

  it.effect('commits only after the authority callback succeeds', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        let callbacks = 0
        yield* publishCompositionRoot(
          optionsFor({
            fixture,
            afterAuthorityPublished: async () => {
              callbacks += 1
              expect(
                (await readFile(NodePath.join(fixture.root, '.buckconfig'), 'utf8')).length,
              ).toBeGreaterThan(0)
              expect(
                (
                  await readFile(
                    NodePath.join(fixture.root, '.megarepo/composition-publication.json'),
                  )
                ).byteLength,
              ).toBeGreaterThan(0)
            },
          }),
        )
        expect(callbacks).toBe(1)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('forward-recovers a durable committed phase after post-callback cleanup faults', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(
          optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'initial-commit-token' }),
        )
        let callbacks = 0
        const fault = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'committed:5678',
              lockToken: 'durable-commit-token',
              afterAuthorityPublished: async () => {
                callbacks += 1
              },
              publicationRuntime: runtime({
                afterAuthorityCommitted: async () => {
                  throw new Error('cleanup read failed')
                },
              }),
            }),
          ),
        )
        expect(fault.reason).toBe('IoFailure')
        expect(callbacks).toBe(1)
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain(
          'committed:5678',
        )
        expect(
          yield* exists(
            NodePath.join(fixture.root, '.megarepo/composition-publication.committed.json'),
          ),
        ).toBe(true)

        const recovered = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            cacheValue: 'committed:5678',
            lockToken: 'after-durable-commit-token',
            recoverToken: 'durable-commit-token',
          }),
        )
        expect(recovered.changedPaths).toEqual([])
        expect(callbacks).toBe(1)
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain(
          'committed:5678',
        )
        for (const path of [
          '.megarepo/composition-publication.json',
          '.megarepo/composition-publication.committed.json',
          '.megarepo/composition-publisher.lock.json',
        ]) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
      }),
    ),
  )

  it.effect('rolls back every first-create authority file when the callback fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              afterAuthorityPublished: async () => {
                throw new Error('authority side effect failed')
              },
            }),
          ),
        )
        expect(error.reason).toBe('IoFailure')
        for (const path of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('restores the previous generation byte-exact when an update callback fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'old:1234' }))
        const before = new Map(
          yield* Effect.promise(() =>
            Promise.all(
              generatedPaths.map(async (path) => {
                const absolute = NodePath.join(fixture.root, path)
                const info = await stat(absolute)
                return [path, { bytes: await readFile(absolute), mode: info.mode & 0o777 }] as const
              }),
            ),
          ),
        )
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              lockToken: 'update-callback-token',
              afterAuthorityPublished: async () => {
                throw new Error('projection side effect failed')
              },
            }),
          ),
        )
        expect(error.reason).toBe('IoFailure')
        for (const path of generatedPaths) {
          const absolute = NodePath.join(fixture.root, path)
          const info = yield* Effect.promise(() => stat(absolute))
          expect(yield* Effect.promise(() => readFile(absolute))).toEqual(before.get(path)?.bytes)
          expect(info.mode & 0o777).toBe(before.get(path)?.mode)
        }
      }),
    ),
  )

  it.effect('preserves bytes, modes, and mtimes on an idempotent repeat', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const options = optionsFor({ fixture })
        yield* publishCompositionRoot(options)
        const before = new Map(
          yield* Effect.promise(() =>
            Promise.all(
              generatedPaths.map(async (path) => {
                const info = await stat(NodePath.join(fixture.root, path))
                return [path, { mtimeMs: info.mtimeMs, mode: info.mode & 0o777 }] as const
              }),
            ),
          ),
        )
        const repeated = yield* publishCompositionRoot(options)
        expect(repeated.changedPaths).toEqual([])
        for (const path of generatedPaths) {
          const info = yield* Effect.promise(() => stat(NodePath.join(fixture.root, path)))
          expect(info.mtimeMs).toBe(before.get(path)?.mtimeMs)
          expect(info.mode & 0o777).toBe(before.get(path)?.mode)
        }
      }),
    ),
  )

  it.effect('canonicalizes config member permutation without republishing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha', 'beta'] }))
        const before = yield* Effect.promise(() => stat(NodePath.join(fixture.root, '.buckconfig')))
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['beta', 'alpha'] }),
        )
        const after = yield* Effect.promise(() => stat(NodePath.join(fixture.root, '.buckconfig')))
        expect(result.changedPaths).toEqual([])
        expect(after.mtimeMs).toBe(before.mtimeMs)
      }),
    ),
  )

  it.effect('strictly decodes and carries member dist overlays without publishing them yet', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const alpha = {
          ...memberManifest({ memberKey: 'alpha' }),
          distOverlays: [{ target: '//packages/app:dist', destination: 'dist/app' }],
        }
        const fixture = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha },
        })
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'overlay-token' }),
        )
        expect(result.memberManifests[0]?.manifest.distOverlays).toEqual(alpha.distOverlays)
        const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
        expect(config).not.toContain('//packages/app:dist')
        expect(config).not.toContain('dist/app')
        expect(yield* exists(NodePath.join(fixture.root, 'repos/alpha/dist/app'))).toBe(false)
      }),
    ),
  )

  it.effect('strictly rejects missing and invalid member manifests', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing = yield* makeFixture({ members: ['alpha'] })
        yield* Effect.promise(() =>
          rm(NodePath.join(missing.root, 'repos/alpha', BUCK_MEMBER_MANIFEST_FILENAME)),
        )
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: missing, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidMemberManifest')

        const invalid = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha: '{"schemaVersion":1,"unknown":true}\n' },
        })
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: invalid, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidMemberManifest')
      }),
    ),
  )

  it.effect('fails closed when a member carries Buck root authority files', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const rootFile of ['.buckconfig', '.buckroot']) {
          const fixture = yield* makeFixture({ members: ['alpha'] })
          yield* Effect.promise(() =>
            writeFile(NodePath.join(fixture.root, 'repos/alpha', rootFile), ''),
          )
          const plan = yield* planCompositionRootPublication(
            planOptionsFor({ fixture, memberKeys: ['alpha'] }),
          )
          expect(plan._tag).toBe('Refused')
          if (plan._tag === 'Refused') {
            expect(plan.reason).toBe('InvalidMemberManifest')
            expect(plan.path).toBe(NodePath.join(fixture.root, 'repos/alpha', rootFile))
          }
        }
      }),
    ),
  )

  it.effect('transactionally removes prior manifest-owned files absent from the new plan', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'legacy-seed-token' }),
        )
        yield* Effect.promise(() => addLegacyGeneratedStubs(fixture))

        const plan = yield* planCompositionRootPublication(
          planOptionsFor({ fixture, memberKeys: ['alpha'] }),
        )
        expect(plan._tag).toBe('Update')
        if (plan._tag !== 'Update') return
        expect(plan.files.find((file) => file.path === 'none/BUCK')?.new).toBeUndefined()
        expect(plan.files.find((file) => file.path === 'toolchains/BUCK')?.new).toBeUndefined()
        expect(plan.files.at(-1)?.path).toBe('.buckconfig')

        const result = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            memberKeys: ['alpha'],
            lockToken: 'legacy-remove-token',
          }),
        )
        expect(result.changedPaths).toContain('none/BUCK')
        expect(result.changedPaths).toContain('toolchains/BUCK')
        expect(yield* exists(NodePath.join(fixture.root, 'none'))).toBe(false)
        expect(yield* exists(NodePath.join(fixture.root, 'toolchains'))).toBe(false)
        const manifest = (yield* readGenerated(
          fixture,
          COMPOSITION_GENERATION_MANIFEST_PATH,
        )).toString()
        expect(manifest).not.toContain('none/BUCK')
        expect(manifest).not.toContain('toolchains/BUCK')
      }),
    ),
  )

  it.effect('rolls back obsolete-file removals before restoring root authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'rollback-seed-token' }),
        )
        yield* Effect.promise(() => addLegacyGeneratedStubs(fixture))
        const oldConfig = yield* readGenerated(fixture, '.buckconfig')
        const oldManifest = yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)

        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              memberKeys: ['alpha'],
              lockToken: 'obsolete-rollback-token',
              publicationRuntime: runtime({
                afterPublishedFile: async (path) => {
                  if (path === 'none/BUCK') throw new Error('stop after obsolete removal')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('IoFailure')
        expect(yield* exists(NodePath.join(fixture.root, 'none/BUCK'))).toBe(true)
        expect(yield* exists(NodePath.join(fixture.root, 'toolchains/BUCK'))).toBe(true)
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(oldConfig)
        expect(yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)).toEqual(
          oldManifest,
        )
      }),
    ),
  )

  it.effect('rejects unowned entries beside obsolete manifest-owned files', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'foreign-seed-token' }),
        )
        yield* Effect.promise(async () => {
          await addLegacyGeneratedStubs(fixture)
          await writeFile(NodePath.join(fixture.root, 'toolchains/foreign'), 'foreign\n')
        })

        const plan = yield* planCompositionRootPublication(
          planOptionsFor({ fixture, memberKeys: ['alpha'] }),
        )
        expect(plan._tag).toBe('Refused')
        if (plan._tag === 'Refused') {
          expect(plan.reason).toBe('ForeignPath')
          expect(plan.path).toBe(NodePath.join(fixture.root, 'toolchains'))
        }
        expect(yield* exists(NodePath.join(fixture.root, 'toolchains/BUCK'))).toBe(true)
      }),
    ),
  )

  it.effect('rejects a symlinked obsolete parent without touching its external target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'megarepo-obsolete-outside-'))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        )
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'symlink-seed-token' }),
        )
        yield* Effect.promise(async () => {
          await addLegacyGeneratedStubs(fixture)
          await rename(
            NodePath.join(fixture.root, 'toolchains'),
            NodePath.join(outside, 'toolchains'),
          )
          await symlink(
            NodePath.join(outside, 'toolchains'),
            NodePath.join(fixture.root, 'toolchains'),
          )
        })

        const plan = yield* planCompositionRootPublication(
          planOptionsFor({ fixture, memberKeys: ['alpha'] }),
        )
        expect(plan._tag).toBe('Refused')
        if (plan._tag === 'Refused') {
          expect(plan.reason).toBe('ForeignPath')
          expect(plan.path).toBe(NodePath.join(fixture.root, 'toolchains'))
        }
        expect(
          yield* Effect.promise(() => readFile(NodePath.join(outside, 'toolchains/BUCK'), 'utf8')),
        ).toBe('legacy toolchain projection\n')
      }),
    ),
  )

  it.effect('rejects mount disagreement and a hub outside the configured members', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mismatch = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha: memberManifest({ memberKey: 'alpha', mount: 'repos/other' }) },
        })
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: mismatch, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidInput')

        const fixture = yield* makeFixture({ members: ['alpha'] })
        expect(
          (yield* failureReason(
            publishCompositionRoot(
              optionsFor({ fixture, memberKeys: ['alpha'], platformHub: 'beta' }),
            ),
          )).reason,
        ).toBe('InvalidInput')
      }),
    ),
  )

  it.effect('requires the capability projection assertion for every member including owned', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const checked: string[] = []
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              publicationRuntime: runtime({
                assertCapabilityProjection: async ({ memberKey, owned }) => {
                  checked.push(`${memberKey}:${owned}`)
                  if (memberKey === 'beta') throw new Error('projection check failed')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('CapabilityPrerequisiteFailure')
        expect(checked).toEqual(['alpha:true', 'beta:false'])
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)
      }),
    ),
  )

  it.effect('forward-recovers every durable candidate fault without exposing first authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const faultPath of generatedPaths) {
          const fixture = yield* makeFixture()
          const error = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                publicationRuntime: runtime({
                  afterCandidateFile: async (path) => {
                    if (path === faultPath) throw new Error(`fault:${path}`)
                  },
                }),
              }),
            ),
          )
          expect(error.reason).toBe('IoFailure')
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)
          yield* publishCompositionRoot(optionsFor({ fixture }))
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
        }
      }),
    ),
  )

  it.effect('rolls back and cleans first-create files after an installed-file failure', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'first-create-rollback',
              publicationRuntime: runtime({
                afterPublishedFile: async (path) => {
                  if (path === 'BUCK') throw new Error('fail after install')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('IoFailure')
        for (const path of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('preserves previous root authority when an update candidate fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'old:1234' }))
        const oldConfig = yield* readGenerated(fixture, '.buckconfig')
        const oldManifest = yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path === '.buckconfig') throw new Error('stop before authority')
                },
              }),
            }),
          ),
        )
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(oldConfig)
        expect(yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)).toEqual(
          oldManifest,
        )
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'new:5678' }))
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain('new:5678')
      }),
    ),
  )

  it.effect('refuses foreign replacement bytes and modes before any mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture }))
        const configBefore = yield* readGenerated(fixture, '.buckconfig')
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), 'foreign\n'))
        const error = yield* failureReason(publishCompositionRoot(optionsFor({ fixture })))
        expect(error.reason).toBe('ForeignPath')
        expect((yield* readGenerated(fixture, 'BUCK')).toString()).toBe('foreign\n')
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(configBefore)

        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(fixture.root, 'BUCK'), '')
          await chmod(NodePath.join(fixture.root, 'BUCK'), 0o755)
        })
        expect((yield* failureReason(publishCompositionRoot(optionsFor({ fixture })))).reason).toBe(
          'ForeignPath',
        )
      }),
    ),
  )

  it.effect('refuses a foreign replacement injected at the candidate boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'old:1234' }))
        const configPath = NodePath.join(fixture.root, '.buckconfig')
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path === '.buckconfig') await writeFile(configPath, 'foreign authority\n')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toBe(
          'foreign authority\n',
        )
      }),
    ),
  )

  it.effect('refuses invalid or missing ownership manifests once authority exists', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalid = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture: invalid }))
        yield* Effect.promise(() =>
          writeFile(NodePath.join(invalid.root, COMPOSITION_GENERATION_MANIFEST_PATH), '{}\n'),
        )
        expect(
          (yield* failureReason(publishCompositionRoot(optionsFor({ fixture: invalid })))).reason,
        ).toBe('InvalidGenerationManifest')

        const missing = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture: missing }))
        yield* Effect.promise(() =>
          rm(NodePath.join(missing.root, COMPOSITION_GENERATION_MANIFEST_PATH)),
        )
        expect(
          (yield* failureReason(publishCompositionRoot(optionsFor({ fixture: missing })))).reason,
        ).toBe('InvalidGenerationManifest')
      }),
    ),
  )

  it.effect('adopts only exact first-create partial constants', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const pure = generateCompositionRoot({
          schemaVersion: 1,
          members: [{ memberKey: 'alpha', manifest: memberManifest({ memberKey: 'alpha' }) }],
          platformHubCell: 'alpha',
          resolvedBuckExecutable: fixture.buckExecutable,
        })
        const rootBuck = pure.files.find((file) => file.path === 'BUCK')!
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), rootBuck.bytes))
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
      }),
    ),
  )

  it.effect('publishes an atomic executable wrapper that fixes and protects isolation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], isolationDir: 'fleet-buck' }),
        )
        const wrapper = NodePath.join(fixture.root, '.megarepo/bin/buck2')
        const info = yield* Effect.promise(() => stat(wrapper))
        expect(info.mode & 0o777).toBe(0o755)
        // The published wrapper is POSIX `#!/bin/sh`, which is right for a real workspace and
        // absent from a contained action, so it is launched through the declared shell. The
        // assertions are about the argv it forwards, which the interpreter does not change.
        const wrapperShell = requireTool('BASH_BIN')
        const success = yield* Effect.promise(() =>
          execFilePromise(wrapperShell, [wrapper, 'build', '//alpha:all']),
        )
        expect(success.stdout).toBe('--isolation-dir\nfleet-buck\nbuild\n//alpha:all\n')
        const rejected = yield* Effect.promise(() =>
          execFilePromise(wrapperShell, [wrapper, '--isolation-dir=other', 'build']).then(
            () => ({ code: 0, stderr: '' }),
            (cause: unknown) => {
              const error = cause as { readonly code?: number; readonly stderr?: string }
              return { code: error.code, stderr: error.stderr ?? '' }
            },
          ),
        )
        expect(rejected.code).toBe(64)
        expect(rejected.stderr).toContain('--isolation-dir is fixed to fleet-buck')
      }),
    ),
  )

  it.effect('refuses a cooperating concurrent publisher while the exclusive lock is live', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        let signalEntered: () => void = () => undefined
        let releaseFirst: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        const first = yield* Effect.forkChild(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'live-token',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path !== '.buckconfig') return
                  signalEntered()
                  await gate
                },
              }),
            }),
          ),
        )
        yield* Effect.promise(() => entered)
        const second = yield* failureReason(
          publishCompositionRoot(optionsFor({ fixture, lockToken: 'concurrent-token' })),
        )
        expect(second.reason).toBe('LockHeld')
        releaseFirst()
        yield* Fiber.join(first)
      }),
    ),
  )

  it.effect(
    'serializes publication and requires the exact stale-lock token for changed-input recovery',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture()
          const fault = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'old:1234',
                lockToken: 'stale-token',
                publicationRuntime: runtime({
                  simulateProcessFaultAfterCandidate: (path) => path === '.buckconfig',
                }),
              }),
            ),
          )
          expect(fault.reason).toBe('SimulatedProcessFault')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
          ).toBe(true)
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(true)
          expect(
            (yield* failureReason(
              publishCompositionRoot(
                optionsFor({ fixture, cacheValue: 'new:5678', lockToken: 'new-token' }),
              ),
            )).reason,
          ).toBe('LockHeld')
          expect(
            (yield* failureReason(
              publishCompositionRoot(
                optionsFor({
                  fixture,
                  cacheValue: 'new:5678',
                  lockToken: 'new-token',
                  recoverToken: 'wrong-token',
                }),
              ),
            )).reason,
          ).toBe('LockHeld')

          yield* publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              lockToken: 'new-token',
              recoverToken: 'stale-token',
            }),
          )
          const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
          expect(config).toContain('new:5678')
          expect(config).not.toContain('old:1234')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
          ).toBe(false)
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(false)
          expect(
            yield* exists(
              NodePath.join(fixture.root, '.megarepo/composition-publication/stale-token'),
            ),
          ).toBe(false)
        }),
      ),
  )

  it.effect(
    'recovers observed backups after a process fault and then publishes changed inputs',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture()
          yield* publishCompositionRoot(
            optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'initial-token' }),
          )
          const fault = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'middle:5678',
                lockToken: 'backup-token',
                publicationRuntime: runtime({
                  simulateProcessFaultAfterPublishedFile: (path) =>
                    path === COMPOSITION_GENERATION_MANIFEST_PATH,
                }),
              }),
            ),
          )
          expect(fault.reason).toBe('SimulatedProcessFault')
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)

          yield* publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'final:9012',
              lockToken: 'recovered-token',
              recoverToken: 'backup-token',
            }),
          )
          const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
          expect(config).toContain('final:9012')
          expect(config).not.toContain('middle:5678')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(false)
        }),
      ),
  )

  it.effect(
    'rolls back a config-last process fault before any callback can be assumed complete',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture()
          let callbacks = 0
          const fault = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'uncommitted:1234',
                lockToken: 'commit-token',
                afterAuthorityPublished: async () => {
                  callbacks += 1
                },
                publicationRuntime: runtime({
                  simulateProcessFaultAfterPublishedFile: (path) => path === '.buckconfig',
                }),
              }),
            ),
          )
          expect(fault.reason).toBe('SimulatedProcessFault')
          expect(callbacks).toBe(0)
          expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain(
            'uncommitted:1234',
          )

          const recoveryFailure = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'uncommitted:1234',
                lockToken: 'after-commit-token',
                recoverToken: 'commit-token',
                publicationRuntime: runtime({
                  assertCapabilityProjection: async () => {
                    throw new Error('stop after recovery')
                  },
                }),
              }),
            ),
          )
          expect(recoveryFailure.reason).toBe('CapabilityPrerequisiteFailure')
          for (const path of generatedPaths) {
            expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
          }
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(false)
        }),
      ),
  )

  it.effect('refuses a foreign candidate during exact-token recovery', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'foreign-candidate-token',
              publicationRuntime: runtime({
                simulateProcessFaultAfterCandidate: (path) => path === '.buckconfig',
              }),
            }),
          ),
        )
        const candidate = NodePath.join(
          fixture.root,
          '.megarepo/composition-publication/foreign-candidate-token/candidates',
          Buffer.from('.buckconfig').toString('hex'),
        )
        yield* Effect.promise(async () => {
          await unlink(candidate)
          await writeFile(candidate, 'foreign candidate\n')
          await chmod(candidate, 0o644)
        })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'replacement-token',
              recoverToken: 'foreign-candidate-token',
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        expect(yield* Effect.promise(() => readFile(candidate, 'utf8'))).toBe('foreign candidate\n')
      }),
    ),
  )

  it.effect('revalidates each destination identity and restores prior authority last', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(
          optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'initial-token' }),
        )
        const manifestPath = NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)
        const oldManifest = yield* Effect.promise(() => readFile(manifestPath))
        const oldConfig = yield* readGenerated(fixture, '.buckconfig')
        const oldIdentity = yield* Effect.promise(() => lstat(manifestPath))
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              lockToken: 'race-token',
              publicationRuntime: runtime({
                beforeInstallFile: async (path) => {
                  if (path !== COMPOSITION_GENERATION_MANIFEST_PATH) return
                  const replacementPath = `${manifestPath}.foreign`
                  await writeFile(replacementPath, oldManifest)
                  await chmod(replacementPath, 0o644)
                  await rename(replacementPath, manifestPath)
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        const replacementIdentity = yield* Effect.promise(() => lstat(manifestPath))
        expect(replacementIdentity.ino).not.toBe(oldIdentity.ino)
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(oldConfig)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('teardown removes only verified generated files and empty owned directories', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const ownedConfig = NodePath.join(fixture.root, 'repos/alpha/megarepo.kdl')
        yield* Effect.promise(async () => {
          await writeFile(ownedConfig, 'members { alpha "owner/alpha" }\n')
          await symlink('repos/alpha/megarepo.kdl', NodePath.join(fixture.root, 'megarepo.kdl'))
          await mkdir(NodePath.join(fixture.root, 'buck-out'))
          await writeFile(NodePath.join(fixture.root, 'buck-out/keep'), 'keep\n')
        })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        const result = yield* teardownCompositionRoot({
          workspaceRoot: fixture.workspaceRoot,
          lock: { owner: 'publisher-test', token: 'teardown-token' },
        })
        expect(result.removedPaths.toSorted()).toEqual([...generatedPaths].toSorted())
        for (const path of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
        expect(yield* exists(NodePath.join(fixture.root, 'repos/alpha'))).toBe(true)
        expect(yield* exists(NodePath.join(fixture.root, 'megarepo.kdl'))).toBe(true)
        expect(yield* exists(NodePath.join(fixture.root, 'buck-out/keep'))).toBe(true)
        expect(yield* exists(ownedConfig)).toBe(true)
      }),
    ),
  )

  it.effect('teardown revalidates no-follow identity immediately before unlink', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'publish-token' }),
        )
        const configPath = NodePath.join(fixture.root, '.buckconfig')
        const configBytes = yield* Effect.promise(() => readFile(configPath))
        const before = yield* Effect.promise(() => lstat(configPath))
        const error = yield* failureReason(
          teardownCompositionRoot({
            workspaceRoot: fixture.workspaceRoot,
            lock: { owner: 'publisher-test', token: 'teardown-race-token' },
            beforeRemoveFile: async (path) => {
              if (path !== '.buckconfig') return
              const replacementPath = `${configPath}.foreign`
              await writeFile(replacementPath, configBytes)
              await chmod(replacementPath, 0o644)
              await rename(replacementPath, configPath)
            },
          }),
        )
        expect(error.reason).toBe('ForeignPath')
        const replacement = yield* Effect.promise(() => lstat(configPath))
        expect(replacement.ino).not.toBe(before.ino)
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(configBytes)
        expect(
          yield* exists(NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)),
        ).toBe(true)
      }),
    ),
  )

  it.effect('teardown validates all ownership before removing anything', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), 'foreign\n'))
        const error = yield* failureReason(
          teardownCompositionRoot({
            workspaceRoot: fixture.workspaceRoot,
            lock: { owner: 'publisher-test', token: 'teardown-token' },
          }),
        )
        expect(error.reason).toBe('ForeignPath')
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
        expect((yield* readGenerated(fixture, 'BUCK')).toString()).toBe('foreign\n')
      }),
    ),
  )
})
