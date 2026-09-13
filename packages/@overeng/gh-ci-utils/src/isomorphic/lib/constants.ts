import { Duration } from 'effect'

/** Runner-scaler HTTP API port */
export const RUNNER_SCALER_PORT = 41020

/** Poll interval for the first watch tick and after any observed change */
export const POLL_INTERVAL = Duration.seconds(5)

/**
 * Ceiling the watch backs off to while nothing changes or budget is tight:
 * {@link POLL_INTERVAL} doubled three times.
 */
export const MAX_POLL_INTERVAL = Duration.seconds(40)

/** Poll interval for log streaming */
export const LOG_POLL_INTERVAL = Duration.seconds(10)

/** Default concurrency for parallel API calls */
export const API_CONCURRENCY = 5

/** Default number of log lines to show for failed jobs */
export const DEFAULT_LOG_TAIL = 100
