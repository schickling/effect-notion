/**
 * Pure classifier for `gh-ci-utils inspect`.
 *
 * The rule this file exists to enforce: a disposition may only be claimed from
 * an observation that was actually made. Everything unobserved collapses to
 * `unknown` with the reason recorded in `limitations`, so a missing `nsc`, a
 * non-Namespace runner and a runner we genuinely cannot read are all reported
 * as what they are instead of being rounded into a verdict.
 *
 * Precedence, highest first:
 *   1. `resource-pressure` — a usage sample at or above the pressure threshold.
 *   2. `active`            — GitHub and Namespace agree the job is running.
 *   3. `idle`              — a live instance with no running GitHub job.
 *   4. `unknown`           — anything missing, conflicting, or unobservable.
 */
import {
  type InspectAssessment,
  type InspectGitHubFacts,
  type InspectNamespaceFacts,
  type NamespaceUsageState,
  RESOURCE_PRESSURE_FRACTION,
} from './inspectFacts.ts'

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`

/** The limitation to record when there is no usage sample to reason about. */
const usageLimitation = (usage: NamespaceUsageState): string | null => {
  switch (usage._tag) {
    case 'sampled':
      return null
    case 'not-requested':
      return 'No resource usage sampled (pass --with-usage); resource pressure cannot be claimed.'
    case 'unavailable':
      return `No resource usage sampled (${usage.reason}${usage.detail === null ? '' : `: ${usage.detail}`}); resource pressure cannot be claimed.`
  }
}

/**
 * Classify a runner from the GitHub and Namespace facts.
 *
 * Isomorphic and total: no I/O, no clock, no throwing.
 */
export const classifyInspection = ({
  github,
  namespace,
}: {
  readonly github: InspectGitHubFacts
  readonly namespace: InspectNamespaceFacts
}): InspectAssessment => {
  /** Only `in_progress` means the job is executing on its runner right now. */
  const githubRunning = github.status === 'in_progress'
  const githubEvidence = `GitHub reports job ${github.jobId} as ${github.status}${
    github.conclusion === null ? '' : ` (${github.conclusion})`
  }.`

  if (namespace._tag === 'not-namespace-job') {
    return {
      disposition: 'unknown',
      evidence: [githubEvidence],
      limitations: [
        `Runner ${github.runnerName ?? '(none assigned)'} is ${
          namespace.runnerKind === 'unknown' ? 'not assigned' : `a ${namespace.runnerKind} runner`
        }, so Namespace holds no observation for it.`,
      ],
    }
  }

  if (namespace._tag === 'unavailable') {
    return {
      disposition: 'unknown',
      evidence: [githubEvidence],
      limitations: [
        `No Namespace observation (${namespace.reason}${
          namespace.detail === null ? '' : `: ${namespace.detail}`
        }).`,
      ],
    }
  }

  const { job, usage } = namespace
  const instanceEvidence = `Namespace instance ${job.instanceId} is ${job.instanceStatus}${
    job.instanceStatusRaw === null || job.instanceStatusRaw === job.instanceStatus
      ? ''
      : ` (reported as "${job.instanceStatusRaw}")`
  }.`

  /**
   * Pressure outranks liveness: a runner pinned at its allocation is the
   * actionable finding whether or not the job is still moving.
   */
  if (usage._tag === 'sampled') {
    const { sample } = usage
    const cpuPressure = sample.cpuMaxFraction >= RESOURCE_PRESSURE_FRACTION
    const ramPressure = sample.ramMaxFraction >= RESOURCE_PRESSURE_FRACTION
    const usageEvidence = `Peak usage ${percent(sample.cpuMaxFraction)} of ${sample.allocatedCpu} allocated CPU and ${percent(sample.ramMaxFraction)} of ${sample.allocatedRamGb} GB allocated RAM.`

    if (cpuPressure || ramPressure) {
      return {
        disposition: 'resource-pressure',
        evidence: [
          githubEvidence,
          instanceEvidence,
          usageEvidence,
          `At or above the ${percent(RESOURCE_PRESSURE_FRACTION)} pressure threshold on ${
            cpuPressure && ramPressure ? 'CPU and RAM' : cpuPressure ? 'CPU' : 'RAM'
          }.`,
        ],
        limitations: [],
      }
    }

    if (job.instanceStatus === 'running') {
      return githubRunning
        ? {
            disposition: 'active',
            evidence: [githubEvidence, instanceEvidence, usageEvidence],
            limitations: [],
          }
        : {
            disposition: 'idle',
            evidence: [githubEvidence, instanceEvidence, usageEvidence],
            limitations: [],
          }
    }

    return {
      disposition: 'unknown',
      evidence: [githubEvidence, instanceEvidence, usageEvidence],
      limitations: [unmatchedLiveness({ githubRunning, instanceStatus: job.instanceStatus })],
    }
  }

  const noUsage = usageLimitation(usage)
  const limitations = noUsage === null ? [] : [noUsage]

  if (job.instanceStatus === 'running') {
    return {
      disposition: githubRunning ? 'active' : 'idle',
      evidence: [githubEvidence, instanceEvidence],
      limitations,
    }
  }

  return {
    disposition: 'unknown',
    evidence: [githubEvidence, instanceEvidence],
    limitations: [
      unmatchedLiveness({ githubRunning, instanceStatus: job.instanceStatus }),
      ...limitations,
    ],
  }
}

/** Why a live/not-live pairing cannot be turned into `active` or `idle`. */
const unmatchedLiveness = ({
  githubRunning,
  instanceStatus,
}: {
  readonly githubRunning: boolean
  readonly instanceStatus: 'destroyed' | 'unknown'
}): string => {
  if (instanceStatus === 'unknown') {
    return githubRunning
      ? 'Namespace did not report instance liveness, so a running GitHub job cannot be confirmed on the runner.'
      : 'Namespace did not report instance liveness, so the runner cannot be called idle.'
  }
  return githubRunning
    ? 'GitHub reports the job running but Namespace reports the instance destroyed; the two sources disagree.'
    : 'The instance is gone, so there is no live runner to describe.'
}
