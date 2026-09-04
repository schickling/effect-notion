// Generated file - DO NOT EDIT
// Source: registry.gen.ts.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:a1a9f5f6c37dd10a12f9bc9cfb52059faf3c7499fb9597d6b9f5877651e0ef46

export const otelScrapeTelemetryRegistry = {
  "schemaVersion": 1,
  "namespace": "otel_scrape",
  "spans": [
    {
      "id": "command",
      "naming": "program-basename",
      "description": "One otel-scrape wrapper invocation. Named by the wrapped program's basename (decision 0014) and conforms to the OTel span.cli.internal convention (decision 0016): span_kind INTERNAL, name = process.executable.name. Ownership is carried by otel_scrape.span.origin=otel-scrape and otel.scope.name=otel-scrape."
    },
    {
      "id": "process",
      "naming": "descendant-basename",
      "description": "One observed descendant process. Named by the observed descendant program's basename (decision 0014). Emitted as a distinct span only under an exact backend that proves a real descendant; the default degraded direct-child observation is merged into the command span (fidelity=merged)."
    }
  ],
  "metrics": [
    {
      "id": "oxlint_diagnostics",
      "name": "oxlint.diagnostics",
      "description": "Number of oxlint diagnostics parsed from one JSON report."
    },
    {
      "id": "deadnix_findings",
      "name": "deadnix.findings",
      "description": "Number of dead-code findings parsed from one deadnix JSON (NDJSON) report. Public-safe count only; no file paths, symbol names, or messages."
    },
    {
      "id": "vitest_tests",
      "name": "vitest.tests",
      "description": "Number of tests reported by one vitest JSON side-channel run (numTotalTests). Public-safe count only; no test names, files, or messages (decision 0017)."
    },
    {
      "id": "vitest_failures",
      "name": "vitest.failures",
      "description": "Number of failing tests reported by one vitest JSON side-channel run (numFailedTests). Public-safe count only; no test names, files, or messages (decision 0017)."
    }
  ],
  "attributes": [
    {
      "id": "scope_name",
      "key": "otel.scope.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "stable",
      "examples": [
        "otel-scrape"
      ],
      "description": "Instrumentation scope name; otel-scrape for wrapper-owned spans."
    },
    {
      "id": "otel_scrape_span_origin",
      "key": "otel_scrape.span.origin",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "otel-scrape",
        "otel-scrape-adapter"
      ],
      "description": "Vendor attribute (decision 0016): origin of the span. otel-scrape for wrapper-owned spans, otel-scrape-adapter for adapter-derived phase spans. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "process_executable_name",
      "key": "process.executable.name",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "tsc",
        "cargo",
        "node"
      ],
      "note": "Best-effort cardinality normalization (bounded_program_name) is applied at every emission site (decision 0016, M25.1) — both the command span and observed-process spans — to collapse common high-entropy forms toward the fallback token <binary>: uuid temp scripts, long hex hashes, overlong names (length > 64 or outside [A-Za-z0-9._+-]), and nix-store <hash>-name prefixes (the hash is stripped so the real name survives). The value is nonetheless formally `high`: wrapped-command names are user-controlled, so residual high-entropy names may survive the normalization. span.cli explicitly permits a documented low-cardinality span-name format; this normalization is a best-effort approximation of that, not a formal bound.",
      "description": "OTel semconv (decision 0016): base name of the wrapped executable; the span-name source. A public-safe identity — never a full path or arguments — always present. Best-effort cardinality normalization is applied at emission (decision 0016, M25.1), but the value remains formally `high` because wrapped-command names are user-controlled."
    },
    {
      "id": "otel_scrape_command_argv_hash",
      "key": "otel_scrape.command.argv_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Vendor attribute (decision 0016): stable hash of command argv, never raw arguments. Always present; the correlation/dedup key. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "otel_scrape_command_cwd_hash",
      "key": "otel_scrape.command.cwd_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Vendor attribute (decision 0016): stable hash of the current working directory identity, never a raw path. Always present. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "process_command_args",
      "key": "process.command_args",
      "valueType": "string[]",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "examples": [
        [
          "node",
          "--version"
        ]
      ],
      "note": "Raw command argv as an array (one element per argument), aligned to OTel semconv (decision 0016). Privacy travels with the rename (decision 0015): trust-gated and dropped by default (encode=drop). Emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default.",
      "description": "OTel semconv (decision 0016): raw command argv as a string array. Trust-gated (decision 0015): emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default."
    },
    {
      "id": "process_working_directory",
      "key": "process.working_directory",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "examples": [
        "/home/user/project"
      ],
      "note": "Raw current working directory, aligned to OTel semconv (decision 0016). Privacy travels with the rename (decision 0015): trust-gated and dropped by default (encode=drop).",
      "description": "OTel semconv (decision 0016): raw current working directory / local path. Trust-gated (decision 0015): emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default."
    },
    {
      "id": "adapter_name",
      "key": "otel_scrape.adapter.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "oxlint",
        "node-cpuprofile",
        "none"
      ],
      "description": "Selected adapter name."
    },
    {
      "id": "adapter_event_severity",
      "key": "severity",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "warning",
        "error"
      ],
      "description": "Severity of an adapter diagnostic event (e.g. an oxlint diagnostic severity). Public-safe (decision 0017): a bounded severity token, never source text or a path. Carried on the otel_scrape.adapter.event span event."
    },
    {
      "id": "adapter_event_source_filename_hash",
      "key": "source.filename_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "note": "The filename stays HASHED at every sink (decision 0015/0017): the raw path is payload-derived and never emitted; only the stable hashed identity crosses a sink. The summary record carries the same identity under its local field name filename_hash.",
      "description": "Hashed source-file identity for an adapter diagnostic event; never a raw path. Carried on the otel_scrape.adapter.event span event."
    },
    {
      "id": "adapter_event_rule",
      "key": "otel_scrape.adapter.rule",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "eslint(no-debugger)",
        "eslint(no-unused-vars)"
      ],
      "note": "Emitted verbatim (the plugin-qualified linter code exactly as the tool reports it, e.g. `eslint(no-debugger)`), not stripped to the bare rule name. Bounded cardinality: the linter's rule set is a fixed, enumerable list.",
      "description": "Rule/linter code of an adapter diagnostic event (H5, the oxlint rule id). Public-safe (decision 0017): a public lint-rule name, never source text or a path. Carried on the otel_scrape.adapter.event span event and the summary record."
    },
    {
      "id": "adapter_event_line",
      "key": "otel_scrape.adapter.line",
      "valueType": "int",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        2,
        42
      ],
      "note": "A plain 1-based line number. Public-safe (H5, decision 0017): an integer offset into a file — not a path, source text, or private data. Formally high cardinality (spans a file's line range), but cheap and non-sensitive.",
      "description": "1-based source line of an adapter diagnostic event (H5). Carried on the otel_scrape.adapter.event span event and the summary record."
    },
    {
      "id": "process_exit_code",
      "key": "process.exit.code",
      "valueType": "int",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        0,
        7
      ],
      "description": "OTel semconv (decision 0016): process exit code when available."
    },
    {
      "id": "process_pid",
      "key": "process.pid",
      "valueType": "int",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        12345
      ],
      "description": "OTel semconv (decision 0016, M25.1): raw process id of the wrapped direct child. REQUIRED by attributes.cli.common. A pid is ephemeral/local — not a path, argument, or credential — so it is emitted raw (never hashed) and is NOT trust-gated. The vendor pid_hash stays on observed-process spans for descendant-observation correlation; the two coexist."
    },
    {
      "id": "error_type",
      "key": "error.type",
      "valueType": "string",
      "cardinality": "low",
      "stability": "stable",
      "examples": [
        "_OTHER"
      ],
      "description": "OTel semconv (decision 0016, M25.1): error class on the command span. Conditionally required by attributes.cli.common iff process.exit.code != 0. Kept LOW cardinality: otel-scrape cannot classify the wrapped tool's error domain, so it always uses the semconv well-known fallback value _OTHER. Never carries the exit code or signal (that would blow cardinality). Absent when the child exits 0."
    },
    {
      "id": "process_observation_backend",
      "key": "otel_scrape.process.observation.backend",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "direct-child",
        "ptrace-experimental",
        "helper-stream"
      ],
      "description": "Process observation backend that produced this process evidence."
    },
    {
      "id": "process_observation_fidelity",
      "key": "otel_scrape.process.observation.fidelity",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "exact",
        "merged",
        "degraded"
      ],
      "description": "Process observation fidelity: exact, merged (degraded direct-child folded into the command span), or a degraded evidence value."
    },
    {
      "id": "process_observation_relation",
      "key": "otel_scrape.process.observation.relation",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "direct-child",
        "descendant"
      ],
      "description": "Relationship between the observed process and the wrapper command span."
    },
    {
      "id": "tool_name",
      "key": "tool.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "oxlint",
        "tsc"
      ],
      "description": "Detected tool identity."
    },
    {
      "id": "tool_version",
      "key": "tool.version",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "1.2.3"
      ],
      "description": "Detected tool version when cheap and safe."
    },
    {
      "id": "profile_type",
      "key": "profile.type",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "cpu"
      ],
      "description": "Native profile artifact kind."
    },
    {
      "id": "profile_digest",
      "key": "profile.digest",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Profile artifact sha256 digest."
    },
    {
      "id": "profile_uri",
      "key": "profile.uri",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "cas:sha256/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Location-independent CAS retrieval URI."
    },
    {
      "id": "profile_ui",
      "key": "profile.ui",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "https://profiler.example/view/abc"
      ],
      "description": "Optional profile viewer URI."
    },
    {
      "id": "command_program",
      "key": "command.program",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.executable.name"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.executable.name. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_argv_hash",
      "key": "command.argv_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.command.argv_hash"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.command.argv_hash. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_cwd_hash",
      "key": "command.cwd_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.command.cwd_hash"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.command.cwd_hash. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_argv",
      "key": "command.argv",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.command_args"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.command_args and retyped from a newline-joined string to a string array. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_cwd",
      "key": "command.cwd",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.working_directory"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.working_directory. Retained for the evolution trail; not emitted."
    },
    {
      "id": "process_exit_code_deprecated",
      "key": "process.exit_code",
      "valueType": "int",
      "cardinality": "low",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.exit.code"
      },
      "description": "Deprecated (decision 0016): the underscore form is renamed to the OTel semconv key process.exit.code. Retained for the evolution trail; not emitted."
    },
    {
      "id": "span_origin",
      "key": "span.origin",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.span.origin"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.span.origin. Retained for the evolution trail; not emitted."
    }
  ],
  "profileFields": [
    {
      "id": "type",
      "field": "type"
    },
    {
      "id": "digest",
      "field": "digest"
    },
    {
      "id": "uri",
      "field": "uri"
    },
    {
      "id": "ui",
      "field": "ui"
    },
    {
      "id": "byte_length",
      "field": "byteLength"
    },
    {
      "id": "media_type",
      "field": "mediaType"
    },
    {
      "id": "codec",
      "field": "codec"
    },
    {
      "id": "schema_version",
      "field": "schemaVersion"
    }
  ],
  "schemas": [
    {
      "id": "summary_v1",
      "value": "otel-scrape.summary/v1"
    }
  ]
} as const

