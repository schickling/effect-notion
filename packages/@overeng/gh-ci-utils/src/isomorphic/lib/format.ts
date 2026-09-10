/** Pure formatting utilities for CI output. */

import type { RunnerKind } from './viewModels.ts'

/** Format a duration in seconds as a human-readable string */
export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const min = Math.floor(seconds / 60)
    const sec = seconds % 60
    return `${min}m ${sec.toString().padStart(2, '0')}s`
  }
  const hrs = Math.floor(seconds / 3600)
  const min = Math.floor((seconds % 3600) / 60)
  return `${hrs}h ${min.toString().padStart(2, '0')}m`
}

/** Compute duration in seconds from start/end dates. Uses current time if end is null (in-progress). */
export const computeDurationSeconds = ({
  startedAt,
  completedAt,
}: {
  startedAt: Date | null
  completedAt: Date | null
}): number => {
  if (!startedAt) return 0
  const end = completedAt ?? new Date()
  return Math.round((end.getTime() - startedAt.getTime()) / 1000)
}

/** Parse owner/repo string into its components. */
export const splitOwnerRepo = (repo: string): { owner: string; repo: string } => {
  const idx = repo.indexOf('/')
  return { owner: repo.slice(0, idx), repo: repo.slice(idx + 1) }
}

type Identity<K extends RunnerKind, I> = { readonly _tag: K; readonly instance: I }
/**
 * Structured identity parsed out of a GitHub Actions runner name.
 *
 * `instance` keeps the stable part of the raw name: the Namespace runner id, the
 * host prefix of a runner-scaler worker, or the whole name when nothing is known
 * about its shape. `unknown` covers jobs GitHub never assigned a runner to.
 */
export type RunnerIdentity =
  | Identity<'namespace', string>
  | Identity<'self-hosted', string>
  | Identity<'other', string>
  | Identity<'unknown', null>

/** Namespace cloud runners: `nsc-runner-<id>` (abbreviated to the first 6 id chars). */
const NAMESPACE_RUNNER = /^nsc-runner-(.{6,})$/
/** runner-scaler workers: `<host>-<8 hex>`. */
const SELF_HOSTED_RUNNER = /^(.+)-[a-f0-9]{8}$/

/** Parse a raw runner name into its provider kind and stable instance identity. */
export const parseRunnerIdentity = (name: string | null): RunnerIdentity => {
  if (!name) return { _tag: 'unknown', instance: null }
  const namespace = NAMESPACE_RUNNER.exec(name)
  if (namespace) return { _tag: 'namespace', instance: namespace[1]! }
  const selfHosted = SELF_HOSTED_RUNNER.exec(name)
  if (selfHosted) return { _tag: 'self-hosted', instance: selfHosted[1]! }
  return { _tag: 'other', instance: name }
}

/** Abbreviate a runner hostname for compact display. */
export const abbreviateRunner = (name: string | null): string => {
  if (!name) return '—'
  const nscMatch = /^nsc-runner-(.{6})/.exec(name)
  if (nscMatch) return `nsc:${nscMatch[1]}`
  const selfHostedMatch = /^(.+)-[a-f0-9]{8}$/.exec(name)
  if (selfHostedMatch) return selfHostedMatch[1]!
  return name
}

/** Compact display string for a parsed runner identity. */
export const formatRunnerIdentity = (identity: RunnerIdentity): string => {
  switch (identity._tag) {
    case 'unknown':
      return '—'
    case 'namespace':
      return `nsc:${identity.instance.slice(0, 6)}`
    case 'self-hosted':
    case 'other':
      return identity.instance
  }
}

/** Abbreviate a runner hostname for compact display */
export const abbreviateRunner = (name: string | null): string =>
  formatRunnerIdentity(parseRunnerIdentity(name))
