import { readdirSync, realpathSync, statSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodeBuckMemberManifest, type BuckMemberManifest } from '@overeng/megarepo/buck2-manifest'

import { requireTool } from '../../test-utils/require-tool.ts'
import { CompositionCapabilityResolutionError } from './composition-capability-resolver-schema.ts'
import {
  checkCompositionCapabilityProjection,
  resolveCompositionCapabilities,
  resolvedCompositionCapabilityByToolId,
  type CompositionCapabilityRuntime,
} from './composition-capability-resolver.ts'

/**
 * A member that ships its own capability projector under `scripts/`. mr is the sole
 * projector, so such a file is inert data the resolver must never read or execute.
 */
const MEMBER_PROJECTOR_FIXTURE = '#!/bin/sh\nexit 1\n'
const MEMBER_PROJECTOR_NAME = 'member-capability-projector.sh'

/** Every executable this file names comes from a Buck-declared tool, never from an ambient PATH. */
const shell = realpathSync(requireTool('BASH_BIN'))

const bashExecutable = shell
const bashOutput = NodePath.dirname(NodePath.dirname(bashExecutable))
const alternateExecutable = realpathSync(requireTool('GREP_BIN'))
const alternateOutput = NodePath.dirname(NodePath.dirname(alternateExecutable))

/**
 * A real store output holding a `bin/` entry whose realpath leaves that output — the exact shape
 * the resolver must refuse. Declared tool paths are realized inside their own output, so the
 * fixture is found among the store roots the sandbox exposes (all of them belong to the declared
 * tools' closures).
 */
const escapingStoreExecutable = ((): { readonly output: string; readonly executable: string } => {
  for (const entry of readdirSync('/nix/store')) {
    const output = `/nix/store/${entry}`
    let binEntries: ReadonlyArray<string>
    try {
      binEntries = readdirSync(NodePath.join(output, 'bin'))
    } catch {
      continue
    }
    const canonicalOutput = realpathSync(output)
    for (const name of binEntries.filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(entry))) {
      try {
        const target = realpathSync(NodePath.join(output, 'bin', name))
        if (
          statSync(target).isFile() === true &&
          target.startsWith(`${canonicalOutput}${NodePath.sep}`) === false
        ) {
          return { output, executable: `bin/${name}` }
        }
      } catch {
        continue
      }
    }
  }
  throw new Error('no store output with an escaping bin entry is visible to this test')
})()

const manifest = ({
  capabilities = [
    {
      toolId: 'buck2',
      protocol: 'facebook/buck2-cli/test',
      flakePackage: 'buck2',
      executable: 'bin/bash',
    },
  ],
}: {
  readonly capabilities?: BuckMemberManifest['capabilities']
} = {}): BuckMemberManifest =>
  decodeBuckMemberManifest({
    schemaVersion: 1,
    cell: 'fixture',
    mount: 'repos/fixture',
    projectIgnore: [],
    distOverlays: [],
    capabilities,
  })

interface Fixture {
  readonly root: string
  readonly memberRoot: string
  readonly scratchRoot: string
  readonly nixLog: string
  readonly nixModePath: string
  readonly nixOutputPath: string
  readonly runtime: CompositionCapabilityRuntime
}