// Spans are named by the operation they represent (decision 0014), not by a
// fixed instrumentation constant. The registry owns the naming *scheme* per
// span id; the emitted name is the program / descendant / adapter-phase
// basename resolved at runtime.
export const otelScrapeSpanNaming = {
  "command": "program-basename",
  "process": "descendant-basename"
} as const

export const otelScrapeMetricNames = {
  "oxlintDiagnostics": "oxlint.diagnostics",
  "deadnixFindings": "deadnix.findings",
  "vitestTests": "vitest.tests",
  "vitestFailures": "vitest.failures"
} as const

export const otelScrapeAttributeKeys = {
  "scopeName": "otel.scope.name",
  "otelScrapeSpanOrigin": "otel_scrape.span.origin",
  "processExecutableName": "process.executable.name",
  "otelScrapeCommandArgvHash": "otel_scrape.command.argv_hash",
  "otelScrapeCommandCwdHash": "otel_scrape.command.cwd_hash",
  "processCommandArgs": "process.command_args",
  "processWorkingDirectory": "process.working_directory",
  "adapterName": "otel_scrape.adapter.name",
  "adapterEventSeverity": "severity",
  "adapterEventSourceFilenameHash": "source.filename_hash",
  "adapterEventRule": "otel_scrape.adapter.rule",
  "adapterEventLine": "otel_scrape.adapter.line",
  "processExitCode": "process.exit.code",
  "processPid": "process.pid",
  "errorType": "error.type",
  "processObservationBackend": "otel_scrape.process.observation.backend",
  "processObservationFidelity": "otel_scrape.process.observation.fidelity",
  "processObservationRelation": "otel_scrape.process.observation.relation",
  "toolName": "tool.name",
  "toolVersion": "tool.version",
  "profileType": "profile.type",
  "profileDigest": "profile.digest",
  "profileUri": "profile.uri",
  "profileUi": "profile.ui",
  "commandProgram": "command.program",
  "commandArgvHash": "command.argv_hash",
  "commandCwdHash": "command.cwd_hash",
  "commandArgv": "command.argv",
  "commandCwd": "command.cwd",
  "processExitCodeDeprecated": "process.exit_code",
  "spanOrigin": "span.origin"
} as const

export const otelScrapeProfileFields = {
  "type": "type",
  "digest": "digest",
  "uri": "uri",
  "ui": "ui",
  "byteLength": "byteLength",
  "mediaType": "mediaType",
  "codec": "codec",
  "schemaVersion": "schemaVersion"
} as const

export const otelScrapeSchemas = {
  "summaryV1": "otel-scrape.summary/v1"
} as const

export type OtelScrapeSpanNaming =
  (typeof otelScrapeSpanNaming)[keyof typeof otelScrapeSpanNaming]

export type OtelScrapeMetricName =
  (typeof otelScrapeMetricNames)[keyof typeof otelScrapeMetricNames]

export type OtelScrapeAttributeKey =
  (typeof otelScrapeAttributeKeys)[keyof typeof otelScrapeAttributeKeys]
