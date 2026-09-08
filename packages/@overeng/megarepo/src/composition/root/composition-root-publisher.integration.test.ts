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
import { Effect, Fiber, Schema } from 'effect'
import { expect } from 'vitest'

import { CompositionGeneratorConfig, EffectPath } from '../../core/config.ts'
import { requireTool } from '../../test-utils/require-tool.ts'
import {
  CompositionPublisherLockSchema,
  planCompositionRootPublication,
  publishCompositionRoot,
  teardownCompositionRoot,
  type CompositionRootPublicationError,
  type CompositionRootPublicationRuntime,
  type PlanCompositionRootPublicationOptions,
  type CompositionPublisherLock,
  type PublishCompositionRootOptions,
} from './composition-root-publisher.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  CompositionGenerationManifestSchema,
  encodeBuckMemberManifestJson,
  generateCompositionRoot,
  generatedWatchmanIgnoreDirs,
  WatchmanConfigSchema,
  type BuckMemberManifest,
  type CompositionGenerationManifest,
} from './composition-root.ts'

const execFilePromise = promisify(execFile)
/** Tracked ownership-manifest JSON, decoded through the same wire schema publication uses. */
const GenerationManifestJson = Schema.fromJsonString(CompositionGenerationManifestSchema)
const decodeGenerationManifestJson = (json: string): CompositionGenerationManifest =>
  Schema.decodeUnknownSync(GenerationManifestJson, { onExcessProperty: 'error' })(json)
