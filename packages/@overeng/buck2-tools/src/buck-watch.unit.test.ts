import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  affectedPackagePaths,
  buildTargetsFor,
  reconcileBuckViews,
  runBuckWatchLoop,
  type BuckWatchPlan,
  type WatchChangeSource,
  type WatchLoopStatus,
} from './buck-watch.ts'

const plan: BuckWatchPlan = {
  reloadPaths: ['genie/buck2'],
  reloadSuffixes: ['BUCK.genie.ts'],
  globalPaths: ['buck2', 'packages/shared/package-tree.ts', 'pnpm-lock.yaml'],
  packages: [
    {
      packagePath: 'packages/core',
      sourceRoots: ['src'],
      workspaceDependencies: [],
      targets: {
        dist: '//packages/core:dist',
        packageTree: '//packages/core:package_tree',
        typecheck: '//packages/core:typecheck',
      },
    },
    {
      packagePath: 'packages/app',
      sourceFiles: ['vite.config.ts'],
      sourceRoots: ['src', 'tests'],
      workspaceDependencies: ['packages/core'],
      targets: {
        packageTree: '//packages/app:package_tree',
        typecheck: '//packages/app:typecheck',
      },
      editor: {
        cell: 'effect_utils',
        consumerCache: '.devenv/vite-cache/app',
        inputsManifestTarget: '//packages/app:editor_view_inputs',
        target: '//packages/app:editor_inputs',
        viewName: 'app',
      },
    },
  ],
}

class ControlledChanges implements WatchChangeSource {
  readonly #batches: string[][] = []
  readonly #waiters: Array<(result: IteratorResult<readonly string[]>) => void> = []
  #closed = false

  emit(paths: readonly string[]): void {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#batches.push([...paths])
    else waiter({ done: false, value: paths })
  }

  close(): Promise<void> {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
    return Promise.resolve()
  }

  [Symbol.asyncIterator](): AsyncIterator<readonly string[]> {
    return {
      next: () => {
        const batch = this.#batches.shift()
        if (batch !== undefined) return Promise.resolve({ done: false, value: batch })
        if (this.#closed === true) return Promise.resolve({ done: true, value: undefined })
        const pending = Promise.withResolvers<IteratorResult<readonly string[]>>()
        this.#waiters.push(pending.resolve)
        return pending.promise
      },
    }
  }
}

const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate() === true) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

