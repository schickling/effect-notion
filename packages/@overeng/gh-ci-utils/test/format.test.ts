import { describe, expect, it } from 'vitest'

import {
  abbreviateRunner,
  formatDuration,
  parseRunnerIdentity,
} from '../src/isomorphic/lib/format.ts'
import { lookupRunnerHost, makeRunnerHostMap } from '../src/isomorphic/renderers/CiOutput/schema.ts'
import { runTerminalConclusionText } from '../src/isomorphic/renderers/CiOutput/view.tsx'

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(45)).toBe('45s'))
  it('formats minutes', () => expect(formatDuration(125)).toBe('2m 05s'))
  it('formats hours', () => expect(formatDuration(7877)).toBe('2h 11m'))
  it('handles zero', () => expect(formatDuration(0)).toBe('0s'))
  it('handles exactly 1 hour', () => expect(formatDuration(3600)).toBe('1h 00m'))
})

describe('abbreviateRunner', () => {
  it('abbreviates nsc runners', () =>
    expect(abbreviateRunner('nsc-runner-abc123example')).toBe('nsc:abc123'))
  it('abbreviates self-hosted runner-scaler names', () => {
    expect(abbreviateRunner('linuxbuildera-1234abcd')).toBe('linuxbuildera')
    expect(abbreviateRunner('linux-builder-a-1234abcd')).toBe('linux-builder-a')
    expect(abbreviateRunner('macosbuildera-5678abcd')).toBe('macosbuildera')
  })
  it('passes through non-matching names', () =>
    expect(abbreviateRunner('some-other-runner')).toBe('some-other-runner'))
  it('handles null', () => expect(abbreviateRunner(null)).toBe('—'))
})

describe('runner host identity', () => {
  it('resolves hosts after Namespace and runner-scaler job names are abbreviated', () => {
    const namespaceRunner = 'nsc-runner-abc123example'
    const scaledRunner = 'linux-builder-a-1234abcd'
    const entries = makeRunnerHostMap([
      { runner: namespaceRunner, host: 'namespace-host' },
      { runner: scaledRunner, host: 'linux-builder-a' },
    ])

    expect(entries).toEqual([
      ['nsc:abc123', 'namespace-host'],
      ['linux-builder-a', 'linux-builder-a'],
    ])
    expect(lookupRunnerHost({ entries, runnerName: abbreviateRunner(namespaceRunner) })).toBe(
      'namespace-host',
    )
    expect(lookupRunnerHost({ entries, runnerName: abbreviateRunner(scaledRunner) })).toBe(
      'linux-builder-a',
    )
  })
})

describe('run-level terminal conclusion banner', () => {
  it.each([
    ['startup_failure', 'failing', 'STARTUP FAILURE — workflow run failed before jobs started'],
    ['action_required', 'failing', 'ACTION REQUIRED — workflow run requires manual action'],
    ['timed_out', 'failing', 'TIMED OUT — workflow run exceeded its time limit'],
    ['cancelled', 'cancelled', 'CANCELLED — workflow run was cancelled'],
  ] as const)(
    'renders %s when successful jobs cannot explain the run verdict',
    (conclusion, status, text) => {
      expect(runTerminalConclusionText({ conclusion, overallStatus: status })).toBe(text)
    },
  )
})

describe('parseRunnerIdentity', () => {
  it('keeps the full Namespace runner id, not just the abbreviated prefix', () =>
     expect(parseRunnerIdentity({ name: 'nsc-runner-example123' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnera-1234abcd' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnerb-9876fedc' })).toEqual({
      _tag: 'namespace',
      instance: 'example123',
    }))

  it('resolves self-hosted runner-scaler workers to their host', () => {
     expect(parseRunnerIdentity({ name: 'nsc-runner-example123' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnera-1234abcd' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnerb-9876fedc' })).toEqual({
      _tag: 'self-hosted',
      instance: 'runnera',
    })
     expect(parseRunnerIdentity({ name: 'nsc-runner-example123' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnera-1234abcd' })).toEqual({
     expect(parseRunnerIdentity({ name: 'runnerb-9876fedc' })).toEqual({
      _tag: 'self-hosted',
      instance: 'runnerb',
    })
  })

  it('reports unrecognized names verbatim rather than guessing a scheme', () => {
    expect(parseRunnerIdentity({ name: 'some-other-runner' })).toEqual({
      _tag: 'other',
      instance: 'some-other-runner',
    })
    expect(parseRunnerIdentity({ name: 'ubuntu-latest' })).toEqual({
      _tag: 'other',
      instance: 'ubuntu-latest',
    })
  })

  it('distinguishes "no runner assigned" from an unrecognized runner', () =>
    expect(parseRunnerIdentity({ name: null })).toEqual({ _tag: 'unknown', instance: null }))
})