const generatedPaths = [
  '.buckroot',
  '.megarepo/bin/buck2',
  COMPOSITION_GENERATION_MANIFEST_PATH,
  '.watchmanconfig',
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

/** Every response byte sequence a real Watchman client produced in a live probe. */
const watchmanResponses = {
  /** `get-config` on a live watched root whose config declares no exclusion at all. */
  loadedEmptyConfig: '{"version":"2026.01.19.00","config":{}}\n',
  /** `get-config`/`watch-del` on a directory the service does not watch. */
  notWatched: (root: string): string =>
    `{"version":"2026.01.19.00","error":"watchman::RootResolveError: failed to resolve root: unable to resolve root ${root}: failed to resolve root: directory ${root} is not watched"}\n`,
  /** `watch-del` that released the root. */
  deleted: (root: string): string =>
    `{"version":"2026.01.19.00","watch-del":true,"root":"${root}"}\n`,
  /** `get-config` on a live watched root that loaded this exact exclusion. */
  loadedConfig: (ignoreDirs: ReadonlyArray<string>): string =>
    `${JSON.stringify({ version: '2026.01.19.00', config: { ignore_dirs: ignoreDirs } })}\n`,
  /** A root-resolution refusal that is not "not watched" and must surface. */
  illegalFstype: (root: string): string =>
    `{"version":"2026.01.19.00","error":"unable to resolve root ${root}: path uses the \\"nfs\\" filesystem and is disallowed by global config illegal_fstypes"}\n`,
  /** A release body that confirms nothing: the watch may still hold the previous exclusion. */
  unconfirmedRelease: '{"version":"2026.01.19.00","watch-del":false}\n',
  /** A release body naming a different root than the one publication is responsible for. */
  releasedOtherRoot: (root: string): string =>
    `{"version":"2026.01.19.00","watch-del":true,"root":"${root}/elsewhere"}\n`,
} as const

interface WatchmanStub {
  readonly executable: string
  readonly argvFile: string
  readonly responseDir: string
}

/**
 * Stands in for the resolved Watchman executable. Each command answers from a response file the
 * test writes, so a test states the exact bytes a real client produced; a missing response file
 * reproduces the measured `--no-spawn --no-local` no-service signature (non-zero exit, nothing on
 * either stream), and a `stderr` file reproduces a mid-protocol failure that carries a diagnostic.
 *
 * Every invocation also snapshots the live publisher lock, which lets a test assert which lock was
 * held at the instant a Watchman command ran.
 */
const watchmanStubSource = ({
  argvFile,
  responseDir,
  lockPath,
}: {
  readonly argvFile: string
  readonly responseDir: string
  readonly lockPath: string
}): string => `#!${requireTool('BASH_BIN')}
printf '%s\\n' "$*" >> ${JSON.stringify(argvFile)}
response_dir=${JSON.stringify(responseDir)}
cat ${JSON.stringify(lockPath)} > "$response_dir/lock-$4" 2>/dev/null || :
if [ -f "$response_dir/stderr" ]; then
  cat "$response_dir/stderr" >&2
  exit 1
fi
response="$response_dir/$4"
if [ -f "$response" ]; then
  cat "$response"
  exit 0
fi
exit 1
`

const installWatchmanStub = ({
  fixture,
  name,
}: {
  readonly fixture: Fixture
  readonly name: string
}): Effect.Effect<WatchmanStub> =>
  Effect.promise(async () => {
    const executable = NodePath.join(fixture.root, `fake-watchman-${name}`)
    const argvFile = NodePath.join(fixture.root, `watchman-argv-${name}`)
    const responseDir = NodePath.join(fixture.root, `watchman-responses-${name}`)
    await mkdir(responseDir, { recursive: true })
    await writeFile(
      executable,
      watchmanStubSource({
        argvFile,
        responseDir,
        lockPath: NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json'),
      }),
    )
    await chmod(executable, 0o755)
    return { executable, argvFile, responseDir }
  })

type WatchmanStubFile = 'get-config' | 'watch-del' | 'stderr'

const setWatchmanResponse = ({
  stub,
  command,
  body,
}: {
  readonly stub: WatchmanStub
  readonly command: WatchmanStubFile
  readonly body: string
}): Effect.Effect<void> =>
  Effect.promise(() => writeFile(NodePath.join(stub.responseDir, command), body))

const clearWatchmanResponse = ({
  stub,
  command,
}: {
  readonly stub: WatchmanStub
  readonly command: WatchmanStubFile
}): Effect.Effect<void> =>
  Effect.promise(() => rm(NodePath.join(stub.responseDir, command), { force: true }))

/** The publisher lock that was live while the stub answered one command, if any. */
const watchmanObservedLock = ({
  stub,
  command,
}: {
  readonly stub: WatchmanStub
  readonly command: 'get-config' | 'watch-del'
}): Effect.Effect<CompositionPublisherLock | undefined> =>
  Effect.gen(function* () {
    const contents = yield* Effect.promise(() =>
      readFile(NodePath.join(stub.responseDir, `lock-${command}`), 'utf8'),
    )
    if (contents.trim() === '') return undefined
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CompositionPublisherLockSchema),
      {
        onExcessProperty: 'error',
      },
    )(contents)
  }).pipe(Effect.orDie)

const watchmanInvocations = (argvFile: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() =>
    readFile(argvFile, 'utf8').then(
      (contents) => contents.split('\n').filter((line) => line !== ''),
      (cause: unknown) => {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return []
        }
        throw cause
      },
    ),
  )

