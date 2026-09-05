import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canonicalTreeFingerprint,
  checkEditorView,
  publishEditorView,
  recoverEditorViewLock,
  verifyEditorViewSnapshot,
  type EditorViewOptions,
} from './editor-view.ts'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const cp = requireTool('CP_BIN')
const mv = requireTool('MV_BIN')
const falseTool = requireTool('FALSE_BIN')

type Fixture = {
  readonly root: string
  readonly packageDir: string
  readonly editorRoot: string
  readonly editorInputs: string
  readonly nodeModules: string
  readonly options: EditorViewOptions
  readonly workspaceAuthority: string
  readonly consumerCache: string
}

/** One package view fixture; `packageName` also names the published editor view. */
const makeFixture = ({ packageName = 'tui-core' }: { packageName?: string } = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'editor-view-integration-'))
  const packagePath = `packages/@overeng/${packageName}`
  const packageDir = join(root, 'packages', '@overeng', packageName)
  const editorRoot = join(root, 'packages', '.editor-view')
  const editorInputs = join(root, 'inputs', 'editor_inputs')
  const nodeModules = join(root, 'inputs', 'node_modules')
  const workspaceAuthority = join(root, 'workspace-authority.json')
  const consumerCache = join(root, '.devenv', 'vite-cache', packageName)
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{}\n')
  writeFileSync(join(packageDir, 'node_modules', 'legacy-root-install'), 'retained')
  mkdirSync(editorInputs, { recursive: true })
  writeFileSync(join(editorInputs, 'install-descriptor.json'), '{"revision":1}\n')
  mkdirSync(join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true })
  writeFileSync(
    join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
    'export default 1\n',
  )
  symlinkSync('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep'))
  writeFileSync(
    workspaceAuthority,
    `${JSON.stringify({
      schema: 'effect-utils/workspace-dependency-authority/v1',
      requiredPackages: [packagePath],
      ownedPackages: [packagePath],
    })}\n`,
  )
  const options: EditorViewOptions = {
    repoRoot: root,
    package: packagePath,
    viewName: packageName,
    cell: packageName,
    target: `//${packagePath}:editor_inputs`,
    editorInputs,
    nodeModules,
    cp,
    workspaceAuthority,
    consumerCache,
    snapshotRetention: 2,
    mv,
  }
  return {
    root,
    packageDir,
    editorRoot,
    editorInputs,
    nodeModules,
    workspaceAuthority,
    consumerCache,
    options,
  }
}
const makeWritable = (path: string): void => {
  const status = lstatSync(path)
  if (status.isSymbolicLink() === true) return
  if (status.isDirectory() === true) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) makeWritable(join(path, name))
    return
  }
  chmodSync(path, 0o600)
}

const cleanup = (fixture: Fixture): void => {
  makeWritable(fixture.root)
  rmSync(fixture.root, { recursive: true, force: true })
}

const currentTarget = (fixture: Fixture): string =>
  readlinkSync(join(fixture.editorRoot, fixture.options.viewName))

const recordPath = (fixture: Fixture, target = currentTarget(fixture)): string =>
  join(fixture.editorRoot, target, 'editor-view.json')

const ownedSnapshots = (fixture: Fixture): readonly string[] =>
  readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
    name.startsWith(`${fixture.options.viewName}-`),
  )

