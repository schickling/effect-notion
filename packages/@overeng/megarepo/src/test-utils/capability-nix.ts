import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/**
 * New-CLI store commands are gated behind an experimental feature, and these calls run with a
 * scrubbed environment that reaches no user or sandbox `nix.conf`. Naming the feature in argv
 * keeps them working inside the Buck sandbox exactly as they do in a devenv shell.
 */
const nixCommandFeature = ['--extra-experimental-features', 'nix-command'] as const

/** Store access needs the daemon socket and store layout, nothing else from the ambient env. */
const nixStoreEnvironment = (scratch: string): NodeJS.ProcessEnv => ({
  HOME: scratch,
  TMPDIR: scratch,
  ...(process.env['NIX_REMOTE'] === undefined ? {} : { NIX_REMOTE: process.env['NIX_REMOTE'] }),
  ...(process.env['NIX_STATE_DIR'] === undefined
    ? {}
    : { NIX_STATE_DIR: process.env['NIX_STATE_DIR'] }),
  ...(process.env['NIX_STORE_DIR'] === undefined
    ? {}
    : { NIX_STORE_DIR: process.env['NIX_STORE_DIR'] }),
})

/**
 * Resolve the exact Nix binary a capability test may spawn.
 *
 * Sources are explicit environment injections only: Buck's declared `NIX_BIN` tool, or the
 * composition wrapper's `MR_CAPABILITY_NIX_BIN`. Nothing resolves through PATH, and the
 * candidate must run with the same PATH-free environment GC-root registration uses.
 */
export const resolveDeclaredNix = async ({
  env = process.env,
}: {
  readonly env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<string> => {
  const scratch = await mkdtemp(NodePath.join(NodePath.resolve(tmpdir()), 'megarepo-nix-probe-'))
  const sources = ['NIX_BIN', 'MR_CAPABILITY_NIX_BIN'] as const
  type Probe =
    | { readonly _tag: 'accepted'; readonly candidate: string }
    | { readonly _tag: 'rejected'; readonly detail: string }
  const probeSource = async (source: (typeof sources)[number]): Promise<Probe> => {
    const candidate = env[source]
    if (candidate === undefined || candidate === '')
      return { _tag: 'rejected', detail: `${source}: not declared` }
    try {
      await access(candidate, constants.X_OK)
      await execFile(candidate, [...nixCommandFeature, '--version'], {
        env: nixStoreEnvironment(scratch),
      })
      return { _tag: 'accepted', candidate }
    } catch (cause) {
      return {
        _tag: 'rejected',
        detail: `${source}=${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
  }
  // Probes run concurrently; the declared source order alone decides which candidate wins, so
  // resolution stays deterministic regardless of which probe finishes first.
  const probes = await Promise.all(sources.map((source) => probeSource(source)))
  const accepted = probes.find(
    (probe): probe is Extract<Probe, { readonly _tag: 'accepted' }> => probe._tag === 'accepted',
  )
  if (accepted !== undefined) return accepted.candidate
  const rejected = probes.flatMap((probe) => (probe._tag === 'rejected' ? [probe.detail] : []))
  throw new Error(
    `declared test tool is unavailable: no usable Nix binary.\n${rejected.join('\n')}`,
  )
}

/**
 * Add a fresh content-addressed realization to the local store and return its path. The content
 * is unique per marker, so the result is a real store path no existing root retains: exactly the
 * disposable capability a GC-liveness test needs.
 */
export const addDisposableCapabilityStorePath = async ({
  nixPath,
  name,
  marker,
}: {
  readonly nixPath: string
  readonly name: string
  readonly marker: string
}): Promise<string> => {
  const scratch = await mkdtemp(NodePath.join(NodePath.resolve(tmpdir()), 'megarepo-cap-source-'))
  const binary = NodePath.join(scratch, 'bin')
  await mkdir(binary)
  const executable = NodePath.join(binary, 'tool')
  // Never executed: capability GC roots only need a real, unique, executable-mode store entry.
  await writeFile(executable, `megarepo capability probe ${marker}\n`)
  await chmod(executable, 0o555)
  const { stdout } = await execFile(
    nixPath,
    ['store', 'add-path', ...nixCommandFeature, '--name', name, '--', scratch],
    { encoding: 'utf8', env: nixStoreEnvironment(scratch) },
  )
  const storePath = stdout.trim().split(/\r?\n/u).at(-1) ?? ''
  if (/^\/nix\/store\/[^/\s]+$/u.test(storePath) === false) {
    throw new TypeError(`nix store add-path did not return one store path: ${stdout}`)
  }
  return storePath
}

/**
 * Ask Nix to delete one store path. Nix refuses while the path is reachable from a GC root, so
 * this is a real, bounded liveness proof that touches no other store path.
 */
export const deleteStorePath = async ({
  nixPath,
  storePath,
}: {
  readonly nixPath: string
  readonly storePath: string
}): Promise<{ readonly deleted: boolean; readonly output: string }> => {
  const scratch = await mkdtemp(NodePath.join(NodePath.resolve(tmpdir()), 'megarepo-nix-delete-'))
  try {
    const { stdout, stderr } = await execFile(
      nixPath,
      ['store', 'delete', ...nixCommandFeature, '--', storePath],
      { encoding: 'utf8', env: nixStoreEnvironment(scratch) },
    )
    return { deleted: true, output: `${stdout}${stderr}` }
  } catch (cause) {
    const output =
      typeof cause === 'object' && cause !== null && 'stderr' in cause
        ? String(cause.stderr)
        : String(cause)
    return { deleted: false, output }
  }
}

/**
 * Write a capability projection with the exact on-disk shape the resolver produces for one tool,
 * pointing at a real store realization so GC-root registration has something to root.
 */
export const writeRootableCapabilityProjection = async ({
  root,
  generation,
  storePath,
  platform = 'x86_64-linux',
  toolId = 'probe',
  executable = 'bin/tool',
  extraClosureStorePaths = [],
}: {
  readonly root: string
  readonly generation: string
  readonly storePath: string
  readonly platform?: string
  readonly toolId?: string
  readonly executable?: string
  /** Declared closure entries outside the realization, used to test closure verification. */
  readonly extraClosureStorePaths?: ReadonlyArray<string>
}): Promise<{ readonly executableStorePath: string; readonly toolId: string }> => {
  const toolRoot = NodePath.join(root, 'generations', generation, platform, toolId)
  await mkdir(toolRoot, { recursive: true })
  const executableStorePath = NodePath.join(storePath, executable)
  await writeFile(
    NodePath.join(toolRoot, 'manifest.json'),
    `${JSON.stringify({
      closureIdentity: storePath,
      closureStorePaths: [storePath, ...extraClosureStorePaths].toSorted(),
      contentDigest: '0'.repeat(64),
      executableStorePath,
      executionPlatform: platform,
      protocol: 'megarepo/test-capability/v1',
      runtimeContract: 'native-executable/v1',
      schema: 'effect-utils/buck2-support-tools/v1',
      toolId,
    })}\n`,
  )
  await symlink(executableStorePath, NodePath.join(toolRoot, 'executable'))
  await writeFile(
    NodePath.join(toolRoot, 'BUCK'),
    'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])\n' +
      'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])\n',
  )
  await writeFile(NodePath.join(root, 'defs.bzl'), `GENERATION = "${generation}"\n`)
  return { executableStorePath, toolId }
}