interface Fixture {
  readonly root: string
  readonly workspaceRoot: ReturnType<typeof EffectPath.unsafe.absoluteDir>
  readonly buckExecutable: string
  readonly watchmanExecutable: string
  readonly watchmanArgvFile: string
  readonly watchmanResponseDir: string
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
      const watchmanExecutable = NodePath.join(root, 'fake-watchman')
      const watchmanArgvFile = NodePath.join(root, 'watchman-argv')
      const watchmanResponseDir = NodePath.join(root, 'watchman-responses')
      await mkdir(watchmanResponseDir, { recursive: true })
      // A freshly created temporary workspace is not watched by anything, so that is the default
      // observation; a test that needs a live root writes its own `get-config` response.
      await writeFile(
        NodePath.join(watchmanResponseDir, 'get-config'),
        watchmanResponses.notWatched(root),
      )
      await writeFile(
        watchmanExecutable,
        watchmanStubSource({
          argvFile: watchmanArgvFile,
          responseDir: watchmanResponseDir,
          lockPath: NodePath.join(root, '.megarepo/composition-publisher.lock.json'),
        }),
      )
      await chmod(watchmanExecutable, 0o755)
      return {
        root,
        workspaceRoot: EffectPath.unsafe.absoluteDir(`${root}/`),
        buckExecutable,
        watchmanExecutable,
        watchmanArgvFile,
        watchmanResponseDir,
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
  watchmanExecutable,
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
  readonly watchmanExecutable?: string
}): PublishCompositionRootOptions => ({
  workspaceRoot: fixture.workspaceRoot,
  configMemberKeys: memberKeys,
  ownedMemberKey,
  compositionConfig: compositionConfig(platformHub, isolationDir),
  resolvedBuckExecutable: fixture.buckExecutable,
  resolvedWatchmanExecutable: watchmanExecutable ?? fixture.watchmanExecutable,
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
    resolvedWatchmanExecutable: options.resolvedWatchmanExecutable,
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

  it.effect('converges a stale generated root with unchanged members, then stays a no-op', () =>
    Effect.scoped(
      Effect.gen(function* () {
        // An existing workspace published by an older generator: its files and ownership manifest
        // agree with each other but not with what the current generator renders. An ordinary
        // apply, with no member change at all, must converge them and then do nothing.
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'stale-initial' }),
        )
        const wrapperPath = NodePath.join(fixture.root, '.megarepo/bin/buck2')
        const manifestPath = NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)
        const staleWrapper = yield* Effect.promise(() => readFile(wrapperPath, 'utf8'))
        const staleManifest = yield* Effect.promise(() => readFile(manifestPath, 'utf8'))
        const nextWatchmanDirectory = NodePath.join(fixture.root, 'next-watchman')
        const nextWatchman = NodePath.join(nextWatchmanDirectory, 'watchman')
        yield* Effect.promise(async () => {
          await mkdir(nextWatchmanDirectory)
          await writeFile(
            nextWatchman,
            watchmanStubSource({
              argvFile: NodePath.join(fixture.root, 'watchman-argv-next'),
              responseDir: fixture.watchmanResponseDir,
              lockPath: NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json'),
            }),
          )
          await chmod(nextWatchman, 0o755)
        })
        const converge = optionsFor({
          fixture,
          memberKeys: ['alpha'],
          lockToken: 'stale-converge',
          watchmanExecutable: nextWatchman,
        })
        const converged = yield* publishCompositionRoot(converge)
        expect(converged.changedPaths).toContain('.megarepo/bin/buck2')
        const wrapper = yield* Effect.promise(() => readFile(wrapperPath, 'utf8'))
        expect(wrapper).not.toBe(staleWrapper)
        expect(wrapper).toContain(`PATH='${nextWatchmanDirectory}'`)
        const info = yield* Effect.promise(() => stat(wrapperPath))
        expect(info.mode & 0o777).toBe(0o755)
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf8'))
        expect(manifest).not.toBe(staleManifest)
        expect(manifest).toContain(`sha256:${createHash('sha256').update(wrapper).digest('hex')}`)
        const before = new Map(
          yield* Effect.promise(() =>
            Promise.all(
              generatedPaths.map(async (path) => {
                const entry = await stat(NodePath.join(fixture.root, path))
                return [path, { mtimeMs: entry.mtimeMs, mode: entry.mode & 0o777 }] as const
              }),
            ),
          ),
        )
        const repeated = yield* publishCompositionRoot(converge)
        expect(repeated.changedPaths).toEqual([])
        for (const path of generatedPaths) {
          const entry = yield* Effect.promise(() => stat(NodePath.join(fixture.root, path)))
          expect(entry.mtimeMs).toBe(before.get(path)?.mtimeMs)
          expect(entry.mode & 0o777).toBe(before.get(path)?.mode)
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
          resolvedWatchmanExecutable: fixture.watchmanExecutable,
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

  it.effect('removes the watch of a live root whose loaded exclusion is stale', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'stale' })
        // The incident shape: a live watched root constructed before any `.watchmanconfig`.
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedEmptyConfig,
        })
        yield* setWatchmanResponse({
          stub,
          command: 'watch-del',
          body: watchmanResponses.deleted(fixture.root),
        })
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(result.changedPaths).toContain('.watchmanconfig')
        expect(result.watchmanInvalidation).toEqual({ _tag: 'Removed' })
        expect(yield* watchmanInvocations(stub.argvFile)).toEqual([
          `--no-spawn --no-local --no-pretty get-config ${fixture.root}`,
          `--no-spawn --no-local --no-pretty watch-del ${fixture.root}`,
        ])
      }),
    ),
  )

  it.effect('leaves a live root alone when it already loaded the published exclusion', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'equal' })
        const published = generateCompositionRoot({
          schemaVersion: 1,
          members: [{ memberKey: 'alpha', manifest: memberManifest({ memberKey: 'alpha' }) }],
          platformHubCell: 'alpha',
          isolationDir: 'megarepo',
          cacheSections: [],
          additionalProjectIgnores: [],
          resolvedBuckExecutable: fixture.buckExecutable,
          resolvedWatchmanExecutable: stub.executable,
        })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedConfig(generatedWatchmanIgnoreDirs(published)),
        })
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(result.changedPaths).toContain('.watchmanconfig')
        expect(result.watchmanInvalidation).toEqual({ _tag: 'Unchanged' })
        // Observed equality is proof: the watch is never torn down for nothing.
        expect(yield* watchmanInvocations(stub.argvFile)).toEqual([
          `--no-spawn --no-local --no-pretty get-config ${fixture.root}`,
        ])
      }),
    ),
  )

  // Byte-diff gating would skip this: nothing is published, yet the live root is stale.
  it.effect('reconciles a stale live root even when the published files do not change', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'unchanged-file' })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedConfig(['buck-out']),
        })
        yield* setWatchmanResponse({
          stub,
          command: 'watch-del',
          body: watchmanResponses.deleted(fixture.root),
        })
        const repeat = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(repeat.changedPaths).toEqual([])
        expect(repeat.watchmanInvalidation).toEqual({ _tag: 'Removed' })
      }),
    ),
  )

  it.effect('tolerates a service that holds no watch on this root', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const result = yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        expect(result.watchmanInvalidation).toEqual({ _tag: 'NotWatched' })
        expect(yield* watchmanInvocations(fixture.watchmanArgvFile)).toEqual([
          `--no-spawn --no-local --no-pretty get-config ${fixture.root}`,
        ])
      }),
    ),
  )

  // Measured `--no-spawn --no-local` no-service signature: non-zero exit, nothing on either
  // stream. A first apply on a machine whose daemon never ran must still succeed, and a service
  // that is not running cannot be holding a stale root, so nothing is repaired or remembered.
  it.effect('tolerates a silent transport and reports the watch state as unobserved', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'no-server' })
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(result.watchmanInvalidation).toEqual({ _tag: 'Unavailable' })
        expect(result.changedPaths).toContain('.watchmanconfig')

        // A later apply observes the now-live stale root; no marker was needed to remember.
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedEmptyConfig,
        })
        yield* setWatchmanResponse({
          stub,
          command: 'watch-del',
          body: watchmanResponses.deleted(fixture.root),
        })
        const later = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(later.watchmanInvalidation).toEqual({ _tag: 'Removed' })
      }),
    ),
  )

  // An empty stdout alone is not the no-service signature: a mid-protocol failure carries a
  // diagnostic on stderr, and that diagnostic must reach the caller.
  it.effect('surfaces a mid-protocol failure that writes only to stderr', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'protocol' })
        yield* setWatchmanResponse({
          stub,
          command: 'stderr',
          body: 'unable to talk to your watchman on /run/watchman/schickling-state/sock! (Connection reset by peer)\n',
        })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
          ),
        )
        expect(error.reason).toBe('WatchmanInvalidationFailed')
        expect(error.message).toContain('unable to talk to your watchman')
        expect(error.message).toContain('Connection reset by peer')
        expect(error.message).toContain('stdout: <empty>')
        // Publication itself stands; only reconciliation failed.
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain('[cells]')
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)

        // The identical rerun retries reconciliation with no marker to consult and no byte change.
        yield* clearWatchmanResponse({ stub, command: 'stderr' })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedEmptyConfig,
        })
        yield* setWatchmanResponse({
          stub,
          command: 'watch-del',
          body: watchmanResponses.deleted(fixture.root),
        })
        const rerun = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
        )
        expect(rerun.changedPaths).toEqual([])
        expect(rerun.watchmanInvalidation).toEqual({ _tag: 'Removed' })
      }),
    ),
  )

  it.effect('surfaces a root-resolution refusal that is not a missing watch', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'refusal' })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.illegalFstype(fixture.root),
        })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
          ),
        )
        expect(error.reason).toBe('WatchmanInvalidationFailed')
        expect(error.message).toContain('disallowed by global config illegal_fstypes')
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain('[cells]')
      }),
    ),
  )

  it.effect('surfaces a resolved watchman executable that cannot run', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              memberKeys: ['alpha'],
              watchmanExecutable: NodePath.join(fixture.root, 'absent-watchman'),
            }),
          ),
        )
        expect(error.reason).toBe('WatchmanInvalidationFailed')
        expect(error.message).toContain('Could not run the resolved Watchman executable')
      }),
    ),
  )

  /**
   * Reproduces a workspace published by a generator that did not own `.watchmanconfig` yet: the
   * manifest lists the older file set and the new file is absent. Publication must converge it
   * without any upgrade shim.
   */
  const degradeToOlderGeneration = (fixture: Fixture): Effect.Effect<void> =>
    Effect.gen(function* () {
      const manifestPath = NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)
      const manifest = decodeGenerationManifestJson(
        yield* Effect.promise(() => readFile(manifestPath, 'utf8')),
      )
      const olderGeneration = yield* Schema.encodeEffect(GenerationManifestJson)({
        ...manifest,
        files: manifest.files.filter((file) => file.path !== '.watchmanconfig'),
      })
      yield* Effect.promise(async () => {
        await writeFile(manifestPath, `${olderGeneration}\n`)
        await rm(NodePath.join(fixture.root, '.watchmanconfig'), { force: true })
      })
    }).pipe(Effect.orDie)

  it.effect('converges a workspace whose manifest predates the watchman config', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        yield* degradeToOlderGeneration(fixture)

        const converged = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'older-generation' }),
        )
        expect(converged.changedPaths).toContain('.watchmanconfig')
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WatchmanConfigSchema))(
            (yield* readGenerated(fixture, '.watchmanconfig')).toString(),
          ),
        ).toEqual({ ignore_dirs: expect.any(Array) })
        const manifest = decodeGenerationManifestJson(
          (yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)).toString(),
        )
        expect(manifest.files.map((file) => file.path)).toContain('.watchmanconfig')

        // And the converged root then stays a no-op.
        const repeat = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'older-generation-repeat' }),
        )
        expect(repeat.changedPaths).toEqual([])
      }),
    ),
  )

  it.effect('refuses a foreign file at a generated path the manifest does not own', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        yield* degradeToOlderGeneration(fixture)
        yield* Effect.promise(() =>
          writeFile(
            NodePath.join(fixture.root, '.watchmanconfig'),
            '{"ignore_dirs":["foreign"]}\n',
          ),
        )

        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'foreign-unowned' }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        expect((yield* readGenerated(fixture, '.watchmanconfig')).toString()).toBe(
          '{"ignore_dirs":["foreign"]}\n',
        )
      }),
    ),
  )

  it.effect('tears down a workspace whose manifest predates the watchman config', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        yield* degradeToOlderGeneration(fixture)

        const result = yield* teardownCompositionRoot({
          workspaceRoot: fixture.workspaceRoot,
          lock: { owner: 'publisher-test', token: 'older-teardown' },
        })
        expect(result.removedPaths).toContain('.buckconfig')
        expect(result.removedPaths).not.toContain('.watchmanconfig')
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)
      }),
    ),
  )

  const refusesRelease = ({
    name,
    body,
  }: {
    readonly name: string
    readonly body: (root: string) => string
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: `release-${name}` })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedEmptyConfig,
        })
        yield* setWatchmanResponse({ stub, command: 'watch-del', body: body(fixture.root) })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({ fixture, memberKeys: ['alpha'], watchmanExecutable: stub.executable }),
          ),
        )
        expect(error.reason).toBe('WatchmanInvalidationFailed')
        expect(error.message).toContain('did not release this root')
        // The publication stands and the lock is released; only the watch is unproven.
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain('[cells]')
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    )

  it.effect('refuses a watch-del response that confirms no release', () =>
    refusesRelease({ name: 'unconfirmed', body: () => watchmanResponses.unconfirmedRelease }),
  )

  it.effect('refuses a watch-del response that names another root', () =>
    refusesRelease({ name: 'other-root', body: watchmanResponses.releasedOtherRoot }),
  )

  /**
   * Reconciliation observes and releases a watch that belongs to this workspace, so it must be
   * serialized with publication rather than run after the lock is dropped, where an overlapping
   * generation could interleave. The stub records the live publisher lock at the instant each
   * Watchman command runs, which states the invariant without timing games; the existing
   * concurrent-publisher test covers what that lock excludes.
   */
  it.effect('holds the exclusive publisher lock across watch reconciliation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'lock-scope' })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.loadedEmptyConfig,
        })
        yield* setWatchmanResponse({
          stub,
          command: 'watch-del',
          body: watchmanResponses.deleted(fixture.root),
        })

        const result = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            memberKeys: ['alpha'],
            lockToken: 'reconcile-holder',
            watchmanExecutable: stub.executable,
          }),
        )
        expect(result.watchmanInvalidation).toEqual({ _tag: 'Removed' })

        for (const command of ['get-config', 'watch-del'] as const) {
          const observed = yield* watchmanObservedLock({ stub, command })
          expect(observed?.token).toBe('reconcile-holder')
          expect(observed?.owner).toBe('publisher-test')
        }
        // The lock is released once reconciliation finishes.
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('releases the publisher lock when reconciliation fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const stub = yield* installWatchmanStub({ fixture, name: 'lock-release' })
        yield* setWatchmanResponse({ stub, command: 'stderr', body: 'broken pipe\n' })
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              memberKeys: ['alpha'],
              lockToken: 'reconcile-failure',
              watchmanExecutable: stub.executable,
            }),
          ),
        )
        expect((yield* watchmanObservedLock({ stub, command: 'get-config' }))?.token).toBe(
          'reconcile-failure',
        )
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)

        // A later publisher takes the lock cleanly, so nothing was parked for recovery.
        yield* clearWatchmanResponse({ stub, command: 'stderr' })
        yield* setWatchmanResponse({
          stub,
          command: 'get-config',
          body: watchmanResponses.notWatched(fixture.root),
        })
        const recovered = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            memberKeys: ['alpha'],
            lockToken: 'reconcile-after-failure',
            watchmanExecutable: stub.executable,
          }),
        )
        expect(recovered.watchmanInvalidation).toEqual({ _tag: 'NotWatched' })
      }),
    ),
  )
})
