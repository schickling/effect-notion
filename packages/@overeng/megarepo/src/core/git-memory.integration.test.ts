/**
 * Memory-bound regression for the worktree dirt path (decision 0007, bounded
 * memory). `git status --porcelain --untracked-files=all` on a worktree with a
 * large untracked tree previously buffered the whole output through an O(n²)
 * per-chunk concat, which OOM-killed the host. {@link Git.getWorktreeStatus} now
 * folds the output line-by-line at constant memory.
 *
 * The probe runs in a FRESH subprocess (`memory-probe.ts`) because `VmHWM` is a
 * process-lifetime peak: measured inside the vitest worker it would be polluted
 * by earlier tests and fail to discriminate. We assert on the per-process growth
 * `VmHWM - rssStart`, which is independent of the runtime baseline.
 *
 * On the old O(n²) code this growth was ~225 MB for an 80k-file tree; the
 * streaming path keeps it to ~40 MB. The 100 MB bound below FAILS on the old
 * implementation and passes on the new one. Linux-only (reads
 * `/proc/self/status`).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { requireTool } from '../test-utils/require-tool.ts'

const gitBin = requireTool('GIT_BIN')
const bashBin = requireTool('BASH_BIN')
const bunBin = requireTool('BUN_BIN')

/** Files in the untracked tree. Large enough that the old O(n²) concat balloons
 *  RSS, small enough that fixture creation stays fast (~10s). */
const UNTRACKED_FILE_COUNT = 80_000
const SUBDIR_COUNT = 80
/** Per-process RSS growth ceiling (KiB). Streaming ≈ 40 MB; O(n²) ≈ 225 MB. */
const MAX_GROWTH_KB = 100 * 1024

const ProbeOutput = Schema.Struct({
  rssStartKb: Schema.Finite,
  vmHwmKb: Schema.Finite,
  changesCount: Schema.Finite,
})
const decodeProbe = Schema.decodeUnknownSync(Schema.fromJsonString(ProbeOutput))

const probeScript = fileURLToPath(new URL('../test-utils/memory-probe.ts', import.meta.url))

/** Build a git worktree with a large untracked tree (synchronous fs is far
 *  faster here than per-file Effect FS calls). */
const buildUntrackedWorktree = (): string => {
  const dir = mkdtempSync(join('/tmp', 'gc-mem-regression-'))
  execFileSync(gitBin, ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync(gitBin, ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync(gitBin, ['config', 'user.name', 'Test User'], { cwd: dir })
  for (let s = 0; s < SUBDIR_COUNT; s++) {
    mkdirSync(join(dir, `untracked_directory_level_one_${s}`), { recursive: true })
  }
  for (let i = 0; i < UNTRACKED_FILE_COUNT; i++) {
    writeFileSync(
      join(
        dir,
        `untracked_directory_level_one_${i % SUBDIR_COUNT}`,
        `generated_untracked_file_with_a_reasonably_long_name_${i}.txt`,
      ),
      'x',
    )
  }
  return dir
}

const isLinux = platform() === 'linux'

describe('git memory regression', () => {
  // `/proc/self/status` (VmHWM) is Linux-only.
  it.effect.skipIf(!isLinux)(
    'getWorktreeStatus stays under a constant RSS on a large untracked tree',
    () =>
      Effect.gen(function* () {
        const worktreePath = buildUntrackedWorktree()

        // Run the dirt path in a fresh subprocess and read its self-reported
        // peak RSS. The virtual-memory ceiling (16 GiB) is a host-OOM backstop
        // only — it must stay generous because bun/JSC reserves a large virtual
        // address space regardless of resident set; the assertion below (on
        // resident growth) is the real bound, not this limit.
        const stdout = yield* ChildProcessSpawner.use((spawner) =>
          spawner.string(
            Command.make(bashBin, [
              '-c',
              'ulimit -v 16777216; exec "$0" "$1" "$2"',
              bunBin,
              probeScript,
              worktreePath,
            ]),
          ),
        )
        const result = decodeProbe(stdout.trim())

        const growthKb = result.vmHwmKb - result.rssStartKb
        expect(result.changesCount).toBe(UNTRACKED_FILE_COUNT)
        expect(growthKb).toBeLessThan(MAX_GROWTH_KB)
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  )
})
