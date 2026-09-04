import * as NodePath from 'node:path'

import { FileSystem } from 'effect'
import { Effect, Schema } from 'effect'

import type { CaptureHandle } from './Otelite.ts'
import { LogRow, LogSummary, MetricRow, MetricSummary, SpanRow, TraceSummary } from './schema.ts'

/** Versioned trace diagnostic bundle written to `trace.json`. */
export const TraceJson = Schema.Struct({
  schema: Schema.Literal('otelite.trace-json/v1'),
  summary: TraceSummary,
  spans: Schema.Array(SpanRow),
}).annotate({ identifier: 'Otelite.TraceJson' })
export type TraceJson = typeof TraceJson.Type

/** Versioned metrics diagnostic bundle written to `metrics.json`. */
export const MetricsJson = Schema.Struct({
  schema: Schema.Literal('otelite.metrics-json/v1'),
  summary: MetricSummary,
  metrics: Schema.Array(MetricRow),
}).annotate({ identifier: 'Otelite.MetricsJson' })
export type MetricsJson = typeof MetricsJson.Type

/** Versioned log diagnostic bundle written to `logs.json`. */
export const LogsJson = Schema.Struct({
  schema: Schema.Literal('otelite.logs-json/v1'),
  summary: LogSummary,
  logs: Schema.Array(LogRow),
}).annotate({ identifier: 'Otelite.LogsJson' })
export type LogsJson = typeof LogsJson.Type

/** Paths written by `writeCaptureDiagnostics`. */
export const DiagnosticFiles = Schema.Struct({
  traceJson: Schema.String,
  traceSummaryJson: Schema.String,
  metricsJson: Schema.optional(Schema.String),
  metricsSummaryJson: Schema.optional(Schema.String),
  logsJson: Schema.optional(Schema.String),
  logsSummaryJson: Schema.optional(Schema.String),
}).annotate({ identifier: 'Otelite.DiagnosticFiles' })
export type DiagnosticFiles = typeof DiagnosticFiles.Type

/** Inputs for writing a diagnostic bundle from an existing otelite capture. */
export interface WriteCaptureDiagnosticsOptions {
  readonly capture: CaptureHandle
  readonly outDir: string
  readonly service?: string
  readonly includeMetrics?: boolean
  readonly includeLogs?: boolean
}

/**
 * Write a stable, inspection-oriented OTEL diagnostic bundle from an existing
 * otelite capture. The otelite CLI remains the source of truth: this helper only
 * calls `inspect`, schema-encodes the typed rows/summaries, and writes files.
 */
export const writeCaptureDiagnostics = Effect.fn('otelite.diagnostics.write', {
  attributes: { 'span.label': 'write' },
})(function* ({
  capture,
  outDir,
  service,
  includeMetrics = false,
  includeLogs = false,
}: WriteCaptureDiagnosticsOptions) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(outDir, { recursive: true })

  const traceSummary = yield* capture.inspect({
    signal: 'traces',
    summary: true,
    ...(service === undefined ? {} : { service }),
  })
  const spans = yield* capture.inspect({
    signal: 'traces',
    ...(service === undefined ? {} : { service }),
  })

  const traceJsonPath = NodePath.join(outDir, 'trace.json')
  const traceSummaryPath = NodePath.join(outDir, 'trace-summary.json')
  yield* writeJson({
    path: traceJsonPath,
    content: encodeJson(TraceJson)({
      schema: 'otelite.trace-json/v1',
      summary: traceSummary,
      spans,
    }),
  })
  yield* writeJson({
    path: traceSummaryPath,
    content: encodeJson(TraceSummary)(traceSummary),
  })

  let metricsJsonPath: string | undefined
  let metricsSummaryPath: string | undefined
  if (includeMetrics === true) {
    const metricSummary = yield* capture.inspect({
      signal: 'metrics',
      summary: true,
      ...(service === undefined ? {} : { service }),
    })
    const metrics = yield* capture.inspect({
      signal: 'metrics',
      ...(service === undefined ? {} : { service }),
    })
    metricsJsonPath = NodePath.join(outDir, 'metrics.json')
    metricsSummaryPath = NodePath.join(outDir, 'metrics-summary.json')
    yield* writeJson({
      path: metricsJsonPath,
      content: encodeJson(MetricsJson)({
        schema: 'otelite.metrics-json/v1',
        summary: metricSummary,
        metrics,
      }),
    })
    yield* writeJson({
      path: metricsSummaryPath,
      content: encodeJson(MetricSummary)(metricSummary),
    })
  }

  let logsJsonPath: string | undefined
  let logsSummaryPath: string | undefined
  if (includeLogs === true) {
    const logSummary = yield* capture.inspect({
      signal: 'logs',
      summary: true,
      ...(service === undefined ? {} : { service }),
    })
    const logs = yield* capture.inspect({
      signal: 'logs',
      ...(service === undefined ? {} : { service }),
    })
    logsJsonPath = NodePath.join(outDir, 'logs.json')
    logsSummaryPath = NodePath.join(outDir, 'logs-summary.json')
    yield* writeJson({
      path: logsJsonPath,
      content: encodeJson(LogsJson)({
        schema: 'otelite.logs-json/v1',
        summary: logSummary,
        logs,
      }),
    })
    yield* writeJson({
      path: logsSummaryPath,
      content: encodeJson(LogSummary)(logSummary),
    })
  }

  return {
    traceJson: traceJsonPath,
    traceSummaryJson: traceSummaryPath,
    ...(metricsJsonPath === undefined ? {} : { metricsJson: metricsJsonPath }),
    ...(metricsSummaryPath === undefined ? {} : { metricsSummaryJson: metricsSummaryPath }),
    ...(logsJsonPath === undefined ? {} : { logsJson: logsJsonPath }),
    ...(logsSummaryPath === undefined ? {} : { logsSummaryJson: logsSummaryPath }),
  }
})

const encodeJson =
  <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  (value: S['Type']): string =>
    Schema.encodeSync(Schema.fromJsonString(schema, { space: 2 }))(value)

const writeJson = ({ path, content }: { readonly path: string; readonly content: string }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, `${content}\n`)))