const makeFixture = async ({
  projector,
}: { readonly projector?: string } = {}): Promise<Fixture> => {
  // Root the fixture at the physical temp dir. Composition refuses non-canonical
  // paths on purpose (the private-scratch identity guard compares realpath against
  // the path it was handed), and real callers reach it through paths the store or
  // Git already resolved. On macOS `os.tmpdir()` is under the /var -> /private/var
  // symlink; where nothing above it is a symlink this is the identity.
  const root = await mkdtemp(NodePath.join(realpathSync(tmpdir()), 'megarepo-capability-resolver-'))
  const memberRoot = NodePath.join(root, 'member')
  const scratchRoot = NodePath.join(root, 'scratch')
  const scripts = NodePath.join(memberRoot, 'scripts')
  const nixPath = NodePath.join(root, 'fake-nix')
  const nixLog = NodePath.join(root, 'nix.log')
  const nixModePath = NodePath.join(root, 'nix-mode')
  const nixOutputPath = NodePath.join(root, 'nix-output')
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(scratchRoot, { mode: 0o700 })])
  await chmod(scratchRoot, 0o700)
  await Promise.all([
    writeFile(nixModePath, 'one\n'),
    writeFile(nixOutputPath, `${bashOutput}\n`),
    writeFile(NodePath.join(memberRoot, 'flake.lock'), '{"nodes":{},"root":"root","version":7}\n'),
  ])
  await writeFile(
    nixPath,
    `#!${shell}\nset -eu\nprintf '%s\\n' "$*" >>"${nixLog}"\nIFS= read -r mode <"${nixModePath}"\nIFS= read -r output <"${nixOutputPath}"\ncase " $* " in\n  *" path-info "*)\n    case "$mode" in\n      closure-empty) exit 0 ;;\n      closure-nonstore) printf '/tmp/not-a-store-path\\n' ;;\n      closure-foreign) printf '/nix/store/00000000000000000000000000000000-foreign\\n' ;;\n      *) printf '%s\\n' "$output" ;;\n    esac\n    exit 0 ;;\nesac\ncase "$mode" in\n  missing) exit 0 ;;\n  duplicate) printf '%s\\n%s\\n' "$output" "$output" ;;\n  nonstore) printf '/tmp/not-a-store-output\\n' ;;\n  lock-write-attempt)\n    case " $* " in\n      *" --no-write-lock-file --no-update-lock-file "*) exit 73 ;;\n      *) printf 'mutated\\n' >"${memberRoot}/flake.lock"; exit 74 ;;\n    esac ;;\n  fail) exit 37 ;;\n  *) printf '%s\\n' "$output" ;;\nesac\n`,
    { mode: 0o755 },
  )
  await writeFile(
    NodePath.join(scripts, MEMBER_PROJECTOR_NAME),
    projector ?? MEMBER_PROJECTOR_FIXTURE,
    { mode: 0o644 },
  )
  return {
    root,
    memberRoot,
    scratchRoot,
    nixLog,
    nixModePath,
    nixOutputPath,
    runtime: {
      nixPath,
      env: {
        PATH: '/ambient-path-is-poison',
        GH_TOKEN: 'must-not-leak',
        SSH_AUTH_SOCK: '/hostile/agent.sock',
        HTTPS_PROXY: 'http://hostile.invalid',
      },
      nonce: () => 'candidate',
      createPrivateScratch: async () => {
        const path = await mkdtemp(NodePath.join(scratchRoot, 'private-'))
        await chmod(path, 0o700)
        return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
      },
    },
  }
}

const clean = async (fixture: Fixture): Promise<void> =>
  rm(fixture.root, { recursive: true, force: true })

const failure = async (
  promise: Promise<unknown>,
): Promise<CompositionCapabilityResolutionError> => {
  try {
    await promise
    throw new Error('expected resolver failure')
  } catch (cause) {
    expect(cause).toBeInstanceOf(CompositionCapabilityResolutionError)
    return cause as CompositionCapabilityResolutionError
  }
}

const resolve = (
  fixture: Fixture,
  overrides: Partial<Parameters<typeof resolveCompositionCapabilities>[0]> = {},
) =>
  resolveCompositionCapabilities({
    memberRoot: fixture.memberRoot,
    system: 'x86_64-linux',
    manifest: manifest(),
    dryRun: false,
    runtime: fixture.runtime,
    ...overrides,
  })