describe('editor view publisher', () => {
  it('fingerprints deterministically with byte ordering, path framing, and dereferencing', async () => {
    const fixture = makeFixture()
    try {
      const second = join(fixture.root, 'second')
      const collisionShape = join(fixture.root, 'collision')
      mkdirSync(second)
      writeFileSync(join(second, 'z'), 'last')
      mkdirSync(join(second, 'a'))
      writeFileSync(join(second, 'a', 'bc'), 'value')
      const first = join(fixture.root, 'first')
      mkdirSync(join(first, 'a'), { recursive: true })
      writeFileSync(join(first, 'a', 'bc'), 'value')
      writeFileSync(join(first, 'z'), 'last')
      mkdirSync(join(collisionShape, 'ab'), { recursive: true })
      writeFileSync(join(collisionShape, 'ab', 'c'), 'value')
      writeFileSync(join(collisionShape, 'z'), 'last')

      const fingerprint = await canonicalTreeFingerprint({ tree: first })
      expect(await canonicalTreeFingerprint({ tree: second })).toBe(fingerprint)
      expect(await canonicalTreeFingerprint({ tree: collisionShape })).not.toBe(fingerprint)

      // A dereferenced view digest equals the plain digest of the same bytes
      // materialized without links, which is what the byte snapshot contains.
      const linked = join(fixture.root, 'linked')
      mkdirSync(join(linked, 'real'), { recursive: true })
      writeFileSync(join(linked, 'real', 'index.js'), 'export default 1\n')
      symlinkSync('real', join(linked, 'alias'))
      const materialized = join(fixture.root, 'materialized')
      mkdirSync(join(materialized, 'alias'), { recursive: true })
      mkdirSync(join(materialized, 'real'))
      writeFileSync(join(materialized, 'alias', 'index.js'), 'export default 1\n')
      writeFileSync(join(materialized, 'real', 'index.js'), 'export default 1\n')
      expect(await canonicalTreeFingerprint({ tree: linked, dereference: true })).toBe(
        await canonicalTreeFingerprint({ tree: materialized }),
      )
      expect(await canonicalTreeFingerprint({ tree: linked })).not.toBe(
        await canonicalTreeFingerprint({ tree: linked, dereference: true }),
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes a dereferenced byte-owned snapshot with distinct inodes and stable hops', async () => {
    const fixture = makeFixture()
    try {
      const packageManifest = join(fixture.packageDir, 'package.json')
      const manifestContent = readFileSync(packageManifest)
      const manifestIdentity = statSync(packageManifest, { bigint: true }).ino
      const record = await publishEditorView(fixture.options)
      expect(readFileSync(packageManifest)).toEqual(manifestContent)
      expect(statSync(packageManifest, { bigint: true }).ino).not.toBe(manifestIdentity)
      expect(statSync(fixture.consumerCache).mode & 0o200).not.toBe(0)
      expect(readlinkSync(join(fixture.packageDir, 'node_modules'))).toBe(
        '../../.editor-view/tui-core/node_modules',
      )
      expect(readlinkSync(join(fixture.editorRoot, 'tui-core'))).toBe(
        `.store/tui-core-${record.editorInputsFingerprint}`,
      )
      expect(record.byteSnapshotDigest).toBe(record.normalizedStoreDigest)
      expect(record.selectedViewDigest).not.toBe(record.normalizedStoreDigest)
      const snapshotRoot = join(fixture.editorRoot, record.snapshot)
      const admittedFile = join(
        fixture.nodeModules,
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const snapshotFile = join(
        snapshotRoot,
        'node_modules',
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const admittedStatus = statSync(admittedFile, { bigint: true })
      const snapshotStatus = lstatSync(snapshotFile, { bigint: true })
      expect(snapshotStatus.isFile()).toBe(true)
      expect([snapshotStatus.dev, snapshotStatus.ino]).not.toEqual([
        admittedStatus.dev,
        admittedStatus.ino,
      ])
      expect(snapshotStatus.nlink).toBe(1n)
      // The admitted view's symlink is dereferenced into owned bytes.
      const dereferenced = join(snapshotRoot, 'node_modules', 'dep')
      expect(lstatSync(dereferenced).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dereferenced, 'index.js'), 'utf8')).toBe('export default 1\n')
      expect(statSync(snapshotRoot).mode & 0o222).toBe(0)
      expect(statSync(join(snapshotRoot, 'node_modules')).mode & 0o222).toBe(0)
      expect(statSync(join(snapshotRoot, 'node_modules', '.pnpm')).mode & 0o222).toBe(0)
      expect(statSync(snapshotFile).mode & 0o222).toBe(0)
      expect(statSync(recordPath(fixture)).mode & 0o222).toBe(0)
      const legacyEntries = readdirSync(join(fixture.editorRoot, '.legacy'))
      expect(legacyEntries).toHaveLength(1)
      expect(
        readFileSync(
          join(fixture.editorRoot, '.legacy', legacyEntries[0]!, 'legacy-root-install'),
          'utf8',
        ),
      ).toBe('retained')
      const before = statSync(recordPath(fixture), { bigint: true }).mtimeNs
      await publishEditorView(fixture.options)
      expect(statSync(recordPath(fixture), { bigint: true }).mtimeNs).toBe(before)
      expect(readdirSync(join(fixture.editorRoot, '.legacy'))).toEqual(legacyEntries)
      await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  it('survives deletion of every backing artifact', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      rmSync(join(fixture.root, 'inputs'), { recursive: true, force: true })
      expect(
        readFileSync(join(fixture.packageDir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      ).toBe('export default 1\n')
      await expect(verifyEditorViewSnapshot(fixture.options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  it('atomically flips old to new while retaining the bounded rollback snapshot', async () => {
    const fixture = makeFixture()
    try {
      const oldRecord = await publishEditorView(fixture.options)
      const oldTarget = currentTarget(fixture)
      const firstHopBefore = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const refreshedNodeModules = join(fixture.root, 'inputs', 'node_modules-v2')
      mkdirSync(join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), {
        recursive: true,
      })
      writeFileSync(
        join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
        'export default 2\n',
      )
      symlinkSync('.pnpm/dep@1/node_modules/dep', join(refreshedNodeModules, 'dep'))
      const refreshedOptions = { ...fixture.options, nodeModules: refreshedNodeModules }
      const newRecord = await publishEditorView(refreshedOptions)
      expect(newRecord.editorInputsFingerprint).not.toBe(oldRecord.editorInputsFingerprint)
      expect(currentTarget(fixture)).not.toBe(oldTarget)
      expect(
        readFileSync(join(fixture.editorRoot, oldTarget, 'editor-view.json'), 'utf8'),
      ).toContain(oldRecord.editorInputsFingerprint)
      expect(
        readFileSync(
          join(fixture.editorRoot, oldTarget, 'node_modules', 'dep', 'index.js'),
          'utf8',
        ),
      ).toBe('export default 1\n')
      const firstHopAfter = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
      expect([firstHopAfter.dev, firstHopAfter.ino]).toEqual([
        firstHopBefore.dev,
        firstHopBefore.ino,
      ])
      expect(ownedSnapshots(fixture)).toHaveLength(2)
    } finally {
      cleanup(fixture)
    }
  })
  it('keeps the current and previous snapshots while preserving in-flight candidates', async () => {
    const fixture = makeFixture()
    try {
      const oldest = await publishEditorView(fixture.options)
      const inFlight = join(fixture.editorRoot, '.store', '.candidate-in-flight')
      mkdirSync(inFlight)
      for (const revision of [2, 3]) {
        writeFileSync(
          join(fixture.editorInputs, 'install-descriptor.json'),
          `${JSON.stringify({ revision })}\n`,
        )
        const nodeModules = join(fixture.root, 'inputs', `node_modules-v${revision}`)
        mkdirSync(join(nodeModules, 'dep'), { recursive: true })
        writeFileSync(join(nodeModules, 'dep', 'index.js'), `export default ${revision}\n`)
        await publishEditorView({ ...fixture.options, nodeModules })
      }
      const snapshots = ownedSnapshots(fixture)
      expect(snapshots).toHaveLength(2)
      expect(snapshots).toContain(currentTarget(fixture).replace('.store/', ''))
      expect(snapshots).not.toContain(`tui-core-${oldest.editorInputsFingerprint}`)
      expect(statSync(inFlight).isDirectory()).toBe(true)
      const retention = JSON.parse(
        readFileSync(
          join(fixture.editorRoot, `.retention-${fixture.options.viewName}.json`),
          'utf8',
        ),
      ) as { snapshots: readonly string[] }
      expect(retention.snapshots).toHaveLength(2)
      expect(retention.snapshots[0]).toBe(currentTarget(fixture).replace('.store/', ''))
    } finally {
      cleanup(fixture)
    }
  })

  it('fails closed on incomplete whole-workspace authority and cache paths inside the package', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core', 'packages/@overeng/tui-react'],
          ownedPackages: ['packages/@overeng/buck2-tools', 'packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'missing=["packages/@overeng/tui-react"] extra=["packages/@overeng/buck2-tools"]',
      )
      expect(() => lstatSync(fixture.editorRoot)).toThrow()

      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core'],
          ownedPackages: ['packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(
        publishEditorView({
          ...fixture.options,
          consumerCache: join(fixture.packageDir, '.vite'),
        }),
      ).rejects.toThrow('consumer cache must be inside the repository and outside package')
    } finally {
      cleanup(fixture)
    }
  })

  it('accepts links into declared backing roots and rejects undeclared escapes', async () => {
    const fixture = makeFixture()
    try {
      const backingRoot = join(fixture.root, 'inputs', 'store-entry')
      mkdirSync(join(backingRoot, 'dep'), { recursive: true })
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "external"\n')
      const linkedView = join(fixture.root, 'inputs', 'node_modules-linked')
      mkdirSync(linkedView)
      symlinkSync(join(backingRoot, 'dep'), join(linkedView, 'dep'))

      await expect(
        publishEditorView({ ...fixture.options, nodeModules: linkedView }),
      ).rejects.toThrow('outside declared backing roots')
      expect(ownedSnapshots(fixture)).toHaveLength(0)

      const options = {
        ...fixture.options,
        nodeModules: linkedView,
        backingRoots: [backingRoot],
      }
      const record = await publishEditorView(options)
      expect(
        readFileSync(
          join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js'),
          'utf8',
        ),
      ).toBe('export default "external"\n')
      await expect(checkEditorView(options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }

    const residual = makeFixture()
    try {
      const record = await publishEditorView(residual.options)
      const snapshotNodeModules = join(residual.editorRoot, record.snapshot, 'node_modules')
      chmodSync(snapshotNodeModules, 0o700)
      symlinkSync('dep', join(snapshotNodeModules, 'alias'))
      chmodSync(snapshotNodeModules, 0o555)
      await expect(verifyEditorViewSnapshot(residual.options)).rejects.toThrow(
        'snapshot contains a symbolic link',
      )
    } finally {
      cleanup(residual)
    }
  })

  it('publishes a finite byte-owned snapshot of a declared cyclic store component', async () => {
    const fixture = makeFixture()
    try {
      const view = join(fixture.root, 'inputs', 'cyclic-view')
      const group = join(fixture.root, 'inputs', 'cyclic-group')
      const aModules = join(group, 'a-key', 'node_modules')
      const bModules = join(group, 'b-key', 'node_modules')
      mkdirSync(join(aModules, 'a'), { recursive: true })
      mkdirSync(join(bModules, 'b'), { recursive: true })
      writeFileSync(join(aModules, 'a', 'index.js'), 'export const name = "a"\n')
      writeFileSync(join(bModules, 'b', 'index.js'), 'export const name = "b"\n')
      symlinkSync('../../b-key/node_modules/b', join(aModules, 'b'))
      symlinkSync('../../a-key/node_modules/a', join(bModules, 'a'))
      mkdirSync(view)
      symlinkSync(join(aModules, 'a'), join(view, 'a'))

      const options = {
        ...fixture.options,
        nodeModules: view,
        backingRoots: [view, group, group],
      }
      const record = await publishEditorView(options)
      const snapshot = join(fixture.editorRoot, record.snapshot)
      expect(readlinkSync(join(snapshot, 'node_modules', 'a'))).not.toContain(fixture.root)
      const ownedA = realpathSync(join(snapshot, 'node_modules', 'a'))
      const ownedB = realpathSync(join(dirname(ownedA), 'b'))
      expect(readFileSync(join(ownedA, 'index.js'), 'utf8')).toBe('export const name = "a"\n')
      expect(readFileSync(join(ownedB, 'index.js'), 'utf8')).toBe('export const name = "b"\n')
      expect(realpathSync(join(dirname(ownedB), 'a'))).toBe(ownedA)
      expect(readdirSync(join(snapshot, '.backing'))).toHaveLength(1)

      rmSync(join(fixture.root, 'inputs'), { recursive: true, force: true })
      await expect(verifyEditorViewSnapshot(fixture.options)).resolves.toEqual(record)
      expect(readFileSync(join(ownedB, 'index.js'), 'utf8')).toBe('export const name = "b"\n')
    } finally {
      cleanup(fixture)
    }
  })

  it('detects a writable published snapshot even when its content digest is unchanged', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      chmodSync(join(fixture.editorRoot, currentTarget(fixture)), 0o700)
      await expect(checkEditorView(fixture.options)).rejects.toThrow(
        'snapshot immutability violation',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes, checks, and garbage-collects two package views independently', async () => {
    const first = makeFixture()
    const secondPackage = 'tui-react'
    const secondPackagePath = `packages/@overeng/${secondPackage}`
    const secondPackageDir = join(first.root, 'packages', '@overeng', secondPackage)
    const secondInputs = join(first.root, 'inputs', 'second-editor-inputs')
    const secondNodeModules = join(first.root, 'inputs', 'second-node-modules')
    const secondAuthority = join(first.root, 'second-workspace-authority.json')
    mkdirSync(join(secondPackageDir, 'node_modules'), { recursive: true })
    writeFileSync(join(secondPackageDir, 'package.json'), '{}\n')
    mkdirSync(secondInputs)
    writeFileSync(join(secondInputs, 'install-descriptor.json'), '{"revision":1}\n')
    mkdirSync(join(secondNodeModules, 'dep'), { recursive: true })
    writeFileSync(join(secondNodeModules, 'dep', 'index.js'), 'export default "second"\n')
    writeFileSync(
      secondAuthority,
      `${JSON.stringify({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: [secondPackagePath],
        ownedPackages: [secondPackagePath],
      })}\n`,
    )
    const secondOptions: EditorViewOptions = {
      ...first.options,
      package: secondPackagePath,
      viewName: secondPackage,
      cell: secondPackage,
      target: `//${secondPackagePath}:editor_inputs`,
      editorInputs: secondInputs,
      nodeModules: secondNodeModules,
      workspaceAuthority: secondAuthority,
      consumerCache: join(first.root, '.devenv', 'vite-cache', secondPackage),
    }
    try {
      let firstCurrent = await publishEditorView(first.options)
      let secondCurrent = await publishEditorView(secondOptions)
      await expect(checkEditorView(first.options)).resolves.toEqual(firstCurrent)
      await expect(checkEditorView(secondOptions)).resolves.toEqual(secondCurrent)

      for (const revision of [2, 3]) {
        writeFileSync(
          join(first.editorInputs, 'install-descriptor.json'),
          `${JSON.stringify({ revision })}\n`,
        )
        const firstNodeModules = join(first.root, 'inputs', `first-node-modules-${revision}`)
        mkdirSync(join(firstNodeModules, 'dep'), { recursive: true })
        writeFileSync(join(firstNodeModules, 'dep', 'index.js'), `export default ${revision}\n`)
        firstCurrent = await publishEditorView({
          ...first.options,
          nodeModules: firstNodeModules,
        })

        writeFileSync(
          join(secondInputs, 'install-descriptor.json'),
          `${JSON.stringify({ revision })}\n`,
        )
        const secondRevisionModules = join(first.root, 'inputs', `second-node-modules-${revision}`)
        mkdirSync(join(secondRevisionModules, 'dep'), { recursive: true })
        writeFileSync(
          join(secondRevisionModules, 'dep', 'index.js'),
          `export default "second-${revision}"\n`,
        )
        secondCurrent = await publishEditorView({
          ...secondOptions,
          nodeModules: secondRevisionModules,
        })
      }

      expect(ownedSnapshots(first)).toHaveLength(2)
      expect(
        readdirSync(join(first.editorRoot, '.store')).filter((name) =>
          name.startsWith(`${secondPackage}-`),
        ),
      ).toHaveLength(2)
      await expect(
        checkEditorView({
          ...first.options,
          nodeModules: join(first.root, 'inputs', 'first-node-modules-3'),
        }),
      ).resolves.toEqual(firstCurrent)
      await expect(
        checkEditorView({
          ...secondOptions,
          nodeModules: join(first.root, 'inputs', 'second-node-modules-3'),
        }),
      ).resolves.toEqual(secondCurrent)
    } finally {
      cleanup(first)
    }
  })
  it('refuses garbage collection when snapshot ownership is ambiguous', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const current = currentTarget(fixture)
      mkdirSync(join(fixture.editorRoot, '.store', 'unowned'))
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'snapshot store contains an ambiguously owned entry',
      )
      expect(currentTarget(fixture)).toBe(current)
    } finally {
      cleanup(fixture)
    }
  })

  it('leaves the old view current when byte snapshot creation fails before flip', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const oldTarget = currentTarget(fixture)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      await expect(publishEditorView({ ...fixture.options, cp: falseTool })).rejects.toThrow(
        'cp --dereference --reflink=auto failed',
      )
      expect(currentTarget(fixture)).toBe(oldTarget)
      expect(ownedSnapshots(fixture)).toHaveLength(1)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).some((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toBe(false)
      await expect(checkEditorView(fixture.options)).rejects.toThrow(
        'editor_inputs fingerprint mismatch',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects an existing lock and requires exact-token explicit recovery', async () => {
    const fixture = makeFixture()
    try {
      mkdirSync(fixture.editorRoot, { recursive: true })
      const lock = join(fixture.editorRoot, '.publish.lock')
      mkdirSync(lock)
      writeFileSync(
        join(lock, 'owner.json'),
        '{"schema":"effect-utils/editor-view-lock/v1","token":"held-token","pid":1}\n',
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow('publication lock exists')
      expect(() => recoverEditorViewLock({ options: fixture.options, token: 'wrong' })).toThrow(
        'token mismatch',
      )
      expect(() =>
        recoverEditorViewLock({ options: fixture.options, token: 'held-token' }),
      ).not.toThrow()
      await expect(publishEditorView(fixture.options)).resolves.toBeDefined()
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes any admitted package identity and rejects mismatched identity', async () => {
    const fixture = makeFixture({ packageName: 'tui-react' })
    try {
      const record = await publishEditorView(fixture.options)
      expect(record.package).toBe('packages/@overeng/tui-react')
      expect(record.target).toBe('//packages/@overeng/tui-react:editor_inputs')
      expect(readlinkSync(join(fixture.packageDir, 'node_modules'))).toBe(
        '../../.editor-view/tui-react/node_modules',
      )
      expect(readlinkSync(join(fixture.editorRoot, 'tui-react'))).toBe(
        `.store/tui-react-${record.editorInputsFingerprint}`,
      )
      expect(record.snapshot).toBe(`.store/tui-react-${record.editorInputsFingerprint}`)
      await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
      await expect(
        publishEditorView({
          ...fixture.options,
          target: '//packages/@overeng/other:editor_inputs',
        }),
      ).rejects.toThrow('target must be the stable label')
      await expect(
        publishEditorView({ ...fixture.options, viewName: 'tui.react' }),
      ).rejects.toThrow('view name must be a portable identifier')
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects escaping and dangling current pointers with both fingerprints named', async () => {
    const escaping = makeFixture()
    try {
      const record = await publishEditorView(escaping.options)
      rmSync(join(escaping.editorRoot, 'tui-core'))
      symlinkSync('../../escape', join(escaping.editorRoot, 'tui-core'))
      await expect(checkEditorView(escaping.options)).rejects.toThrow(
        `recorded fingerprint=<invalid-pointer>; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(escaping)
    }

    const dangling = makeFixture()
    try {
      const record = await publishEditorView(dangling.options)
      rmSync(join(dangling.editorRoot, 'tui-core'))
      symlinkSync(
        `.store/tui-core-${record.editorInputsFingerprint}`,
        join(dangling.editorRoot, 'tui-core'),
      )
      makeWritable(
        join(dangling.editorRoot, '.store', `tui-core-${record.editorInputsFingerprint}`),
      )
      rmSync(join(dangling.editorRoot, '.store', `tui-core-${record.editorInputsFingerprint}`), {
        recursive: true,
      })
      await expect(checkEditorView(dangling.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(dangling)
    }
  })

  it('names recorded and current hashes for descriptor mismatch and mutated snapshot', async () => {
    const mismatch = makeFixture()
    try {
      const record = await publishEditorView(mismatch.options)
      writeFileSync(join(mismatch.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const current = await canonicalTreeFingerprint({ tree: mismatch.editorInputs })
      await expect(checkEditorView(mismatch.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${current}`,
      )
    } finally {
      cleanup(mismatch)
    }

    const mutated = makeFixture()
    try {
      const record = await publishEditorView(mutated.options)
      const snapshotNodeModules = join(mutated.editorRoot, record.snapshot, 'node_modules')
      chmodSync(snapshotNodeModules, 0o700)
      chmodSync(join(snapshotNodeModules, 'dep'), 0o700)
      rmSync(join(snapshotNodeModules, 'dep'), { recursive: true })
      chmodSync(snapshotNodeModules, 0o555)
      await expect(verifyEditorViewSnapshot(mutated.options)).rejects.toThrow(
        `snapshot byte digest mismatch`,
      )
      await expect(checkEditorView(mutated.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(mutated)
    }
  })

  it('refuses a store published by an earlier record schema', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const path = recordPath(fixture)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      chmodSync(path, 0o600)
      writeFileSync(
        path,
        `${JSON.stringify({
          schema: 'effect-utils/editor-view/v1',
          package: record.package,
          cell: record.cell,
          target: record.target,
          editorInputsFingerprint: record.editorInputsFingerprint,
          snapshot: record.snapshot,
          nodeModulesTreeDigest: record.byteSnapshotDigest,
        })}\n`,
      )
      chmodSync(path, 0o444)
      await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow(
        'was published by incompatible editor view schema effect-utils/editor-view/v1',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects unknown record fields and package paths containing symlink components', async () => {
    const malformed = makeFixture()
    try {
      await publishEditorView(malformed.options)
      const path = recordPath(malformed)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      record.untrusted = true
      chmodSync(path, 0o600)
      writeFileSync(path, `${JSON.stringify(record)}\n`)
      await expect(checkEditorView(malformed.options)).rejects.toThrow(
        'record has unknown or missing fields',
      )
    } finally {
      cleanup(malformed)
    }

    const root = mkdtempSync(join(tmpdir(), 'editor-view-symlink-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'editor-view-symlink-outside-'))
    try {
      mkdirSync(join(outside, 'packages', '@overeng', 'tui-core'), { recursive: true })
      symlinkSync(join(outside, 'packages'), join(root, 'packages'))
      const options = {
        ...malformed.options,
        repoRoot: root,
        editorInputs: join(outside, 'inputs'),
        nodeModules: join(outside, 'node_modules'),
      }
      await expect(publishEditorView(options)).rejects.toThrow(
        'package path must not contain symbolic links',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
