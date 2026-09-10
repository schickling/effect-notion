/** Pure formatting utilities for CI output. */

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

/** Abbreviate a runner hostname for compact display */
export const abbreviateRunner = (name: string | null): string => {
  if (!name) return '—'
  const nscMatch = /^nsc-runner-(.{6})/.exec(name)
  if (nscMatch) return `nsc:${nscMatch[1]}`
  const selfHostedMatch = /^(\w+)-[a-f0-9]{8}$/.exec(name)
  if (selfHostedMatch) return selfHostedMatch[1]!
  return name
}