describe('composition capability resolver', () => {
  it.each(['defs.bzl', 'BUCK'] as const)(
    'trusted check rejects tampered %s bytes',
    async (name) => {
      const fixture = await makeFixture()
      try {
        const result = await resolve(fixture)
        if (result._tag !== 'Resolved') throw new Error('unreachable')
        const path = NodePath.join(result.projectionPath, name)
        await chmod(path, 0o644)
        await writeFile(path, 'tampered\n')
        await expect(
          checkCompositionCapabilityProjection({ memberRoot: result.candidateRoot }),
        ).rejects.toBeInstanceOf(CompositionCapabilityResolutionError)
        await result.release()
      } finally {
        await clean(fixture)
      }
    },
  )

  it('uses exact sorted Nix argv and pinned projector tools despite ambient PATH poison', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture, {
        manifest: manifest({
          capabilities: [
            {
              toolId: 'z-tool',
              protocol: 'test/z/v1',
              flakePackage: 'z-package',
              executable: 'bin/bash',
            },
            {
              toolId: 'a-tool',
              protocol: 'test/a/v1',
              flakePackage: 'a-package',
              executable: 'bin/bash',
            },
          ],
        }),
      })
      expect(result._tag).toBe('Resolved')
      if (result._tag !== 'Resolved') throw new Error('unreachable')
      expect(result.capabilities.map(({ capability }) => capability.toolId)).toEqual([
        'a-tool',
        'z-tool',
      ])
      expect(await readFile(fixture.nixLog, 'utf8')).toBe(
        `build --no-link --print-out-paths --no-write-lock-file --no-update-lock-file ${fixture.memberRoot}#a-package^out\n` +
          `path-info --recursive --offline --no-write-lock-file --no-update-lock-file ${fixture.memberRoot}#a-package^out\n` +
          `build --no-link --print-out-paths --no-write-lock-file --no-update-lock-file ${fixture.memberRoot}#z-package^out\n` +
          `path-info --recursive --offline --no-write-lock-file --no-update-lock-file ${fixture.memberRoot}#z-package^out\n`,
      )
      expect(result.projectionDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect((await lstat(result.candidateRoot)).mode & 0o777).toBe(0o700)
      await result.release()
      expect(await readdir(fixture.scratchRoot)).toEqual([])
    } finally {
      await clean(fixture)
    }
  })

  it('projects the exact Nix closure of every capability into manifest and defs bytes', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture)
      if (result._tag !== 'Resolved') throw new Error('unreachable')
      const resolved = resolvedCompositionCapabilityByToolId({
        resolution: result,
        toolId: 'buck2',
      })
      expect(resolved.closureStorePaths).toEqual([bashOutput])
      const manifestFile = NodePath.join(
        result.projectionPath,
        'generations',
        (/^GENERATION = "([0-9a-f]{64})"$/mu.exec(
          await readFile(NodePath.join(result.projectionPath, 'defs.bzl'), 'utf8'),
        ) ?? [])[1]!,
        'x86_64-linux',
        'buck2',
        'manifest.json',
      )
      expect(JSON.parse(await readFile(manifestFile, 'utf8')).closureStorePaths).toEqual([
        bashOutput,
      ])
      expect(await readFile(NodePath.join(result.projectionPath, 'defs.bzl'), 'utf8')).toContain(
        `"closureStorePaths": ["${bashOutput}"]`,
      )
      await result.release()
    } finally {
      await clean(fixture)
    }
  })

  it.each(['closure-empty', 'closure-nonstore', 'closure-foreign'] as const)(
    'refuses the %s closure query result without projecting anything',
    async (mode) => {
      const fixture = await makeFixture()
      try {
        await writeFile(fixture.nixModePath, `${mode}\n`)
        expect((await failure(resolve(fixture))).reason).toBe('InvalidNixOutput')
        expect(await readdir(fixture.scratchRoot)).toEqual([])
      } finally {
        await clean(fixture)
      }
    },
  )

  it('never resolves a capability scoped to other systems', async () => {
    const fixture = await makeFixture()
    try {
      const scoped = manifest({
        capabilities: [
          {
            toolId: 'buck2',
            protocol: 'facebook/buck2-cli/test',
            flakePackage: 'buck2',
            executable: 'bin/bash',
          },
          {
            toolId: 'sandbox-bubblewrap',
            protocol: 'containers/bubblewrap/test',
            flakePackage: 'buck2-bubblewrap',
            executable: 'bin/bwrap',
            systems: ['x86_64-linux', 'aarch64-linux'],
          },
        ],
      })
      const linux = await resolve(fixture, { dryRun: true, manifest: scoped })
      expect(linux.nixCommands.map(({ args }) => args.at(-1))).toEqual([
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#buck2-bubblewrap^out`,
        `${fixture.memberRoot}#buck2-bubblewrap^out`,
      ])
      const darwin = await resolve(fixture, {
        dryRun: true,
        manifest: scoped,
        system: 'aarch64-darwin',
      })
      expect(darwin.nixCommands.map(({ args }) => args.at(-1))).toEqual([
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#buck2^out`,
      ])
    } finally {
      await clean(fixture)
    }
  })

  it('never executes a malicious member projector script', async () => {
    const fixture = await makeFixture({
      projector: `#!${shell}\nprintf executed >${NodePath.join('/tmp', 'member-projector-must-not-run')}\nexit 91\n`,
    })
    const sentinel = NodePath.join('/tmp', 'member-projector-must-not-run')
    await rm(sentinel, { force: true })
    try {
      const result = await resolve(fixture)
      expect(result._tag).toBe('Resolved')
      await expect(readFile(sentinel, 'utf8')).rejects.toThrow()
      if (result._tag === 'Resolved') await result.release()
    } finally {
      await clean(fixture)
      await rm(sentinel, { force: true })
    }
  })

  it.each(['missing', 'symlink'] as const)(
    'refuses a %s flake.lock during dry-run without invoking Nix',
    async (kind) => {
      const fixture = await makeFixture()
      try {
        const lockPath = NodePath.join(fixture.memberRoot, 'flake.lock')
        await rm(lockPath)
        if (kind === 'symlink') {
          const outside = NodePath.join(fixture.root, 'outside.lock')
          await writeFile(outside, 'outside\n')
          await symlink(outside, lockPath)
        }
        expect((await failure(resolve(fixture, { dryRun: true }))).reason).toBe('InvalidLock')
        await expect(readFile(fixture.nixLog, 'utf8')).rejects.toThrow()
        expect(await readdir(fixture.scratchRoot)).toEqual([])
      } finally {
        await clean(fixture)
      }
    },
  )

  it('passes --no-write-lock-file and fails closed without mutating a member lock', async () => {
    const fixture = await makeFixture()
    try {
      const lockPath = NodePath.join(fixture.memberRoot, 'flake.lock')
      await writeFile(NodePath.join(fixture.memberRoot, 'flake.nix'), '{ outputs = _: {}; }\n')
      await writeFile(lockPath, 'original-lock-bytes\n')
      await writeFile(fixture.nixModePath, 'lock-write-attempt\n')
      const error = await failure(resolve(fixture))
      expect(error.reason).toBe('CommandFailure')
      expect(await readFile(lockPath, 'utf8')).toBe('original-lock-bytes\n')
      expect(await readFile(fixture.nixLog, 'utf8')).toContain(
        '--print-out-paths --no-write-lock-file --no-update-lock-file',
      )
    } finally {
      await clean(fixture)
    }
  })

  it.each([
    ['missing', 'missing'],
    ['duplicate', 'duplicate'],
    ['non-store', 'nonstore'],
  ] as const)('rejects %s Nix output and removes only its candidate', async (_label, mode) => {
    const fixture = await makeFixture()
    try {
      await writeFile(NodePath.join(fixture.scratchRoot, 'caller-sentinel'), 'owned by caller')
      await writeFile(fixture.nixModePath, `${mode}\n`)
      const error = await failure(resolve(fixture))
      expect(error.reason).toBe('InvalidNixOutput')
      expect(await readdir(fixture.scratchRoot)).toEqual(['caller-sentinel'])
    } finally {
      await clean(fixture)
    }
  })

  it('refuses a candidate replaced by a symlink and never follows or removes the replacement', async () => {
    const fixture = await makeFixture()
    const outside = NodePath.join(fixture.root, 'outside')
    try {
      await mkdir(outside)
      await writeFile(NodePath.join(outside, 'caller-owned'), 'keep')
      const error = await failure(
        resolve(fixture, {
          runtime: {
            ...fixture.runtime,
            afterCandidateCreated: async (candidateRoot) => {
              await rm(candidateRoot, { recursive: true })
              await symlink(outside, candidateRoot, 'dir')
            },
          },
        }),
      )
      expect(error.reason).toBe('CandidateReplaced')
      expect(await readdir(fixture.scratchRoot)).toEqual([])
      expect(await readFile(NodePath.join(outside, 'caller-owned'), 'utf8')).toBe('keep')
    } finally {
      await clean(fixture)
    }
  })

  it('rejects a store-output executable whose realpath escapes that output', async () => {
    const fixture = await makeFixture()
    try {
      await writeFile(fixture.nixOutputPath, `${escapingStoreExecutable.output}\n`)
      const error = await failure(
        resolve(fixture, {
          manifest: manifest({
            capabilities: [
              {
                toolId: 'buck2',
                protocol: 'facebook/buck2-cli/test',
                flakePackage: 'buck2',
                executable: escapingStoreExecutable.executable,
              },
            ],
          }),
        }),
      )
      expect(error.reason).toBe('InvalidExecutable')
      expect(await readdir(fixture.scratchRoot)).toEqual([])
    } finally {
      await clean(fixture)
    }
  })

  it('rejects a missing or non-executable declared output file', async () => {
    const fixture = await makeFixture()
    try {
      const error = await failure(
        resolve(fixture, {
          manifest: manifest({
            capabilities: [
              {
                toolId: 'buck2',
                protocol: 'test/v1',
                flakePackage: 'buck2',
                executable: 'bin/definitely-not-executable',
              },
            ],
          }),
        }),
      )
      expect(error.reason).toBe('InvalidExecutable')
    } finally {
      await clean(fixture)
    }
  })

  it('does not require a member projector file', async () => {
    const fixture = await makeFixture()
    try {
      await rm(NodePath.join(fixture.memberRoot, 'scripts', MEMBER_PROJECTOR_NAME))
      const result = await resolve(fixture)
      expect(result._tag).toBe('Resolved')
      if (result._tag === 'Resolved') await result.release()
    } finally {
      await clean(fixture)
    }
  })

  it('plans validated exact argv without invoking Nix or projector', async () => {
    const fixture = await makeFixture({ projector: `#!${shell}\nexit 99\n` })
    try {
      const result = await resolve(fixture, { dryRun: true })
      expect(result).toMatchObject({
        _tag: 'Planned',
        projectorPlatform: 'x86_64-linux',
      })
      expect(result.nixCommands[0]?.args).toEqual([
        'build',
        '--no-link',
        '--print-out-paths',
        '--no-write-lock-file',
        '--no-update-lock-file',
        `${fixture.memberRoot}#buck2^out`,
      ])
      expect(result.nixCommands[1]?.args).toEqual([
        'path-info',
        '--recursive',
        '--offline',
        '--no-write-lock-file',
        '--no-update-lock-file',
        `${fixture.memberRoot}#buck2^out`,
      ])
      expect(await readdir(fixture.scratchRoot)).toEqual([])
      await expect(readFile(fixture.nixLog, 'utf8')).rejects.toThrow()
    } finally {
      await clean(fixture)
    }
  })

  it('creates and releases a default private scratch parent under the OS temp root', async () => {
    const fixture = await makeFixture()
    try {
      const runtime = { ...fixture.runtime }
      Reflect.deleteProperty(runtime, 'createPrivateScratch')
      const result = await resolve(fixture, { runtime })
      if (result._tag !== 'Resolved') throw new Error('unreachable')
      expect(result.candidateRoot.startsWith(`${realpathSync(tmpdir())}${NodePath.sep}`)).toBe(true)
      expect((await lstat(NodePath.dirname(result.candidateRoot))).mode & 0o777).toBe(0o700)
      await result.release()
      await expect(lstat(result.candidateRoot)).rejects.toThrow()
    } finally {
      await clean(fixture)
    }
  })

  it.each(['projection', 'candidate'] as const)(
    'refuses a %s symlink swap immediately before digest without touching outside data',
    async (target) => {
      const fixture = await makeFixture()
      const outside = NodePath.join(fixture.root, `outside-${target}`)
      try {
        await mkdir(outside)
        await writeFile(NodePath.join(outside, 'caller-owned'), 'keep')
        const error = await failure(
          resolve(fixture, {
            runtime: {
              ...fixture.runtime,
              beforeProjectionDigest: async ({ candidateRoot, projectionPath }) => {
                const path = target === 'candidate' ? candidateRoot : projectionPath
                await rm(path, { recursive: true })
                await symlink(outside, path, 'dir')
              },
            },
          }),
        )
        expect(['CandidateReplaced', 'ProjectionFailure']).toContain(error.reason)
        expect(await readFile(NodePath.join(outside, 'caller-owned'), 'utf8')).toBe('keep')
        expect(await readdir(fixture.scratchRoot)).toEqual([])
      } finally {
        await clean(fixture)
      }
    },
  )

  it('maps an aarch64-darwin Nix plan to the projector aarch64-macos platform', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture, { dryRun: true, system: 'aarch64-darwin' })
      expect(result.projectorPlatform).toBe('aarch64-macos')
    } finally {
      await clean(fixture)
    }
  })

  it('never treats a toolchain kind itself as a Nix pin', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture, {
        dryRun: true,
        manifest: manifest({
          capabilities: [
            {
              _tag: 'ToolchainAuthority',
              toolchain: 'pnpm',
              provides: [],
            },
            {
              _tag: 'ToolchainRequirement',
              toolchain: 'tsgo',
            },
            {
              toolId: 'buck2',
              protocol: 'facebook/buck2-cli/test',
              flakePackage: 'buck2',
              executable: 'bin/bash',
            },
          ],
        }),
      })
      expect(result.nixCommands).toHaveLength(2)
      expect(result.nixCommands.map(({ args }) => args.at(-1))).toEqual([
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#buck2^out`,
      ])
    } finally {
      await clean(fixture)
    }
  })

  it('pins every executable a hub toolchain authority provides', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture, {
        dryRun: true,
        manifest: manifest({
          capabilities: [
            {
              _tag: 'ToolchainAuthority',
              toolchain: 'tsgo',
              provides: [
                {
                  toolId: 'effect-tsgo',
                  protocol: 'effect-utils/buck2-effect-tsgo/v1',
                  flakePackage: 'effect-tsgo',
                  executable: 'bin/bash',
                },
              ],
            },
            {
              toolId: 'buck2',
              protocol: 'facebook/buck2-cli/test',
              flakePackage: 'buck2',
              executable: 'bin/bash',
            },
          ],
        }),
      })
      expect(result.nixCommands.map(({ args }) => args.at(-1))).toEqual([
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#buck2^out`,
        `${fixture.memberRoot}#effect-tsgo^out`,
        `${fixture.memberRoot}#effect-tsgo^out`,
      ])
    } finally {
      await clean(fixture)
    }
  })

  it('changes projection identity with the realized output/executable and supports Buck lookup by toolId', async () => {
    const first = await makeFixture()
    const second = await makeFixture()
    try {
      const firstResult = await resolve(first)
      await writeFile(second.nixOutputPath, `${alternateOutput}\n`)
      const secondResult = await resolve(second, {
        manifest: manifest({
          capabilities: [
            {
              toolId: 'buck2',
              protocol: 'facebook/buck2-cli/test',
              flakePackage: 'buck2',
              executable: `bin/${NodePath.basename(alternateExecutable)}`,
            },
          ],
        }),
      })
      if (firstResult._tag !== 'Resolved' || secondResult._tag !== 'Resolved') {
        throw new Error('unreachable')
      }
      expect(secondResult.projectionDigest).not.toBe(firstResult.projectionDigest)
      expect(
        resolvedCompositionCapabilityByToolId({ resolution: firstResult, toolId: 'buck2' })
          .executablePath,
      ).toBe(bashExecutable)
      expect(() =>
        resolvedCompositionCapabilityByToolId({ resolution: firstResult, toolId: 'missing' }),
      ).toThrow(/absent/u)
      await Promise.all([firstResult.release(), secondResult.release()])
    } finally {
      await Promise.all([clean(first), clean(second)])
    }
  })
})