describe('Buck watch reconciliation', () => {
  it('calculates the reverse affected set and the smallest unique target set', () => {
    expect(affectedPackagePaths({ plan, changedPaths: ['packages/core/src/value.ts'] })).toEqual([
      'packages/app',
      'packages/core',
    ])
    expect(
      buildTargetsFor({
        plan,
        packagePaths: ['packages/app'],
      }),
    ).toEqual(['//packages/app:editor_view_inputs', '//packages/app:typecheck'])
    expect(affectedPackagePaths({ plan, changedPaths: ['packages/app/vite.config.ts'] })).toEqual([
      'packages/app',
    ])
    expect(affectedPackagePaths({ plan, changedPaths: ['docs/guide.txt'] })).toEqual([])
    expect(affectedPackagePaths({ plan, changedPaths: ['pnpm-lock.yaml'] })).toEqual([
      'packages/app',
      'packages/core',
    ])
    expect(
      affectedPackagePaths({ plan, changedPaths: ['packages/shared/package-tree.ts'] }),
    ).toEqual(['packages/app', 'packages/core'])
  })

  it('subscribes before startup reconciliation and reconciles every package', async () => {
    const source = new ControlledChanges()
    const calls: string[][] = []
    let opened = false
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => {
        opened = true
        return source
      },
      reconcile: async ({ packagePaths }) => {
        expect(opened).toBe(true)
        calls.push([...packagePaths])
        abort.abort()
      },
      writeStatus: async () => {},
    })
    await running
    expect(calls).toEqual([['packages/app', 'packages/core']])
  })

  it('publishes failed status when subscription startup fails', async () => {
    const statuses: WatchLoopStatus[] = []
    await expect(
      runBuckWatchLoop({
        plan,
        signal: new AbortController().signal,
        openChanges: async () => {
          throw new Error('watch-project failed')
        },
        reconcile: async () => {},
        writeStatus: async (status) => {
          statuses.push(status)
        },
      }),
    ).rejects.toThrow('watch-project failed')
    expect(statuses.at(-1)).toMatchObject({
      error: 'watch-project failed',
      phase: 'failed',
    })
  })

  it('fails with a restart requirement instead of reconciling stale topology', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    const calls: string[][] = []
    const running = runBuckWatchLoop({
      plan,
      signal: new AbortController().signal,
      openChanges: async () => source,
      reconcile: async ({ packagePaths }) => {
        calls.push([...packagePaths])
      },
      writeStatus: async (status) => {
        statuses.push(status)
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    source.emit(['packages/app/BUCK.genie.ts'])
    await expect(running).rejects.toThrow('regenerate and restart')
    expect(calls).toEqual([['packages/app', 'packages/core']])
    expect(statuses.at(-1)).toMatchObject({
      affectedPackages: [],
      phase: 'failed',
    })
  })

  it('coalesces changes received during a reconciliation cycle', async () => {
    const source = new ControlledChanges()
    const calls: string[][] = []
    const startup = Promise.withResolvers<void>()
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async ({ packagePaths }) => {
        calls.push([...packagePaths])
        if (calls.length === 1) await startup.promise
        else abort.abort()
      },
      writeStatus: async () => {},
    })
    await until(() => calls.length === 1)
    source.emit(['packages/core/src/one.ts'])
    source.emit(['packages/core/src/two.ts', 'packages/app/src/main.ts'])
    startup.resolve()
    await running
    expect(calls).toEqual([
      ['packages/app', 'packages/core'],
      ['packages/app', 'packages/core'],
    ])
  })

  it('preserves the last successful generation after failure and reports the failure', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    let calls = 0
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async () => {
        calls++
        if (calls === 2) throw new Error('buck build failed')
      },
      writeStatus: async (status) => {
        statuses.push(status)
        if (status.phase === 'failed') abort.abort()
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    source.emit(['packages/app/src/main.ts'])
    await running
    const failed = statuses.find((status) => status.phase === 'failed')
    expect(failed).toMatchObject({
      error: 'buck build failed',
      generation: 1,
      phase: 'failed',
    })
    expect(failed?.lastSuccessfulAt).toEqual(expect.any(String))
  })

  it('passes every provider read root to publication and never publishes after a failed build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck-watch-'))
    try {
      const manifest = join(root, 'editor-inputs.json')
      await writeFile(
        manifest,
        `${JSON.stringify({
          schema: 'effect-utils/editor-view-inputs/v1',
          editorInputs: 'buck-out/app/node_modules',
          packageTree: 'buck-out/app/package_tree',
          readRoots: ['buck-out/app/package_tree', 'buck-out/store/dep'],
        })}\n`,
      )
      const shutdown = new AbortController()
      const invocations: {
        command: string
        detached: boolean | undefined
        args: readonly string[]
        signal: AbortSignal | undefined
      }[] = []
      await reconcileBuckViews({
        request: {
          packagePaths: ['packages/app'],
          changedPaths: ['packages/app/src/main.ts'],
          buildTargets: ['//packages/app:editor_view_inputs', '//packages/app:typecheck'],
        },
        options: {
          plan,
          mode: 'publish',
          repoRoot: root,
          workspaceRoot: root,
          buck2: '/tools/buck2',
          editorViewProgram: '/tools/editor-view',
          workspaceAuthority: '/repo/authority.json',
          cp: '/tools/cp',
          mv: '/tools/mv',
          snapshotRetention: 3,
          signal: shutdown.signal,
          run: async ({ command, args, detached, signal }) => {
            invocations.push({ command, args, detached, signal })
            return command === '/tools/buck2'
              ? {
                  stdout: `//packages/app:editor_view_inputs ${manifest}\n`,
                  stderr: '',
                }
              : { stdout: '', stderr: '' }
          },
        },
      })
      expect(invocations).toHaveLength(2)
      expect(invocations[0]?.signal).toBe(shutdown.signal)
      expect(invocations[0]?.detached).toBeUndefined()
      expect(invocations[1]?.detached).toBe(true)
      expect(invocations[1]?.signal).toBeUndefined()
      expect(invocations[1]?.command).toBe('/tools/editor-view')
      expect(invocations[1]?.args).toContain('--backing-root')
      expect(invocations[1]?.args).toEqual(
        expect.arrayContaining([
          join(root, 'buck-out/app/node_modules'),
          join(root, 'buck-out/app/package_tree'),
          join(root, 'buck-out/store/dep'),
        ]),
      )

      const failedInvocations: string[] = []
      await expect(
        reconcileBuckViews({
          request: {
            packagePaths: ['packages/app'],
            changedPaths: ['packages/app/src/main.ts'],
            buildTargets: ['//packages/app:editor_view_inputs'],
          },
          options: {
            plan,
            mode: 'publish',
            repoRoot: root,
            workspaceRoot: root,
            buck2: '/tools/buck2',
            editorViewProgram: '/tools/editor-view',
            workspaceAuthority: '/repo/authority.json',
            cp: '/tools/cp',
            mv: '/tools/mv',
            snapshotRetention: 3,
            run: async ({ command }) => {
              failedInvocations.push(command)
              throw new Error('stale build')
            },
          },
        }),
      ).rejects.toThrow('stale build')
      expect(failedInvocations).toEqual(['/tools/buck2'])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('closes the subscription and publishes stopped status on shutdown', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async () => {},
      writeStatus: async (status) => {
        statuses.push(status)
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    abort.abort()
    await running
    expect(statuses.at(-1)?.phase).toBe('stopped')
    await expect(source[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})
