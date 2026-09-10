import { describe, expect, it } from 'vitest'

import { parseTarget } from '../src/node/RunId.ts'

describe('parseTarget', () => {
  it('parses numeric run IDs', () => {
    expect(parseTarget('12345678')).toEqual({ _tag: 'Numeric', runId: 12345678 })
  })

  it('parses large numeric IDs', () => {
    expect(parseTarget('23597026954')).toEqual({ _tag: 'Numeric', runId: 23597026954 })
  })

  it('parses GitHub run URLs', () => {
    expect(parseTarget('https://github.com/schickling/dotfiles/actions/runs/12345678')).toEqual({
      _tag: 'Url',
      owner: 'schickling',
      repo: 'dotfiles',
      runId: 12345678,
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
    expect(parseTarget('https://github.com/schickling/dotfiles/pull/506')).toEqual({
      _tag: 'PrUrl',
      owner: 'schickling',
      repo: 'dotfiles',
      prNumber: 506,
    })
  })

  it('parses local PR with # prefix', () => {
    expect(parseTarget('#506')).toEqual({ _tag: 'LocalPr', prNumber: 506 })
  })

  it('parses cross-repo PR (owner/repo#N)', () => {
    expect(parseTarget('overengineeringstudio/effect-utils#482')).toEqual({
      _tag: 'RepoPr',
      owner: 'overengineeringstudio',
      repo: 'effect-utils',
      prNumber: 482,
    })
  })

  it('parses cross-repo branch (owner/repo@branch)', () => {
    expect(parseTarget('overengineeringstudio/effect-utils@main')).toEqual({
      _tag: 'RepoBranch',
      owner: 'overengineeringstudio',
      repo: 'effect-utils',
      branch: 'main',
    })
  })

  it('parses cross-repo branch with slashes in branch name', () => {
    expect(parseTarget('schickling/dotfiles@feat/new-thing')).toEqual({
      _tag: 'RepoBranch',
      owner: 'schickling',
      repo: 'dotfiles',
      branch: 'feat/new-thing',
    })
  })

  it('parses cross-repo default (owner/repo)', () => {
    expect(parseTarget('overengineeringstudio/effect-utils')).toEqual({
      _tag: 'RepoDefault',
      owner: 'overengineeringstudio',
      repo: 'effect-utils',
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
    expect(parseTarget('schickling/2026-03-22-better-ci-runner')).toEqual({
      _tag: 'RepoDefault',
      owner: 'schickling',
      repo: '2026-03-22-better-ci-runner',
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
