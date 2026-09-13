import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { parseTarget, resolveWorkflowDispatchTarget } from '../src/node/RunId.ts'

describe('parseTarget', () => {
  it('parses numeric run IDs', () => {
    expect(parseTarget('70001234')).toEqual({ _tag: 'Numeric', runId: 70001234 })
  })

  it('parses large numeric IDs', () => {
    expect(parseTarget('70000000001')).toEqual({ _tag: 'Numeric', runId: 70000000001 })
  })

  it('parses GitHub run URLs', () => {
    expect(
      parseTarget('https://github.com/example-user/sample-repo/actions/runs/70001234'),
    ).toEqual({
      _tag: 'Url',
      owner: 'example-user',
      repo: 'sample-repo',
      runId: 70001234,
    })
  })

  it('parses GitHub run URLs with trailing path segments', () => {
    expect(parseTarget('https://github.com/owner/repo/actions/runs/999/jobs/123')).toEqual({
      _tag: 'Url',
      owner: 'owner',
      repo: 'repo',
      runId: 999,
    })
  })

  it('parses PR URLs', () => {
    expect(parseTarget('https://github.com/example-user/sample-repo/pull/314')).toEqual({
      _tag: 'PrUrl',
      owner: 'example-user',
      repo: 'sample-repo',
      prNumber: 314,
    })
  })

  it('parses local PR with # prefix', () => {
    expect(parseTarget('#314')).toEqual({ _tag: 'LocalPr', prNumber: 314 })
  })

  it('parses cross-repo PR (owner/repo#N)', () => {
    expect(parseTarget('example-org/example-repo#314')).toEqual({
      _tag: 'RepoPr',
      owner: 'example-org',
      repo: 'example-repo',
      prNumber: 314,
    })
  })

  it('parses cross-repo branch (owner/repo@branch)', () => {
    expect(parseTarget('example-org/example-repo@main')).toEqual({
      _tag: 'RepoBranch',
      owner: 'example-org',
      repo: 'example-repo',
      branch: 'main',
    })
  })

  it('parses cross-repo branch with slashes in branch name', () => {
    expect(parseTarget('example-user/sample-repo@feature/synthetic-change')).toEqual({
      _tag: 'RepoBranch',
      owner: 'example-user',
      repo: 'sample-repo',
      branch: 'feature/synthetic-change',
    })
  })

  it('parses cross-repo default (owner/repo)', () => {
    expect(parseTarget('example-org/example-repo')).toEqual({
      _tag: 'RepoDefault',
      owner: 'example-org',
      repo: 'example-repo',
    })
  })

  it('treats plain strings (no slash) as local branch names', () => {
    expect(parseTarget('main')).toEqual({ _tag: 'LocalBranch', branch: 'main' })
  })

  it('parses @-prefixed branch as LocalBranch', () => {
    expect(parseTarget('@feat/foo')).toEqual({ _tag: 'LocalBranch', branch: 'feat/foo' })
  })

  it('parses @main as LocalBranch', () => {
    expect(parseTarget('@main')).toEqual({ _tag: 'LocalBranch', branch: 'main' })
  })

  it('treats slash branch without @ as RepoDefault', () => {
    expect(parseTarget('example-user/sample-repository')).toEqual({
      _tag: 'RepoDefault',
      owner: 'example-user',
      repo: 'sample-repository',
    })
  })

  it('treats negative numbers as branch names', () => {
    expect(parseTarget('-1')).toEqual({ _tag: 'LocalBranch', branch: '-1' })
  })

  it('treats zero as branch name', () => {
    expect(parseTarget('0')).toEqual({ _tag: 'LocalBranch', branch: '0' })
  })

  it('treats floats as branch names', () => {
    expect(parseTarget('1.5')).toEqual({ _tag: 'LocalBranch', branch: '1.5' })
  })
})

describe('resolveWorkflowDispatchTarget', () => {
  it('resolves an explicit cross-repo branch without a local repository', () => {
    expect(
      Effect.runSync(
        resolveWorkflowDispatchTarget({
          input: 'example-org/example-repo@release/next',
          localRepo: Option.none(),
          getDefaultBranch: () => Effect.die('default branch must not be requested'),
        }),
      ),
    ).toEqual({
      repo: 'example-org/example-repo',
      branch: 'release/next',
    })
  })

  it("resolves an explicit repository's default branch without a local repository", () => {
    expect(
      Effect.runSync(
        resolveWorkflowDispatchTarget({
          input: 'example-org/example-repo',
          localRepo: Option.none(),
          getDefaultBranch: (repo) => {
            expect(repo).toBe('example-org/example-repo')
            return Effect.succeed('trunk')
          },
        }),
      ),
    ).toEqual({
      repo: 'example-org/example-repo',
      branch: 'trunk',
    })
  })

  it('requires a local repository for a local branch target', () => {
    const error = Effect.runSync(
      Effect.flip(
        resolveWorkflowDispatchTarget({
          input: '@release/next',
          localRepo: Option.none(),
          getDefaultBranch: () => Effect.die('default branch must not be requested'),
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: 'ConfigError',
      message: 'No local repo available. Use owner/repo as target to specify.',
    })
  })

  it.each([
    { input: '70001234', kind: 'an existing run' },
    {
      input: 'https://github.com/example-org/example-repo/actions/runs/70001234',
      kind: 'an existing run',
    },
    { input: '#506', kind: 'a pull request' },
    { input: 'example-org/example-repo#506', kind: 'a pull request' },
    {
      input: 'https://github.com/example-org/example-repo/pull/506',
      kind: 'a pull request',
    },
  ])('rejects unsupported dispatch target $input', ({ input, kind }) => {
    const error = Effect.runSync(
      Effect.flip(
        resolveWorkflowDispatchTarget({
          input,
          localRepo: Option.none(),
          getDefaultBranch: () => Effect.die('default branch must not be requested'),
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: 'ConfigError',
      message: expect.stringContaining(`target '${input}' identifies ${kind}`),
      cause: 'unsupported workflow dispatch target',
    })
  })
})
