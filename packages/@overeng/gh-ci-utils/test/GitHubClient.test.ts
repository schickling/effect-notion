import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/node/Config.ts'
import { selectAppAuthSource } from '../src/node/GitHubClient.ts'

describe('selectAppAuthSource', () => {
  const auth = { installationIDs: { 'example-org': 123_456, 'another-org': 234_567 } }

  it('uses the configured installation for a known owner', () => {
    expect(selectAppAuthSource({ auth, repo: 'another-org/example-repo' })).toEqual({
      _tag: 'app-installation',
      owner: 'another-org',
      installationID: 234_567,
    })
  })

  it('falls back to the gh CLI token for an owner without an installation', () => {
    expect(selectAppAuthSource({ auth, repo: 'vercel/next.js' })).toEqual({
      _tag: 'cli-token-fallback',
      owner: 'vercel',
    })
  })

  it('rejects slugs that are not owner/repo', () => {
    expect(() => selectAppAuthSource({ auth, repo: 'vercel' })).toThrow(/owner\/repo/)
  })
})

describe('resolveConfig', () => {
  it('loads repositories and runner hosts from the user config', async () => {
    const config = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = path.join(directory, 'config.json')
      yield* fs.writeFileString(
        configPath,
        '{"auth":{"_tag":"gh-cli"},"repos":["example-org/example-repo"],"runnerHosts":["runner-host-a"]}',
      )
      return yield* resolveConfig({ configPath })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

    expect(config).toEqual({
      repos: ['example-org/example-repo'],
      runnerHosts: ['runner-host-a'],
    })
  })

  it('uses no organization-specific runner hosts when none are configured', async () => {
    const config = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      return yield* resolveConfig({
        configPath: path.join(directory, 'missing.json'),
        partial: { repos: ['example-org/example-repo'] },
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

    expect(config.runnerHosts).toEqual([])
  })
})
