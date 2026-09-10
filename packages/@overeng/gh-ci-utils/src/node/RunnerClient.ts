import { Duration, Effect, Schema } from 'effect'
/**
 * Client for querying runner-scaler /jobs endpoint on self-hosted runners.
 */
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { RUNNER_SCALER_PORT } from '../isomorphic/lib/constants.ts'

/** Schema for an active job running on a self-hosted runner */
export const ActiveJob = Schema.Struct({
  runner: Schema.String,
  scaleSet: Schema.String,
  host: Schema.String,
  workDir: Schema.String,
  startedAt: Schema.String,
  durationSec: Schema.Finite,
})
export type ActiveJob = typeof ActiveJob.Type

const ActiveJobsResponse = Schema.NullOr(Schema.Array(ActiveJob))

/** Decode the active-jobs API response into structured data */
export const decodeActiveJobsResponse = (input: unknown) =>
  Schema.decodeUnknownEffect(ActiveJobsResponse)(input).pipe(Effect.map((jobs) => jobs ?? []))

/** Result of querying runner hosts for active jobs */
export interface RunnerHostJobsResult {
  readonly host: string
  readonly status: 'reachable' | 'unreachable'
  readonly jobs: ReadonlyArray<ActiveJob>
}

/** Fetch active jobs from a single runner host. */
export const fetchRunnerHostJobs = (
  host: string,
): Effect.Effect<RunnerHostJobsResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient

    const response = yield* httpClient
      .execute(HttpClientRequest.get(`http://${host}:${RUNNER_SCALER_PORT}/jobs`))
      .pipe(Effect.scoped)

    const json = yield* response.json
    const jobs = yield* decodeActiveJobsResponse(json)

    return {
      host,
      status: 'reachable' as const,
      jobs,
    }
  }).pipe(
    Effect.timeout(Duration.seconds(3)),
    Effect.orElseSucceed(() => ({ host, status: 'unreachable' as const, jobs: [] })),
  )

/** Fetch active jobs from all runner hosts. */
export const fetchAllRunnerJobs = (hosts: readonly string[]) =>
  Effect.all(hosts.map(fetchRunnerHostJobs), { concurrency: 'unbounded' }).pipe(
    Effect.map((results) =>
      results.flatMap((result) => (result.status === 'reachable' ? result.jobs : [])),
    ),
  )
