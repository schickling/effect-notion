use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    thread,
};

#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::net::UnixListener;

fn otel_scrape() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_otel-scrape"));
    command
        .env_remove("OTEL_EXPORTER_OTLP_ENDPOINT")
        .env_remove("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        .env_remove("OTEL_EXPORTER_OTLP_HEADERS")
        .env_remove("OTEL_EXPORTER_OTLP_TRACES_HEADERS")
        .env_remove("OTEL_EXPORTER_OTLP_TIMEOUT")
        .env_remove("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT")
        .env_remove("OTEL_EXPORTER_OTLP_PROTOCOL")
        .env_remove("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
        .env_remove("OTEL_EXPORTER_OTLP_COMPRESSION")
        .env_remove("OTEL_EXPORTER_OTLP_TRACES_COMPRESSION")
        .env_remove("OTEL_TRACES_EXPORTER")
        .env_remove("OTEL_SDK_DISABLED")
        .env_remove("OTEL_RESOURCE_ATTRIBUTES")
        .env_remove("OTEL_SERVICE_NAME")
        // Keep the trust gate hermetic: the default must stay hashed-only
        // regardless of the ambient environment (decision 0015).
        .env_remove("OTEL_SCRAPE_TRUSTED_SINK")
        // Keep root trace surfacing hermetic: ambient template/switch must not
        // leak into tests that exercise the flags (decision 0020).
        .env_remove("OTEL_SCRAPE_TRACE_URL_TEMPLATE")
        .env_remove("OTEL_SCRAPE_TRACE_LINK")
        // Scrub inbound trace context so a run is root by default; joined-run
        // tests opt in by setting `traceparent` explicitly. Without this, an
        // ambient TRACEPARENT (common in a traced shell) makes every run joined.
        .env_remove("traceparent")
        .env_remove("TRACEPARENT");
    command
}

#[test]
fn preserves_passthrough_and_writes_summary() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        // Isolate child-stream fidelity: silence root trace surfacing (decision
        // 0020) so stderr stays byte-exact to the child. Surfacing has its own
        // dedicated tests.
        .args(["--trace-link", "off"])
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "echo child-out; echo child-err >&2; exit 7",
        ])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child-out\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "child-err\n");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["schema"], "otel-scrape.summary/v1");
    assert_eq!(summary["child"]["exit_code"], 7);
    assert_eq!(summary["adapter"]["name"], "none");
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(summary["output"]["stdout"], serde_json::Value::Null);
    assert_eq!(summary["output"]["stderr"], serde_json::Value::Null);
    assert!(summary["resources"]["wallMs"].as_u64().is_some());
    assert_eq!(summary["resources"]["cpuTimeMs"], serde_json::Value::Null);
    assert_eq!(summary["resources"]["maxRssBytes"], serde_json::Value::Null);
    assert_eq!(
        summary["resources"]["availability"]["cpuTime"],
        "unavailable"
    );
    assert_eq!(
        summary["resources"]["availability"]["maxRss"],
        "unavailable"
    );
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    // Public-safe program identity (decision 0014, R01): basename, always present.
    assert_eq!(summary["command"]["program"], "sh");
    assert!(summary["command"]["argv_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(summary["command"]["cwd_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    // Raw argv/cwd remain trust-gated (M2), never present in M1.
    assert!(summary["command"].get("argv").is_none());
    assert!(summary["command"].get("cwd").is_none());
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["processes"]["reason"], "direct-child-only");
    assert_eq!(
        summary["processes"]["observed"].as_array().unwrap().len(),
        1
    );
    let process = &summary["processes"]["observed"][0];
    assert_eq!(process["_tag"], "Process");
    assert_eq!(process["relation"], "direct-child");
    assert_eq!(process["parentSpanId"], summary["trace"]["span_id"]);
    assert!(process["spanId"].as_str().unwrap().len() == 16);
    assert!(process["pidHash"].as_str().unwrap().starts_with("sha256:"));
    assert!(process["parentPidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(process["argvHash"], summary["command"]["argv_hash"]);
    assert_eq!(process["exitCode"], 7);
    assert!(process["startUnixNano"].as_u64().is_some());
    assert!(process["endUnixNano"].as_u64().is_some());
    assert!(process.get("pid").is_none());
    assert!(process.get("parentPid").is_none());
    assert!(process.get("argv").is_none());
}

// Supersedes the pre-M25.1b `oxlint_adapter_parses_json_diagnostics_without_hiding_stdout`
// test: the raw-JSON stdout tee is replaced by structured-in / pretty-out
// (decision 0017). This test proves the render (UX-neutral presentation, R30); a
// companion test proves the byte-level privacy invariant across BOTH sinks.
#[test]
fn oxlint_adapter_renders_human_summary_instead_of_teeing_raw_json() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let oxlint_json = r#"{ "privatePayload": "PRIVATE_OUTPUT_PAYLOAD", "diagnostics": [{"message": "Unexpected token","severity": "error","filename": "/private/source.ts","code": "eslint(no-undef)"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Presentation ownership (R30): the operator sees a concise human summary,
    // not a raw JSON dump. The render MAY show the full message/path — this is the
    // operator's own terminal, not a sink (decision 0017 clause 4).
    assert!(
        stdout.contains("oxlint: 1 diagnostic(s) over 1 file(s)"),
        "stdout should show the rendered summary, got: {stdout}"
    );
    assert!(stdout.contains("error"));
    assert!(stdout.contains("/private/source.ts"));
    // The raw structured source is SUPPRESSED — it must not be teed to the terminal.
    assert!(
        !stdout.contains("PRIVATE_OUTPUT_PAYLOAD") && !stdout.contains("\"diagnostics\""),
        "raw JSON must not be dumped to the terminal, got: {stdout}"
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "oxlint");
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(summary["adapter"]["records"][0]["_tag"], "Metric");
    assert_eq!(
        summary["adapter"]["records"][0]["name"],
        "oxlint.diagnostics"
    );
    assert_eq!(summary["adapter"]["records"][0]["value"], 1);
    assert_eq!(summary["adapter"]["records"][1]["_tag"], "Event");
    assert_eq!(summary["adapter"]["records"][1]["severity"], "error");
    assert!(summary["adapter"]["records"][1]["filename_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    // Privacy (decision 0017 clause 4, R27): the raw diagnostic message is DROPPED
    // from the summary record — it is not a field at all, so it cannot regress.
    assert!(summary["adapter"]["records"][1].get("message").is_none());
    assert!(summary["adapter"]["records"][1].get("filename").is_none());
}

// The byte-level non-leak invariant (R27 / decision 0015, refined by 0017 clause
// 4): the raw diagnostic message and raw filename are ABSENT from BOTH the summary
// and the OTLP payload, while the hashed filename identity is present in both. The
// render legitimately shows them on the terminal, so absence is asserted in the
// sinks only, never in stdout.
#[test]
fn oxlint_adapter_keeps_raw_message_and_path_out_of_both_sinks() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");
    let raw_message = "Unexpected token in private source";
    let raw_filename = "/private/secret-source.ts";
    let oxlint_json = format!(
        r#"{{ "privatePayload": "PRIVATE_OUTPUT_PAYLOAD", "diagnostics": [{{"message": {raw_message:?}, "severity": "error", "filename": {raw_filename:?}}}] }}"#,
    );

    let out = otel_scrape()
        .env("OX_JSON", &oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary_path)
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();
    assert!(out.status.success());

    let summary_bytes = std::fs::read(&summary_path).unwrap();
    let request = collector.request();
    for (label, bytes) in [
        ("summary", summary_bytes.as_slice()),
        ("otlp", request.body.as_slice()),
    ] {
        let haystack = String::from_utf8_lossy(bytes);
        assert!(
            !haystack.contains(raw_message),
            "raw diagnostic message leaked into {label}"
        );
        assert!(
            !haystack.contains(raw_filename),
            "raw filename leaked into {label}"
        );
        assert!(
            !haystack.contains("PRIVATE_OUTPUT_PAYLOAD"),
            "raw JSON envelope leaked into {label}"
        );
    }

    // The hashed filename identity IS carried through both sinks.
    let summary: serde_json::Value = serde_json::from_slice(&summary_bytes).unwrap();
    let filename_hash = summary["adapter"]["records"][1]["filename_hash"]
        .as_str()
        .unwrap();
    assert!(filename_hash.starts_with("sha256:"));
    let otlp = String::from_utf8_lossy(&request.body);
    assert!(
        otlp.contains(filename_hash),
        "hashed filename identity should be present in OTLP"
    );
    assert!(otlp.contains("source.filename_hash"));
}

// Adapter event richness (H5): the oxlint rule id (linter code, emitted
// verbatim) and the diagnostic line land in BOTH the OTLP event and the summary
// record — cheap, non-sensitive locators (a public rule name + an integer). The
// byte-level non-leak invariant still holds: the raw filename/path and raw
// message stay byte-absent from both sinks, and the filename stays HASHED.
#[test]
fn oxlint_adapter_emits_rule_and_line_in_both_sinks_with_filename_hashed() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");
    let raw_message = "`debugger` statement is not allowed";
    let raw_filename = "/private/secret-source.ts";
    let rule = "eslint(no-debugger)";
    // Mirrors real oxlint miette JSON: rule in `code`, line in labels[].span.line.
    let oxlint_json = format!(
        r#"{{ "diagnostics": [{{"message": {raw_message:?}, "severity": "warning", "filename": {raw_filename:?}, "code": {rule:?}, "labels": [{{"span": {{"offset": 10, "length": 8, "line": 2, "column": 1}}}}]}}] }}"#,
    );

    let out = otel_scrape()
        .env("OX_JSON", &oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary_path)
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();
    assert!(out.status.success());

    let summary_bytes = std::fs::read(&summary_path).unwrap();
    let request = collector.request();

    // rule + line present in the summary record (local field names rule/line).
    let summary: serde_json::Value = serde_json::from_slice(&summary_bytes).unwrap();
    let event = &summary["adapter"]["records"][1];
    assert_eq!(event["_tag"], "Event");
    assert_eq!(event["severity"], "warning");
    assert_eq!(event["rule"], rule);
    assert_eq!(event["line"], 2);
    let filename_hash = event["filename_hash"].as_str().unwrap();
    assert!(filename_hash.starts_with("sha256:"));
    // Raw filename/message never became summary fields.
    assert!(event.get("filename").is_none());
    assert!(event.get("message").is_none());

    // rule + line present in the OTLP adapter event, under the registered keys.
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let events = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["events"]
        .as_array()
        .unwrap();
    let adapter_event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.adapter.event")
        .expect("an otel_scrape.adapter.event should be present");
    let attrs = adapter_event["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(attrs, "otel_scrape.adapter.rule").as_deref(),
        Some(rule)
    );
    assert_eq!(
        attr_value(attrs, "otel_scrape.adapter.line").as_deref(),
        Some("2")
    );
    assert_eq!(
        attr_value(attrs, "source.filename_hash").as_deref(),
        Some(filename_hash)
    );

    // Byte-level non-leak invariant across BOTH sinks (R27 / decisions 0015/0017).
    for (label, bytes) in [
        ("summary", summary_bytes.as_slice()),
        ("otlp", request.body.as_slice()),
    ] {
        let haystack = String::from_utf8_lossy(bytes);
        assert!(
            !haystack.contains(raw_message),
            "raw diagnostic message leaked into {label}"
        );
        assert!(
            !haystack.contains(raw_filename),
            "raw filename leaked into {label}"
        );
    }
}

#[test]
fn oxlint_adapter_parse_failure_preserves_output_and_exit_status() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let invalid_json = "{not-json";

    let out = otel_scrape()
        .env("OX_JSON", invalid_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\"; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), invalid_json);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["child"]["exit_code"], 7);
    assert_eq!(summary["adapter"]["name"], "oxlint");
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(
        summary["output"]["stdout"]["byteLength"],
        invalid_json.len()
    );
}

#[test]
fn oxlint_adapter_does_not_turn_plain_output_lines_into_spans() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let plain_output = "line one\nline two\nline three\n";

    let out = otel_scrape()
        .env("PLAIN_OUTPUT", plain_output)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$PLAIN_OUTPUT\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), plain_output);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    let records = summary["adapter"]["records"].as_array().unwrap();
    assert!(records
        .iter()
        .all(|record| record["_tag"] == "Event" || record["_tag"] == "Metric"));
    assert_eq!(records.len(), 0);
}

#[test]
fn parent_wrapper_preserves_nested_output_without_reclassifying_child_owned_adapter_records() {
    let dir = tempfile::tempdir().unwrap();
    let outer_summary = dir.path().join("outer-summary.json");
    let inner_summary = dir.path().join("inner-summary.json");
    let oxlint_json = r#"{ "diagnostics": [{"message": "Nested diagnostic","severity": "warning","filename": "nested.ts"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&outer_summary)
        .args(["--", env!("CARGO_BIN_EXE_otel-scrape")])
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&inner_summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    // Pretty-out composes through re-entrancy (decision 0017): the INNER wrapper
    // owns presentation and renders the human summary; the OUTER passes it through
    // as human text — NOT reparseable JSON — so leaf-ownership per 0002 holds and
    // the outer does not re-parse the inner's rendered output into records.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("oxlint: 1 diagnostic(s) over 1 file(s)"),
        "outer stdout should be the inner's rendered summary, got: {stdout}"
    );
    assert!(
        !stdout.contains("\"diagnostics\""),
        "outer stdout must not be reparseable raw JSON, got: {stdout}"
    );

    let outer: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(outer_summary).unwrap()).unwrap();
    let inner: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(inner_summary).unwrap()).unwrap();

    assert_eq!(outer["adapter"]["name"], "oxlint");
    assert_eq!(outer["adapter"]["ownership"]["stdout"], "child-wrapper");
    assert_eq!(outer["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(outer["output"]["stdout"]["_tag"], "ContentDescriptor");
    // The outer captured exactly the human text it passed through (the inner's
    // render), not the raw JSON the inner consumed.
    assert_eq!(outer["output"]["stdout"]["byteLength"], out.stdout.len());

    assert_eq!(inner["adapter"]["name"], "oxlint");
    assert_eq!(inner["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(inner["adapter"]["records"][0]["_tag"], "Metric");
    assert_eq!(inner["adapter"]["records"][1]["_tag"], "Event");

    assert_eq!(outer["trace"]["trace_id"], inner["trace"]["trace_id"]);
    assert_eq!(inner["trace"]["parent_span_id"], outer["trace"]["span_id"]);
    assert_ne!(
        outer["trace"]["child_traceparent"],
        inner["trace"]["child_traceparent"]
    );
}

// deadnix diagnostics adapter (adapters/03-deadnix): a thinner mirror of oxlint
// over NDJSON. The structured source is ONE JSON object per file, newline-
// separated (not a top-level array). This proves the whole lane: the summary
// carries a `deadnix.findings` count metric plus one `"warning"` event per finding
// (hashed filename + line), the render shows a compact human summary in place of
// the raw JSON, and the byte-level non-leak invariant (R27 / ADP.DEADNIX-R02)
// holds across BOTH sinks — the dead-symbol `message`, the raw path, and
// `column`/`endColumn` never appear in the summary or the OTLP payload.
#[test]
fn deadnix_adapter_renders_summary_and_keeps_message_path_and_columns_out_of_both_sinks() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");
    // Synthetic dead symbols (effect-utils is public — no real private data). Each
    // message carries a symbol name after ": "; columns leak identifier length.
    let dead_symbol_a = "unusedBindingXYZZY";
    let dead_symbol_b = "deadArgQUUX";
    let raw_path_a = "/private/sample.nix";
    let raw_path_b = "/private/sample2.nix";
    // Realistic multiline NDJSON (mirrors experiment 0003): the stream parser must
    // tolerate whitespace within and between the concatenated per-file objects.
    let ndjson = format!(
        "{{\"file\":{raw_path_a:?},\"results\":[\n  \
         {{\"column\":3,\"endColumn\":16,\"line\":2,\"message\":\"Unused let binding: {dead_symbol_a}\"}},\n  \
         {{\"column\":12,\"endColumn\":15,\"line\":4,\"message\":\"Unused lambda argument: {dead_symbol_b}\"}}]}}\n\
         {{\"file\":{raw_path_b:?},\"results\":[\n  \
         {{\"column\":3,\"endColumn\":11,\"line\":3,\"message\":\"Unused let binding: {dead_symbol_a}\"}}]}}\n",
    );

    let out = otel_scrape()
        .env("DEADNIX_JSON", &ndjson)
        .args(["--adapter", "deadnix", "--summary-out"])
        .arg(&summary_path)
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf '%s' \"$DEADNIX_JSON\""])
        .output()
        .unwrap();
    assert!(out.status.success());

    // Render (R30): a compact human summary replaces the raw JSON dump. The
    // operator's own terminal MAY show file + line; it never shows the raw JSON.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("deadnix: 3 finding(s) over 2 file(s)"),
        "stdout should show the rendered summary, got: {stdout}"
    );
    assert!(
        !stdout.contains("\"results\""),
        "raw NDJSON must not be dumped to the terminal, got: {stdout}"
    );

    let summary_bytes = std::fs::read(&summary_path).unwrap();
    let summary: serde_json::Value = serde_json::from_slice(&summary_bytes).unwrap();
    assert_eq!(summary["adapter"]["name"], "deadnix");
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "this-wrapper");

    // Record 0 is the findings count metric; records 1..=3 are the per-finding
    // events (three findings across two files).
    let records = summary["adapter"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(records[0]["_tag"], "Metric");
    assert_eq!(records[0]["name"], "deadnix.findings");
    assert_eq!(records[0]["value"], 3);
    let expected_lines = [2u64, 4, 3];
    for (event, expected_line) in records[1..].iter().zip(expected_lines) {
        assert_eq!(event["_tag"], "Event");
        assert_eq!(event["severity"], "warning");
        assert_eq!(event["line"], expected_line);
        assert!(event["filename_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        // deadnix has no machine-readable rule; the field is omitted, and the raw
        // path/message never became summary fields (R27 / ADP.DEADNIX-R02).
        assert!(event.get("rule").is_none());
        assert!(event.get("filename").is_none());
        assert!(event.get("message").is_none());
    }

    // The hashed filename identity IS carried through OTLP under the registered key.
    let request = collector.request();
    let filename_hash = records[1]["filename_hash"].as_str().unwrap();
    let otlp = String::from_utf8_lossy(&request.body);
    assert!(
        otlp.contains(filename_hash),
        "hashed filename identity should be present in OTLP"
    );
    assert!(otlp.contains("source.filename_hash"));

    // Byte-level non-leak invariant across BOTH sinks: dead-symbol names, raw
    // paths, and column offsets never cross a sink.
    for (label, bytes) in [
        ("summary", summary_bytes.as_slice()),
        ("otlp", request.body.as_slice()),
    ] {
        let haystack = String::from_utf8_lossy(bytes);
        for needle in [
            dead_symbol_a,
            dead_symbol_b,
            raw_path_a,
            raw_path_b,
            "endColumn",
            "Unused let binding",
        ] {
            assert!(!haystack.contains(needle), "`{needle}` leaked into {label}");
        }
    }
}

// ADP.DEADNIX-R03: a file with no dead code emits zero bytes; the adapter treats an
// empty stream as zero findings — a `deadnix.findings` = 0 metric, no events, no
// parse error, exit status preserved.
#[test]
fn deadnix_adapter_treats_empty_output_as_zero_findings() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--adapter", "deadnix", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf ''"])
        .output()
        .unwrap();

    assert!(out.status.success());
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "deadnix");
    let records = summary["adapter"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["_tag"], "Metric");
    assert_eq!(records[0]["name"], "deadnix.findings");
    assert_eq!(records[0]["value"], 0);
}

#[test]
fn profile_artifact_writes_cas_object_manifest_pin_and_profile_record() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let profile = dir.path().join("profile.cpuprofile");
    std::fs::write(&profile, b"profile-bytes").unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .args(["--cas-pin", "runs/run-1"])
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    let profile_link = &summary["artifacts"]["profiles"][0];
    assert_eq!(profile_link["type"], "cpuprofile");
    assert_eq!(profile_link["byteLength"], 13);
    assert_eq!(profile_link["mediaType"], "application/octet-stream");
    assert!(profile_link["digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(profile_link["uri"]
        .as_str()
        .unwrap()
        .starts_with("cas:sha256/"));
    assert!(profile_link.get("path").is_none());
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(profile.to_string_lossy().as_ref()));

    let object_path = profile_link["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("cas:")
        .unwrap();
    assert_eq!(
        std::fs::read(cas_root.join(object_path)).unwrap(),
        b"profile-bytes"
    );

    let pin: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cas_root.join("pins/runs/run-1")).unwrap())
            .unwrap();
    assert_eq!(pin["_tag"], "ContentPin");
    assert_eq!(pin["schemaVersion"], 1);
    assert_eq!(pin["target"]["mediaType"], "application/json");
    assert_eq!(pin["target"]["codec"], "canonical-json");
    assert_eq!(pin["target"]["schemaVersion"], 1);
    assert_eq!(
        summary["artifacts"]["manifest"]["digest"],
        pin["target"]["digest"]
    );
    assert_eq!(summary["artifacts"]["manifest"]["pin"], "runs/run-1");
    assert_eq!(summary["artifacts"]["manifest"]["entryCount"], 1);

    let manifest_digest = pin["target"]["digest"].as_str().unwrap();
    let manifest_object_path = format!(
        "sha256/{}/{}",
        &manifest_digest["sha256:".len().."sha256:".len() + 2],
        &manifest_digest["sha256:".len() + 2..]
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(cas_root.join(manifest_object_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["_tag"], "ContentManifest");
    assert_eq!(manifest["role"], "otel-scrape-run");
    assert_eq!(
        manifest["entries"][0]["descriptor"]["digest"],
        profile_link["digest"]
    );
    assert_eq!(
        manifest["entries"][0]["logicalPath"],
        "profiles/0-cpuprofile"
    );
    assert_eq!(manifest["entries"][0]["role"], "profile");
}

#[test]
fn missing_profile_artifact_is_structured_degraded_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let missing_profile = dir.path().join("missing.cpuprofile");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", missing_profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    let error = &summary["artifacts"]["errors"][0];
    assert_eq!(error["profileType"], "cpuprofile");
    assert!(error["pathHash"].as_str().unwrap().starts_with("sha256:"));
    assert!(error["message"]
        .as_str()
        .unwrap()
        .starts_with("failed to read profile artifact:"));
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(missing_profile.to_string_lossy().as_ref()));
}

#[test]
fn summary_write_failure_preserves_child_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let summary_path_is_directory = dir.path().join("summary-target");
    std::fs::create_dir(&summary_path_is_directory).unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path_is_directory)
        .args(["--", "sh", "-c", "echo child-out; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child-out\n");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to write summary target sha256:"));
    assert!(!stderr.contains(summary_path_is_directory.to_string_lossy().as_ref()));
    let leftover_temp_files = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("summary-target.tmp-")
        })
        .count();
    assert_eq!(leftover_temp_files, 0);
}

#[cfg(unix)]
#[test]
fn signal_termination_preserves_synthetic_exit_code_and_summary_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "kill -TERM $$"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(143));

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["child"]["exit_code"], serde_json::Value::Null);
    assert_eq!(summary["child"]["success"], false);
    assert_eq!(summary["child"]["termination"]["_tag"], "Signal");
    assert_eq!(summary["child"]["termination"]["signal"], 15);
    assert_eq!(summary["child"]["termination"]["synthetic_exit_code"], 143);
}

#[test]
fn process_observation_fixture_marks_descendant_workload_as_direct_child_only() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let descendant_marker = dir.path().join("descendant-ran");

    let out = otel_scrape()
        .env("DESCENDANT_MARKER", &descendant_marker)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "sh -c 'printf descendant > \"$DESCENDANT_MARKER\"'; printf parent",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "parent");
    assert_eq!(
        std::fs::read_to_string(descendant_marker).unwrap(),
        "descendant"
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["degraded"]["direct_child_only"], true);
    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert_eq!(observed[0]["parentSpanId"], summary["trace"]["span_id"]);
    assert!(observed[0]["pidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[cfg(unix)]
#[test]
fn compiled_process_dag_fixture_gates_descendant_exactness_claims() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let expected_dag = dir.path().join("expected-dag.json");
    let grandchild_record = dir.path().join("grandchild.json");
    let fixture = compile_process_dag_fixture(dir.path());

    let out = otel_scrape()
        .env("OTEL_SCRAPE_EXPECTED_DAG", &expected_dag)
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--"])
        .arg(&fixture)
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "fixture-done");

    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(expected_dag).unwrap()).unwrap();
    assert!(expected["rootPid"].as_u64().is_some());
    let expected_children = expected["children"].as_array().unwrap();
    assert_eq!(expected_children.len(), 3);
    assert_eq!(expected_children[0]["parentPid"], expected["rootPid"]);
    assert_eq!(expected_children[1]["parentPid"], expected["rootPid"]);
    assert_eq!(
        expected_children[2]["parentPid"],
        expected_children[1]["pid"]
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["processes"]["reason"], "direct-child-only");
    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert!(observed[0]["pidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[cfg(target_os = "linux")]
#[test]
fn ptrace_experimental_process_backend_observes_fixture_dag() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let expected_dag = dir.path().join("expected-dag.json");
    let grandchild_record = dir.path().join("grandchild.json");
    let fixture = compile_process_dag_fixture(dir.path());

    let out = otel_scrape()
        .env("OTEL_SCRAPE_EXPECTED_DAG", &expected_dag)
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--process-backend", "ptrace-experimental"])
        .args(["--"])
        .arg(&fixture)
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "fixture-done");

    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(expected_dag).unwrap()).unwrap();
    let expected_root_hash = stable_hash(expected["rootPid"].as_u64().unwrap().to_string());
    let expected_children = expected["children"].as_array().unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "ptrace-experimental");
    assert_eq!(
        summary["processes"]["fidelity"],
        "exact",
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(summary["processes"]["reason"], serde_json::Value::Null);
    assert_eq!(summary["degraded"]["direct_child_only"], false);

    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 4);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert_eq!(observed[0]["pidHash"], expected_root_hash);
    assert_eq!(observed[0]["parentSpanId"], summary["trace"]["span_id"]);
    let root_span_id = observed[0]["spanId"].clone();

    for expected_child in expected_children {
        let pid_hash = stable_hash(expected_child["pid"].as_u64().unwrap().to_string());
        let parent_pid_hash =
            stable_hash(expected_child["parentPid"].as_u64().unwrap().to_string());
        let observed_child = observed
            .iter()
            .find(|process| process["pidHash"] == pid_hash)
            .unwrap_or_else(|| panic!("missing observed child with pid hash {pid_hash}"));
        assert_eq!(observed_child["parentPidHash"], parent_pid_hash);
        assert_eq!(
            observed_child["exitCode"],
            expected_child["exitCode"].as_i64().unwrap()
        );
        assert_eq!(observed_child["relation"], "descendant");
        match expected_child["role"].as_str().unwrap() {
            "immediate-exit" | "nested-parent" => {
                assert_eq!(observed_child["parentSpanId"], root_span_id);
            }
            "grandchild" => {
                assert!(observed_child["parentSpanId"].as_str().is_some());
                assert_ne!(observed_child["parentSpanId"], root_span_id);
            }
            role => panic!("unexpected fixture role {role}"),
        }
    }
}

#[cfg(unix)]
#[test]
fn helper_stream_backend_accepts_complete_fake_helper_stream() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let socket = dir.path().join("helper.sock");
    let run_id_file = dir.path().join("run-id");
    let helper = spawn_fake_helper_stream(&socket, &run_id_file, HelperFixtureMode::Complete);

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--process-backend", "helper-stream"])
        .args(["--process-helper-socket"])
        .arg(&socket)
        .args(["--", "sh", "-c"])
        .arg(format!(
            "printf '%s' \"$OTEL_SCRAPE_RUN_ID\" > {} && printf child",
            run_id_file.display()
        ))
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    helper.join().unwrap();

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "helper-stream");
    assert_eq!(
        summary["processes"]["fidelity"],
        "exact",
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(summary["processes"]["reason"], serde_json::Value::Null);
    assert_eq!(summary["degraded"]["direct_child_only"], false);
    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert_eq!(observed[0]["pidHash"], HELPER_ROOT_PID_HASH);
    assert_eq!(observed[0]["parentSpanId"], summary["trace"]["span_id"]);
    assert_eq!(observed[1]["relation"], "descendant");
    assert_eq!(observed[1]["pidHash"], HELPER_CHILD_PID_HASH);
    assert_eq!(observed[1]["parentPidHash"], HELPER_ROOT_PID_HASH);
    assert_eq!(observed[1]["parentSpanId"], observed[0]["spanId"]);
}

#[cfg(unix)]
#[test]
fn helper_stream_backend_degrades_on_invalid_fake_helper_streams() {
    for (mode, reason) in [
        (HelperFixtureMode::Loss, "event-loss"),
        (HelperFixtureMode::SequenceGap, "sequence-gap"),
        (HelperFixtureMode::RunIdMismatch, "run-id-mismatch"),
        (HelperFixtureMode::VersionMismatch, "version-mismatch"),
        (HelperFixtureMode::HelperDisconnect, "helper-disconnect"),
        (HelperFixtureMode::MissingExit, "lifecycle-incomplete"),
        (
            HelperFixtureMode::ReversedTimestamps,
            "lifecycle-incomplete",
        ),
        (HelperFixtureMode::MultipleRoots, "lifecycle-incomplete"),
        (HelperFixtureMode::ExitBeforeExec, "lifecycle-incomplete"),
        (
            HelperFixtureMode::ChildForkAfterParentExit,
            "lifecycle-incomplete",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let summary = dir.path().join("summary.json");
        let socket = dir.path().join("helper.sock");
        let run_id_file = dir.path().join("run-id");
        let helper = spawn_fake_helper_stream(&socket, &run_id_file, mode);

        let out = otel_scrape()
            .args(["--summary-out"])
            .arg(&summary)
            .args(["--process-backend", "helper-stream"])
            .args(["--process-helper-socket"])
            .arg(&socket)
            .args(["--", "sh", "-c"])
            .arg(format!(
                "printf '%s' \"$OTEL_SCRAPE_RUN_ID\" > {} && printf child",
                run_id_file.display()
            ))
            .output()
            .unwrap();

        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
        helper.join().unwrap();

        let summary: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
        assert_eq!(summary["processes"]["backend"], "helper-stream");
        assert_eq!(summary["processes"]["fidelity"], "degraded");
        assert_eq!(summary["processes"]["reason"], reason);
        assert_eq!(
            summary["processes"]["observed"].as_array().unwrap().len(),
            1
        );
    }
}

#[test]
fn exports_root_traceparent_to_child() {
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join("traceparent");
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .env_remove("traceparent")
        .env_remove("TRACEPARENT")
        .env("ENV_FILE", &env_file)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "printf '%s' \"$traceparent\" > \"$ENV_FILE\"",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    let child_traceparent = std::fs::read_to_string(env_file).unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();

    assert_eq!(summary["trace"]["parent_span_id"], serde_json::Value::Null);
    assert_eq!(summary["trace"]["child_traceparent"], child_traceparent);
    assert!(child_traceparent.starts_with("00-"));
}

// Reparenting fix (decision 0018 clause 4 / experiment 0009): otel-scrape exports
// OTEL_TASK_TRACEPARENT carrying its OWN command-span context, so a task-parented
// sub-span emitter re-parents beneath the command span. It must equal TRACEPARENT
// (the command span's context) and overwrite any inherited task value.
#[test]
fn exports_task_traceparent_carrying_command_span_context_to_child() {
    let dir = tempfile::tempdir().unwrap();
    let task_file = dir.path().join("task-traceparent");
    let child_file = dir.path().join("child-traceparent");
    let summary = dir.path().join("summary.json");
    let inherited_task = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    let parent = "00-11111111111111111111111111111111-2222222222222222-01";

    let out = otel_scrape()
        .env("traceparent", parent)
        // A stale task value inherited from an outer task span must be overwritten.
        .env("OTEL_TASK_TRACEPARENT", inherited_task)
        .env("TASK_FILE", &task_file)
        .env("CHILD_FILE", &child_file)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "printf '%s' \"$OTEL_TASK_TRACEPARENT\" > \"$TASK_FILE\"; printf '%s' \"$traceparent\" > \"$CHILD_FILE\"",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    let task_traceparent = std::fs::read_to_string(&task_file).unwrap();
    let child_traceparent = std::fs::read_to_string(&child_file).unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();

    // OTEL_TASK_TRACEPARENT = the command span's own context (equal to the child's
    // TRACEPARENT), NOT the inherited task value and NOT the incoming parent.
    assert_eq!(task_traceparent, child_traceparent);
    assert_eq!(summary["trace"]["child_traceparent"], task_traceparent);
    assert_ne!(task_traceparent, inherited_task);
    assert_ne!(task_traceparent, parent);
    // It carries the command span's own span id (the reparent target) under the
    // shared trace id.
    assert_eq!(
        task_traceparent,
        format!(
            "00-{}-{}-{}",
            summary["trace"]["trace_id"].as_str().unwrap(),
            summary["trace"]["span_id"].as_str().unwrap(),
            "01",
        )
    );
}

// vitest side-channel adapter (decision 0017): otel-scrape injects
// `--reporter=json --outputFile.json=<file>`, reads structured counts from the
// file, and leaves the child's human stdout UNTOUCHED (no re-render). Modeled with
// a fake vitest that echoes the injected outputFile flag and writes a JSON report.
#[test]
fn vitest_adapter_reads_side_channel_and_leaves_stdout_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    // A stand-in for vitest: print human output to stdout, and honor the injected
    // `--outputFile.json=<path>` by writing a JSON report there (parsing it out of
    // argv the way vitest would consume the flag).
    let fake_vitest = dir.path().join("fake-vitest.sh");
    std::fs::write(
        &fake_vitest,
        r#"#!/bin/sh
echo "RUN  human test output"
for arg in "$@"; do
  case "$arg" in
    --outputFile.json=*) out="${arg#--outputFile.json=}" ;;
  esac
done
if [ -n "$out" ]; then
  printf '%s' '{"numTotalTests":5,"numFailedTests":2,"numPassedTests":3}' > "$out"
fi
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&fake_vitest).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
    }
    std::fs::set_permissions(&fake_vitest, perms).unwrap();

    let out = otel_scrape()
        .args(["--adapter", "vitest", "--summary-out"])
        .arg(&summary)
        .args(["--"])
        .arg(&fake_vitest)
        .output()
        .unwrap();

    assert!(out.status.success());
    // Side-channel: the child's own human output stays on stdout, untouched — no
    // re-render, no JSON dumped.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("RUN  human test output"),
        "vitest human stdout must pass through untouched, got: {stdout}"
    );
    assert!(!stdout.contains("numTotalTests"));

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "vitest");
    // Side-channel presentation: otel-scrape owns the records but not stdout.
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "inherited");
    // stdout is inherited (never captured), so no output descriptor.
    assert_eq!(summary["output"]["stdout"], serde_json::Value::Null);
    let records = summary["adapter"]["records"].as_array().unwrap();
    let total = records
        .iter()
        .find(|record| record["name"] == "vitest.tests")
        .expect("vitest.tests metric");
    assert_eq!(total["value"], 5);
    let failures = records
        .iter()
        .find(|record| record["name"] == "vitest.failures")
        .expect("vitest.failures metric");
    assert_eq!(failures["value"], 2);
}

// Conflict guard (decision 0017 clause 2): when the user already passes
// `--outputFile.json=<theirs>` and a human `--reporter`, otel-scrape reads THEIR
// file (never injecting its own path, never deleting it) and preserves their
// reporter (adding only `--reporter=json` alongside, never forcing
// `--reporter=default` on top).
#[test]
fn vitest_adapter_respects_user_output_file_and_reporter() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let user_output = dir.path().join("user-results.json");
    let argv_dump = dir.path().join("argv.txt");
    // A stand-in for vitest that records its full argv (so the test can assert what
    // otel-scrape injected) and writes its JSON report to the `--outputFile.json`
    // path it receives — which must be the USER's path, untouched by otel-scrape.
    let fake_vitest = dir.path().join("fake-vitest.sh");
    std::fs::write(
        &fake_vitest,
        format!(
            r#"#!/bin/sh
: > "{argv_dump}"
out=
for arg in "$@"; do
  printf '%s\n' "$arg" >> "{argv_dump}"
  case "$arg" in
    --outputFile.json=*) out="${{arg#--outputFile.json=}}" ;;
  esac
done
echo "RUN  human test output"
if [ -n "$out" ]; then
  printf '%s' '{{"numTotalTests":7,"numFailedTests":1}}' > "$out"
fi
"#,
            argv_dump = argv_dump.display(),
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&fake_vitest).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
    }
    std::fs::set_permissions(&fake_vitest, perms).unwrap();

    let out = otel_scrape()
        .args(["--adapter", "vitest", "--summary-out"])
        .arg(&summary)
        .args(["--"])
        .arg(&fake_vitest)
        .arg(format!("--outputFile.json={}", user_output.display()))
        .arg("--reporter=dot")
        .output()
        .unwrap();

    assert!(out.status.success());

    // otel-scrape read the USER's file: the counts come from it.
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary).unwrap()).unwrap();
    let records = summary["adapter"]["records"].as_array().unwrap();
    let total = records
        .iter()
        .find(|record| record["name"] == "vitest.tests")
        .expect("vitest.tests metric");
    assert_eq!(total["value"], 7);

    // Data-loss guard: the user's file must NOT be deleted.
    assert!(
        user_output.exists(),
        "otel-scrape must not delete a user-supplied --outputFile.json"
    );

    // otel-scrape must NOT inject its own --outputFile.json — only the user's is present.
    let argv = std::fs::read_to_string(&argv_dump).unwrap();
    let output_flags: Vec<&str> = argv
        .lines()
        .filter(|line| line.starts_with("--outputFile.json"))
        .collect();
    assert_eq!(
        output_flags,
        vec![format!("--outputFile.json={}", user_output.display()).as_str()],
        "otel-scrape must not inject its own --outputFile.json; argv:\n{argv}"
    );

    // The user's human reporter is preserved and a JSON reporter is added alongside;
    // --reporter=default is NOT forced on top of the user's choice.
    let reporters: Vec<&str> = argv
        .lines()
        .filter(|line| line.starts_with("--reporter"))
        .collect();
    assert!(
        reporters.contains(&"--reporter=dot"),
        "user reporter must be preserved; argv:\n{argv}"
    );
    assert!(
        reporters.contains(&"--reporter=json"),
        "a JSON reporter must be added for the side-channel; argv:\n{argv}"
    );
    assert!(
        !reporters.contains(&"--reporter=default"),
        "must not force --reporter=default over the user's reporter; argv:\n{argv}"
    );
}

// Warn-on-miss (decision 0017 clause 2): when the side-channel file is
// missing/empty (e.g. the tool crashed or wrote nothing), otel-scrape WARNS on
// stderr and OMITS the vitest metrics rather than emitting a misleading 0/0. The
// wrapped command's own output and exit are unaffected.
#[test]
fn vitest_adapter_warns_and_omits_metrics_on_missing_side_channel() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    // A stand-in for vitest that prints human output but never writes the injected
    // --outputFile.json, so the side-channel source is absent.
    let fake_vitest = dir.path().join("fake-vitest.sh");
    std::fs::write(
        &fake_vitest,
        r#"#!/bin/sh
echo "RUN  human test output"
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&fake_vitest).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
    }
    std::fs::set_permissions(&fake_vitest, perms).unwrap();

    let out = otel_scrape()
        .args(["--adapter", "vitest", "--summary-out"])
        .arg(&summary)
        .args(["--"])
        .arg(&fake_vitest)
        .output()
        .unwrap();

    assert!(out.status.success());
    // Child's own human output still passes through untouched.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("RUN  human test output"));

    // Non-silent degrade: a concise warning on stderr.
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("vitest side-channel unavailable"),
        "expected a side-channel warning on stderr, got: {stderr}"
    );

    // No misleading 0/0: the vitest.* records are omitted entirely.
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary).unwrap()).unwrap();
    let records = summary["adapter"]["records"].as_array().unwrap();
    assert!(
        !records
            .iter()
            .any(|record| record["name"] == "vitest.tests"),
        "vitest.tests must be omitted when the side-channel is unavailable"
    );
    assert!(
        !records
            .iter()
            .any(|record| record["name"] == "vitest.failures"),
        "vitest.failures must be omitted when the side-channel is unavailable"
    );
}

#[cfg(unix)]
fn compile_process_dag_fixture(dir: &Path) -> PathBuf {
    let source = dir.join("process_dag_fixture.rs");
    let binary = dir.join("process-dag-fixture");
    std::fs::write(
        &source,
        r##"
use std::io::Write;
use std::process::{Command, Stdio};

fn main() {
    if std::env::var("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD").is_ok() {
        std::process::exit(0);
    }

    if std::env::var("OTEL_SCRAPE_PROCESS_DAG_NESTED_PARENT").is_ok() {
        let child = Command::new(std::env::current_exe().unwrap())
            .env("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let grandchild_pid = child.id();
        let status = child.wait_with_output().unwrap().status;
        let record_path = std::env::var("OTEL_SCRAPE_GRANDCHILD_RECORD").unwrap();
        std::fs::write(
            record_path,
            format!(
                r#"{{"role":"grandchild","pid":{},"parentPid":{},"exitCode":{}}}"#,
                grandchild_pid,
                std::process::id(),
                status.code().unwrap_or(-1)
            ),
        )
        .unwrap();
        std::process::exit(0);
    }

    let expected_path = std::env::var("OTEL_SCRAPE_EXPECTED_DAG").unwrap();
    let grandchild_record_path = std::env::var("OTEL_SCRAPE_GRANDCHILD_RECORD").unwrap();
    let root_pid = std::process::id();
    let mut children = Vec::new();

    let immediate = Command::new(std::env::current_exe().unwrap())
        .env("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let immediate_pid = immediate.id();
    let immediate_status = immediate.wait_with_output().unwrap().status;
    children.push(format!(
        r#"{{"role":"immediate-exit","pid":{},"parentPid":{},"exitCode":{}}}"#,
        immediate_pid,
        root_pid,
        immediate_status.code().unwrap_or(-1)
    ));

    let nested = Command::new(std::env::current_exe().unwrap())
        .env("OTEL_SCRAPE_PROCESS_DAG_NESTED_PARENT", "1")
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let nested_pid = nested.id();
    let nested_status = nested.wait_with_output().unwrap().status;
    children.push(format!(
        r#"{{"role":"nested-parent","pid":{},"parentPid":{},"exitCode":{}}}"#,
        nested_pid,
        root_pid,
        nested_status.code().unwrap_or(-1)
    ));
    children.push(std::fs::read_to_string(grandchild_record_path).unwrap());

    let json = format!(
        r#"{{"rootPid":{},"children":[{}]}}"#,
        root_pid,
        children.join(",")
    );
    std::fs::write(expected_path, json).unwrap();
    std::io::stdout().write_all(b"fixture-done").unwrap();
}
"##,
    )
    .unwrap();
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    let status = Command::new(rustc)
        .arg("--edition=2021")
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .unwrap();
    assert!(status.success());
    binary
}

#[cfg(target_os = "linux")]
fn stable_hash(value: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_ref());
    format!("sha256:{}", hex(&hasher.finalize()))
}

#[cfg(target_os = "linux")]
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[test]
fn joins_parent_traceparent() {
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join("traceparent");
    let summary = dir.path().join("summary.json");
    let parent = "00-11111111111111111111111111111111-2222222222222222-01";

    let out = otel_scrape()
        .env("traceparent", parent)
        .env("ENV_FILE", &env_file)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "printf '%s' \"$traceparent\" > \"$ENV_FILE\"",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    let child_traceparent = std::fs::read_to_string(env_file).unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();

    assert_eq!(
        summary["trace"]["trace_id"],
        "11111111111111111111111111111111"
    );
    assert_eq!(summary["trace"]["parent_span_id"], "2222222222222222");
    assert_eq!(summary["trace"]["child_traceparent"], child_traceparent);
    assert_ne!(child_traceparent, parent);
}

#[test]
fn exports_command_span_to_otlp_http_json() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let parent = "00-11111111111111111111111111111111-2222222222222222-01";

    let out = otel_scrape()
        .env("traceparent", parent)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
    assert_eq!(request.content_type.as_deref(), Some("application/json"));
    assert!(request
        .headers
        .get("user-agent")
        .is_some_and(|value| value.starts_with("otel-scrape/")));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let resource_span = &body["resourceSpans"][0];
    assert_eq!(
        attr_value(
            resource_span["resource"]["attributes"].as_array().unwrap(),
            "service.name"
        ),
        Some("otel-scrape-test".to_owned())
    );
    let span = &resource_span["scopeSpans"][0]["spans"][0];
    // Span naming scheme (decision 0014): the command span is named by the
    // wrapped program's basename (`sh`), never a fixed instrumentation constant.
    // Ownership is carried by otel_scrape.span.origin=otel-scrape +
    // otel.scope.name=otel-scrape (decision 0016).
    assert_eq!(span["name"], "sh");
    assert_eq!(span["traceId"], "11111111111111111111111111111111");
    assert_eq!(span["parentSpanId"], "2222222222222222");
    assert_eq!(span["spanId"], summary["trace"]["span_id"]);
    assert_eq!(span["status"]["code"], 1);
    // Success path (decision 0016, M25.1): no error.type attribute and no
    // Status.message — Description is reserved for the Error status.
    assert_eq!(span["status"].get("message"), None);
    // scope.version ties the trace to a build (decision 0019); it always carries
    // otel-scrape's build machineVersion. service.version is ABSENT here: this run
    // supplies service.name via --service-name (naming the enclosing harness), so
    // the default service.version stamp is gated off — otel-scrape must not stamp
    // its own build onto a harness-named service (decision 0016 §6, FLAG-1).
    let scope = &resource_span["scopeSpans"][0]["scope"];
    assert_eq!(scope["name"], "otel-scrape");
    assert!(scope["version"].as_str().is_some_and(|v| !v.is_empty()));
    assert_eq!(
        attr_value(
            resource_span["resource"]["attributes"].as_array().unwrap(),
            "service.version"
        ),
        None
    );
    // High-resolution timing (decision 0016, M25.1): a fast command is not a
    // zero-width span. The pre-fix ms-quantization made even a real sub-ms command
    // collapse to a zero-width span; nanosecond-resolution timing keeps end > start.
    let start = span["startTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let end = span["endTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    assert!(end > start, "fast command span must not be zero-width");
    let attrs = span["attributes"].as_array().unwrap();
    // process.pid (decision 0016, M25.1): REQUIRED by attributes.cli.common,
    // emitted raw (never hashed), and a genuine positive pid.
    assert!(attr_value(attrs, "process.pid")
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|pid| pid > 0));
    // error.type is absent on the success path (conditionally required only on
    // non-zero exit).
    assert_eq!(attr_value(attrs, "error.type"), None);
    assert_eq!(
        attr_value(attrs, "otel.scope.name"),
        Some("otel-scrape".to_owned())
    );
    assert_eq!(
        attr_value(attrs, "otel_scrape.span.origin"),
        Some("otel-scrape".to_owned())
    );
    // OTel span.cli.internal convention (decision 0016): span name equals
    // process.executable.name (the wrapped program basename).
    assert_eq!(
        attr_value(attrs, "process.executable.name"),
        Some("sh".to_owned())
    );
    assert!(attr_value(attrs, "otel_scrape.command.argv_hash")
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(
        attr_value(attrs, "otel_scrape.command.argv_hash"),
        summary["command"]["argv_hash"]
            .as_str()
            .map(ToOwned::to_owned)
    );
    assert!(attr_value(attrs, "otel_scrape.command.cwd_hash")
        .unwrap()
        .starts_with("sha256:"));
    // The raw process.command_args / process.working_directory trust-gated
    // fields are M2, never M1.
    assert_eq!(attr_string_array(attrs, "process.command_args"), None);
    assert_eq!(attr_value(attrs, "process.working_directory"), None);
    assert_eq!(attr_value(attrs, "process.exit.code"), Some("0".to_owned()));
    // Deprecated pre-semconv keys (decision 0016) are never emitted on any span.
    assert_eq!(attr_value(attrs, "span.origin"), None);
    assert_eq!(attr_value(attrs, "command.program"), None);
    assert_eq!(attr_value(attrs, "command.argv_hash"), None);
    assert_eq!(attr_value(attrs, "command.cwd_hash"), None);
    assert_eq!(attr_value(attrs, "process.exit_code"), None);
    assert_eq!(
        attr_value(attrs, "otel_scrape.adapter.name"),
        Some("none".to_owned())
    );
    // Process merge (decision 0014): in the default degraded direct-child
    // backend the process observation is folded into the command span
    // (fidelity=merged) — no separate process span is emitted.
    let spans = resource_span["scopeSpans"][0]["spans"].as_array().unwrap();
    assert_eq!(spans.len(), 1);
    assert!(spans
        .iter()
        .all(|span| span["name"] != "otel_scrape.process"));
    assert_eq!(
        attr_value(attrs, "otel_scrape.process.observation.backend"),
        Some("direct-child".to_owned())
    );
    assert_eq!(
        attr_value(attrs, "otel_scrape.process.observation.fidelity"),
        Some("merged".to_owned())
    );
    assert_eq!(
        attr_value(attrs, "otel_scrape.process.observation.relation"),
        Some("direct-child".to_owned())
    );
}

// span.cli error modeling (decision 0016, M25.1): a non-zero exit sets span
// status Error, the LOW-cardinality error.type=_OTHER fallback, and a bounded
// non-sensitive Status.message. A signal kill and a clean non-zero exit are
// distinguished by the message but never blow error.type cardinality.
#[test]
fn exports_error_type_and_status_message_on_nonzero_exit() {
    let collector = TestCollector::start(200);
    let out = otel_scrape()
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "exit 7"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    assert_eq!(span["status"]["code"], 2);
    assert_eq!(span["status"]["message"], "process exited with code 7");
    let attrs = span["attributes"].as_array().unwrap();
    assert_eq!(attr_value(attrs, "error.type"), Some("_OTHER".to_owned()));
    assert_eq!(attr_value(attrs, "process.exit.code"), Some("7".to_owned()));
}

#[test]
fn exports_error_type_and_signal_status_message_on_signal_kill() {
    let collector = TestCollector::start(200);
    let out = otel_scrape()
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "kill -TERM $$"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(143));

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    assert_eq!(span["status"]["code"], 2);
    // Signal kills are distinguished from clean exits by the bounded message,
    // but error.type stays the LOW-cardinality _OTHER (no signal/code in it).
    assert_eq!(
        span["status"]["message"],
        "process terminated by signal SIGTERM"
    );
    let attrs = span["attributes"].as_array().unwrap();
    assert_eq!(attr_value(attrs, "error.type"), Some("_OTHER".to_owned()));
    // Signal terminations surface a synthetic 128+signal exit code (decision 0016,
    // M25.1): SIGTERM (15) => 143.
    assert_eq!(
        attr_value(attrs, "process.exit.code"),
        Some("143".to_owned())
    );
}

// ---------------------------------------------------------------------------
// Trust gate (decision 0015): per-named-sink assertion + byte-level non-leak.
//
// A sentinel secret + a fake local path live ONLY in the wrapped command's
// argv. We run with BOTH an OTLP capture and a `--summary-out` summary
// configured, then assert at the *byte level* which sinks may contain the
// sentinel. The untrusted case is the load-bearing regression guard: it must
// genuinely fail if anyone later makes raw argv/cwd the default.
// ---------------------------------------------------------------------------

const TRUST_SENTINEL: &str = "SENTINEL_SECRET_ABC";
const TRUST_FAKE_PATH: &str = "/tmp/fake/private/path";

/// Captured raw bytes of both trust-gateable sinks for one wrapped run.
struct SinkCapture {
    otlp_body: Vec<u8>,
    summary_json: String,
    summary: serde_json::Value,
    otlp_attrs: Vec<serde_json::Value>,
}

/// Runs a wrapped command whose argv carries `TRUST_SENTINEL` + `TRUST_FAKE_PATH`
/// (only ever as ignored positional params, so `command.program` stays `sh`),
/// with both an OTLP collector and a summary configured, applying `trusted_args`
/// (e.g. `["--trusted-sink", "otlp"]`) and `trusted_env` (e.g. the env alias).
fn run_trust_capture(trusted_args: &[&str], trusted_env: &[(&str, &str)]) -> SinkCapture {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let mut command = otel_scrape();
    command
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint]);
    for (key, value) in trusted_env {
        command.env(key, value);
    }
    command.args(trusted_args);
    // Sentinel + fake path ride in argv as ignored positional params ($0=_, then
    // extra args) of `sh -c true`, so the child runs clean and program == "sh".
    command.args([
        "--",
        "sh",
        "-c",
        "true",
        "_",
        &format!("--token={TRUST_SENTINEL}"),
        TRUST_FAKE_PATH,
    ]);

    let out = command.output().unwrap();
    assert!(out.status.success(), "wrapped command should succeed");

    let summary_json = std::fs::read_to_string(&summary_path).unwrap();
    let summary: serde_json::Value = serde_json::from_str(&summary_json).unwrap();
    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let otlp_attrs = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"]
        .as_array()
        .cloned()
        .unwrap();

    SinkCapture {
        otlp_body: request.body,
        summary_json,
        summary,
        otlp_attrs,
    }
}

#[test]
fn trust_gate_untrusted_leaks_to_no_sink() {
    let capture = run_trust_capture(&[], &[]);

    // Byte-level non-leak: sentinel + fake path absent from BOTH raw sinks.
    let otlp_bytes = String::from_utf8_lossy(&capture.otlp_body);
    assert!(
        !otlp_bytes.contains(TRUST_SENTINEL),
        "sentinel leaked into untrusted OTLP payload"
    );
    assert!(
        !otlp_bytes.contains(TRUST_FAKE_PATH),
        "fake path leaked into untrusted OTLP payload"
    );
    assert!(
        !capture.summary_json.contains(TRUST_SENTINEL),
        "sentinel leaked into untrusted summary"
    );
    assert!(
        !capture.summary_json.contains(TRUST_FAKE_PATH),
        "fake path leaked into untrusted summary"
    );

    // Only the hashed correlation keys are present, in both sinks.
    assert!(
        attr_value(&capture.otlp_attrs, "otel_scrape.command.argv_hash")
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(
        attr_value(&capture.otlp_attrs, "otel_scrape.command.cwd_hash")
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        attr_string_array(&capture.otlp_attrs, "process.command_args"),
        None
    );
    assert_eq!(
        attr_value(&capture.otlp_attrs, "process.working_directory"),
        None
    );
    assert!(capture.summary["command"]["argv_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(capture.summary["command"]["cwd_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(capture.summary["command"]["argv"].is_null());
    assert!(capture.summary["command"]["cwd"].is_null());
}

#[test]
fn trust_gate_otlp_reveals_otlp_only() {
    let capture = run_trust_capture(&["--trusted-sink", "otlp"], &[]);

    // The sentinel is PRESENT as a member of the OTLP process.command_args array
    // (this sink was asserted). Array membership, not substring-in-joined-string.
    let argv_raw = attr_string_array(&capture.otlp_attrs, "process.command_args").unwrap();
    assert!(
        argv_raw.iter().any(|arg| arg.contains(TRUST_SENTINEL)),
        "asserted OTLP sink must carry the raw sentinel argv as an array member"
    );
    // Old-key absence: the pre-semconv command.argv is never emitted, even trusted.
    assert_eq!(attr_value(&capture.otlp_attrs, "command.argv"), None);
    let cwd_raw = attr_value(&capture.otlp_attrs, "process.working_directory").unwrap();
    assert!(
        cwd_raw.starts_with('/'),
        "raw cwd should be an absolute path"
    );
    assert_eq!(attr_value(&capture.otlp_attrs, "command.cwd"), None);
    assert!(String::from_utf8_lossy(&capture.otlp_body).contains(TRUST_SENTINEL));

    // Wrong-sink guard: asserting otlp NEVER puts raw into the summary — the
    // summary stays hard-public-safe (hashed only), byte-absent sentinel.
    assert!(
        !capture.summary_json.contains(TRUST_SENTINEL),
        "OTLP assertion leaked the sentinel into the (public-safe) summary"
    );
    assert!(
        !capture.summary_json.contains(TRUST_FAKE_PATH),
        "OTLP assertion leaked the fake path into the summary"
    );
    assert!(capture.summary["command"]["argv"].is_null());
    assert!(capture.summary["command"]["cwd"].is_null());
    // Hashes remain present in the summary regardless.
    assert!(capture.summary["command"]["argv_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[test]
fn trust_gate_env_alias_is_pinned_to_otlp_only() {
    // OTEL_SCRAPE_TRUSTED_SINK is the ergonomic alias for --trusted-sink otlp; it
    // is pinned to the single OTLP target and must never unlock the summary.
    let capture = run_trust_capture(&[], &[("OTEL_SCRAPE_TRUSTED_SINK", "true")]);

    assert!(
        attr_string_array(&capture.otlp_attrs, "process.command_args")
            .unwrap()
            .iter()
            .any(|arg| arg.contains(TRUST_SENTINEL)),
        "env alias must unlock raw argv in the OTLP sink"
    );
    // Pinned-to-otlp: the summary stays byte-clean.
    assert!(
        !capture.summary_json.contains(TRUST_SENTINEL),
        "env alias leaked the sentinel into the summary — it must be pinned to OTLP only"
    );
    assert!(capture.summary["command"]["argv"].is_null());
    assert!(capture.summary["command"]["cwd"].is_null());
}

#[test]
fn trust_gate_summary_reveals_summary_only() {
    let capture = run_trust_capture(&["--trusted-sink", "summary"], &[]);

    // The summary was asserted: it carries raw argv/cwd (sentinel present).
    assert!(
        capture.summary_json.contains(TRUST_SENTINEL),
        "asserted summary sink must carry the raw sentinel"
    );
    let argv = capture.summary["command"]["argv"].as_array().unwrap();
    assert!(argv
        .iter()
        .any(|value| value.as_str().unwrap().contains(TRUST_SENTINEL)));
    assert!(capture.summary["command"]["cwd"]
        .as_str()
        .unwrap()
        .starts_with('/'));

    // Wrong-sink guard: a summary assertion never unlocks the OTLP sink.
    assert!(
        !String::from_utf8_lossy(&capture.otlp_body).contains(TRUST_SENTINEL),
        "summary assertion leaked the sentinel into the OTLP payload"
    );
    assert_eq!(
        attr_string_array(&capture.otlp_attrs, "process.command_args"),
        None
    );
    assert_eq!(
        attr_value(&capture.otlp_attrs, "process.working_directory"),
        None
    );
}

#[test]
fn trust_gate_rejects_unknown_sink() {
    let out = otel_scrape()
        .args(["--trusted-sink", "bogus", "--", "true"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(64));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--trusted-sink"));
}

#[test]
fn otlp_env_follows_trace_specific_precedence_and_resource_attributes() {
    let generic_collector = TestCollector::start(200);
    let traces_collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &generic_collector.endpoint)
        .env(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            &traces_collector.endpoint,
        )
        .env("OTEL_EXPORTER_OTLP_HEADERS", "x-generic=ignored")
        .env("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-trace=kept")
        .env(
            "OTEL_RESOURCE_ATTRIBUTES",
            "service.name=from-resource,team=tooling,service.version=9.9.9",
        )
        .env("OTEL_SERVICE_NAME", "from-service-env")
        .env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    let request = traces_collector.request();
    assert_eq!(request.path, "/");
    assert_eq!(request.headers.get("x-trace"), Some(&"kept".to_owned()));
    assert_eq!(
        request.headers.get("x-generic"),
        None,
        "captured headers: {:?}",
        request.headers
    );
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let resource_attrs = body["resourceSpans"][0]["resource"]["attributes"]
        .as_array()
        .unwrap();
    assert_eq!(
        attr_value(resource_attrs, "service.name"),
        Some("from-service-env".to_owned())
    );
    assert_eq!(
        attr_value(resource_attrs, "team"),
        Some("tooling".to_owned())
    );
    assert_eq!(
        attr_value(resource_attrs, "telemetry.sdk.name"),
        Some("otel-scrape".to_owned())
    );
    // service.version from OTEL_RESOURCE_ATTRIBUTES wins over the crate-version
    // default (decision 0016, M25.1): service.* names the enclosing harness.
    assert_eq!(
        attr_value(resource_attrs, "service.version"),
        Some("9.9.9".to_owned())
    );
    drop(generic_collector);
}

// service.version default is gated on service.name (decision 0016, M25.1,
// Option A): when a user/harness supplies service.name (naming the enclosing
// harness), otel-scrape must NOT stamp its own crate version onto it. The scope
// version still carries the otel-scrape build unambiguously.
#[test]
fn service_version_default_is_gated_when_service_name_is_supplied() {
    let collector = TestCollector::start(200);
    let out = otel_scrape()
        .env("OTEL_SERVICE_NAME", "ci-build")
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();
    assert!(out.status.success());

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let resource_span = &body["resourceSpans"][0];
    let resource_attrs = resource_span["resource"]["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(resource_attrs, "service.name"),
        Some("ci-build".to_owned())
    );
    // No default service.version stamped onto the harness-named service.
    assert_eq!(attr_value(resource_attrs, "service.version"), None);
    // scope.version still carries otel-scrape's build unambiguously.
    let scope = &resource_span["scopeSpans"][0]["scope"];
    assert_eq!(scope["name"], "otel-scrape");
    assert!(scope["version"].as_str().is_some_and(|v| !v.is_empty()));
}

// Companion to the env-path gate above (decision 0016 §6, decision 0019, FLAG-1):
// the `--service-name` FLAG must gate the default service.version exactly like
// OTEL_SERVICE_NAME does. A `--service-name` run with no OTEL_SERVICE_NAME names
// the enclosing harness, so otel-scrape must NOT stamp its own build version onto
// it (the pre-fix bug stamped service.version before the flag loop, gated only on
// env, letting otel-scrape's build masquerade as the harness's version). The
// scope version still carries otel-scrape's build unambiguously.
#[test]
fn service_version_default_is_gated_when_service_name_flag_supplied() {
    let collector = TestCollector::start(200);
    let out = otel_scrape()
        .args(["--service-name", "my-harness"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();
    assert!(out.status.success());

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let resource_span = &body["resourceSpans"][0];
    let resource_attrs = resource_span["resource"]["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(resource_attrs, "service.name"),
        Some("my-harness".to_owned())
    );
    // No default service.version stamped onto the flag-named harness service.
    assert_eq!(attr_value(resource_attrs, "service.version"), None);
    // scope.version still carries otel-scrape's build unambiguously.
    let scope = &resource_span["scopeSpans"][0]["scope"];
    assert_eq!(scope["name"], "otel-scrape");
    assert!(scope["version"].as_str().is_some_and(|v| !v.is_empty()));
}

// Build-id trace correlation (H5, decision 0019): scope.version is a
// build-correlated machineVersion (not the bare crate `0.0.0`, which
// discriminated no build), and schemaUrl pins the semconv version on both the
// scope and the resource. This run uses the DEFAULT-service path (no service.name
// from env or flag), so the resource service.version is stamped and equals
// scope.version — both the build machineVersion. The exact precedence/fallback
// logic is covered by the pure unit tests in the library crate; this proves the
// end-to-end wiring.
#[test]
fn scope_version_is_build_correlated_and_schema_url_present() {
    let collector = TestCollector::start(200);
    // A distinctive runtime NixStamp. On a stampless build (plain cargo / devenv)
    // it is honored verbatim; on a nix build the baked flake rev wins by
    // contract. Either way scope.version must be a machineVersion, not `0.0.0`.
    let out = otel_scrape()
        .env(
            "CLI_BUILD_STAMP",
            r#"{"type":"nix","version":"0.0.0","rev":"beefca7","commitTs":7,"dirty":false}"#,
        )
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();
    assert!(out.status.success());

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let resource_span = &body["resourceSpans"][0];
    let scope = &resource_span["scopeSpans"][0]["scope"];
    let scope_version = scope["version"].as_str().unwrap();
    assert!(
        scope_version.starts_with("0.0.0+") && scope_version != "0.0.0",
        "scope.version must be a build-correlated machineVersion, got {scope_version}"
    );
    // Without a baked NixStamp, the injected runtime stamp is reflected exactly.
    if !otel_scrape::compiled_with_nix_stamp() {
        assert_eq!(scope_version, "0.0.0+beefca7");
    }
    // Default-service path: service.name is otel-scrape's own default and the
    // resource service.version is stamped, equal to scope.version — the trace ties
    // to a build on the service resource too (decision 0016 §6, decision 0019).
    let resource_attrs = resource_span["resource"]["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(resource_attrs, "service.name"),
        Some("otel-scrape".to_owned())
    );
    assert_eq!(
        attr_value(resource_attrs, "service.version"),
        Some(scope_version.to_owned())
    );
    // schemaUrl pins the semconv version on both the ScopeSpans (the
    // instrumentation scope's schema, a sibling of `scope`) and the ResourceSpans.
    assert_eq!(
        resource_span["scopeSpans"][0]["schemaUrl"],
        "https://opentelemetry.io/schemas/1.37.0"
    );
    assert_eq!(
        resource_span["schemaUrl"],
        "https://opentelemetry.io/schemas/1.37.0"
    );
}

// The stampless fallback (H5, decision 0019): with no honored stamp anywhere,
// scope.version is the honest `0.0.0+dev` marker — never bare `0.0.0`. Skipped
// on a nix build, whose baked NixStamp leaves no unstamped path to exercise.
#[test]
fn scope_version_falls_back_to_dev_when_unstamped() {
    if otel_scrape::compiled_with_nix_stamp() {
        return;
    }
    let collector = TestCollector::start(200);
    let out = otel_scrape()
        .env_remove("CLI_BUILD_STAMP")
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();
    assert!(out.status.success());

    let body: serde_json::Value = serde_json::from_slice(&collector.request().body).unwrap();
    let scope = &body["resourceSpans"][0]["scopeSpans"][0]["scope"];
    assert_eq!(scope["version"], "0.0.0+dev");
}

#[test]
fn generic_otlp_endpoint_is_base_url_for_trace_path() {
    let collector = TestCollector::start(200);
    let endpoint = format!("{}/collector", collector.endpoint);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(collector.request().path, "/collector/v1/traces");
}

#[test]
fn otel_sdk_disabled_suppresses_export_without_affecting_child() {
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &collector.endpoint)
        .env("OTEL_SDK_DISABLED", "true")
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
}

#[test]
fn otel_traces_exporter_none_suppresses_export_without_affecting_child() {
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &collector.endpoint)
        .env("OTEL_TRACES_EXPORTER", "none")
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
}

#[test]
fn unrecognized_otel_traces_exporter_value_is_ignored() {
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &collector.endpoint)
        .env("OTEL_TRACES_EXPORTER", "bogus")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    assert_eq!(collector.request().path, "/v1/traces");
    assert!(String::from_utf8_lossy(&out.stderr).contains("ignoring unrecognized"));
}

#[test]
fn known_but_unsupported_otel_traces_exporter_suppresses_json_exporter() {
    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
        .env("OTEL_TRACES_EXPORTER", "zipkin")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("is not supported by this first-party exporter"));
    assert!(!stderr.contains("failed to export OTLP trace"));
}

#[test]
fn otel_traces_exporter_none_keeps_precedence_over_unknown_values() {
    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
        .env("OTEL_TRACES_EXPORTER", "none,bogus")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("ignoring unrecognized"));
    assert!(!stderr.contains("failed to export OTLP trace"));
}

#[test]
fn otel_env_trace_endpoint_is_used_as_is_and_trace_headers_override_generic() {
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9/base")
        .env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", &collector.endpoint)
        .env(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "x-shared=generic,x-generic=yes",
        )
        .env(
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
            "x-shared=trace,x-trace=yes",
        )
        .env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
        .env("OTEL_EXPORTER_OTLP_TIMEOUT", "1000")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    let request = collector.request();
    assert_eq!(request.path, "/");
    assert_eq!(request.headers.get("x-shared"), Some(&"trace".to_owned()));
    assert_eq!(
        request.headers.get("x-generic"),
        None,
        "captured headers: {:?}",
        request.headers
    );
    assert_eq!(request.headers.get("x-trace"), Some(&"yes".to_owned()));
}

#[test]
fn unsupported_otlp_protocol_disables_first_party_json_exporter() {
    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
        .env("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("trace export is disabled"));
    assert!(!stderr.contains("failed to export OTLP trace"));
}

#[test]
fn unsupported_otlp_compression_disables_first_party_json_exporter() {
    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
        .env("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("trace export is disabled"));
    assert!(!stderr.contains("failed to export OTLP trace"));
}

#[test]
fn http_protobuf_protocol_still_exports_via_json_path() {
    // The OTLP/HTTP receiver routes by request Content-Type, not by the client's
    // protocol preference, and accepts JSON on /v1/traces. So a requested
    // `http/protobuf` protocol must NOT disable export — otel-scrape falls back to
    // the working JSON path and still POSTs the trace.
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &collector.endpoint)
        .env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("disabled"), "stderr: {stderr}");
    assert!(
        !stderr.contains("failed to export OTLP trace"),
        "stderr: {stderr}"
    );

    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
    assert_eq!(request.content_type.as_deref(), Some("application/json"));
}

#[test]
fn otlp_export_failure_preserves_child_exit_code() {
    let collector = TestCollector::start(500);
    let endpoint = format!("{}/tokenized-secret-path", collector.endpoint);

    let out = otel_scrape()
        .args(["--otlp-endpoint", &endpoint])
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace"));
    assert!(!stderr.contains("tokenized-secret-path"));
    let request = collector.request();
    assert_eq!(request.path, "/tokenized-secret-path");
}

#[test]
fn otlp_export_timeout_preserves_child_exit_code_when_collector_stalls() {
    let collector = TestCollector::start_stalling();

    let out = otel_scrape()
        .env("OTEL_EXPORTER_OTLP_TIMEOUT", "500")
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace"));
    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
}

#[test]
fn otlp_export_warning_does_not_leak_invalid_env_endpoint() {
    let out = otel_scrape()
        .env(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "http://user:SECRET@127.0.0.1:9/private-token?token=SECRET",
        )
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace to <invalid http endpoint>"));
    assert!(!stderr.contains("SECRET"));
    assert!(!stderr.contains("private-token"));
    assert!(!stderr.contains("user:"));
}

#[test]
fn exports_oxlint_adapter_event_without_raw_filename_or_payload() {
    let collector = TestCollector::start(200);
    let oxlint_json = r#"{ "privatePayload": "PRIVATE_OUTPUT_PAYLOAD", "diagnostics": [{"message": "Unexpected token","severity": "error","filename": "/private/source.ts"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    // Structured-in / pretty-out (decision 0017): the terminal shows the rendered
    // summary, not the raw JSON. The OTLP payload stays byte-clean (asserted below).
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("oxlint: 1 diagnostic(s) over 1 file(s)"));
    assert!(!stdout.contains("PRIVATE_OUTPUT_PAYLOAD"));

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!body_json.contains("/private/source.ts"));
    assert!(!body_json.contains("PRIVATE_OUTPUT_PAYLOAD"));
    assert!(!body_json.contains("Unexpected token"));
    assert!(body_json.contains("otel_scrape.adapter.event"));
    assert!(!body_json.contains("oxlint.diagnostics"));
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.adapter.event")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(attr_value(attrs, "severity"), Some("error".to_owned()));
    assert!(attr_value(attrs, "source.filename_hash")
        .unwrap()
        .starts_with("sha256:"));
}

#[test]
fn exports_profile_link_event_without_duplicate_cas_writes_or_path_bytes() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let profile = dir.path().join("private-profile.cpuprofile");
    std::fs::write(&profile, b"PRIVATE_PROFILE_BYTES").unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--cas-root"])
        .arg(&cas_root)
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!body_json.contains(profile.to_string_lossy().as_ref()));
    assert!(!body_json.contains("PRIVATE_PROFILE_BYTES"));
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.profile.link")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(attrs, "profile.type"),
        Some("cpuprofile".to_owned())
    );
    assert!(attr_value(attrs, "profile.digest")
        .unwrap()
        .starts_with("sha256:"));
    assert!(attr_value(attrs, "profile.uri")
        .unwrap()
        .starts_with("cas:sha256/"));
    assert_eq!(attr_value(attrs, "byteLength"), Some("21".to_owned()));
    assert_eq!(
        attr_value(attrs, "mediaType"),
        Some("application/octet-stream".to_owned())
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(
        attr_value(attrs, "profile.digest"),
        summary["artifacts"]["profiles"][0]["digest"]
            .as_str()
            .map(ToOwned::to_owned)
    );
    let objects = std::fs::read_dir(cas_root.join("sha256"))
        .unwrap()
        .flat_map(|prefix| std::fs::read_dir(prefix.unwrap().path()).unwrap())
        .count();
    assert_eq!(objects, 2);
}

#[test]
fn node_cpuprofile_adapter_writes_resolvable_profile_without_leaking_private_inputs() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let private_arg = "PRIVATE_ARG_MARKER";
    let private_source = "PRIVATE_SOURCE_MARKER";

    let out = otel_scrape()
        .args(["--adapter", "node-cpuprofile"])
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--cas-root"])
        .arg(&cas_root)
        .args([
            "--",
            "node",
            "-e",
            "/* PRIVATE_SOURCE_MARKER */ for (let i = 0; i < 100000; i++) Math.sqrt(i); console.log(process.argv[1])",
            private_arg,
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "PRIVATE_ARG_MARKER\n");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "node-cpuprofile");
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        1
    );
    let profile_link = &summary["artifacts"]["profiles"][0];
    assert_eq!(profile_link["type"], "cpuprofile");
    assert!(profile_link["byteLength"].as_u64().unwrap() > 0);
    assert_eq!(profile_link["mediaType"], "application/octet-stream");
    assert!(profile_link["digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(profile_link["uri"]
        .as_str()
        .unwrap()
        .starts_with("cas:sha256/"));
    assert_eq!(summary["artifacts"]["manifest"]["entryCount"], 1);

    let object_path = profile_link["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("cas:")
        .unwrap();
    let profile_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cas_root.join(object_path)).unwrap()).unwrap();
    assert!(!profile_json["nodes"].as_array().unwrap().is_empty());
    assert!(profile_json["samples"].as_array().is_some());

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let summary_json = serde_json::to_string(&summary).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!summary_json.contains(private_arg));
    assert!(!summary_json.contains(private_source));
    assert!(!body_json.contains(private_arg));
    assert!(!body_json.contains(private_source));

    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.profile.link")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(attrs, "profile.type"),
        Some("cpuprofile".to_owned())
    );
    assert_eq!(
        attr_value(attrs, "profile.digest"),
        profile_link["digest"].as_str().map(ToOwned::to_owned)
    );
    assert_eq!(
        attr_value(attrs, "profile.uri"),
        profile_link["uri"].as_str().map(ToOwned::to_owned)
    );
}

#[test]
fn node_cpuprofile_adapter_degrades_for_non_node_child_without_raw_command() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let private_arg = "PRIVATE_NON_NODE_ARG";

    let out = otel_scrape()
        .args(["--adapter", "node-cpuprofile"])
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .args(["--", "sh", "-c", "printf '%s' \"$1\"", "sh", private_arg])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), private_arg);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "node-cpuprofile");
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    let error = &summary["artifacts"]["errors"][0];
    assert_eq!(error["profileType"], "cpuprofile");
    assert_eq!(error["pathHash"], serde_json::Value::Null);
    assert_eq!(
        error["message"],
        "node-cpuprofile adapter degraded: child command is not node"
    );
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(private_arg));
}

fn attr_value(attrs: &[serde_json::Value], key: &str) -> Option<String> {
    attrs
        .iter()
        .find(|attr| attr["key"] == key)?
        .get("value")
        .and_then(|value| {
            value
                .get("stringValue")
                .or_else(|| value.get("intValue"))
                .or_else(|| value.get("doubleValue"))
                .or_else(|| value.get("boolValue"))
        })
        .and_then(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| Some(value.to_string()))
        })
}

/// Reads an OTLP `arrayValue` attribute as a Vec of its string members.
/// `attr_value` only understands scalar values, so `process.command_args`
/// (an OTel string[]) needs this array-aware accessor.
fn attr_string_array(attrs: &[serde_json::Value], key: &str) -> Option<Vec<String>> {
    let values = attrs
        .iter()
        .find(|attr| attr["key"] == key)?
        .get("value")?
        .get("arrayValue")?
        .get("values")?
        .as_array()?;
    Some(
        values
            .iter()
            .filter_map(|value| value.get("stringValue")?.as_str().map(ToOwned::to_owned))
            .collect(),
    )
}

fn assert_event_time_within_span(event: &serde_json::Value, span: &serde_json::Value) {
    let event_time = event["timeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let span_start = span["startTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let span_end = span["endTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    assert!(
        event_time >= span_start,
        "event timestamp {event_time} should be >= span start {span_start}"
    );
    assert!(
        event_time <= span_end,
        "event timestamp {event_time} should be <= span end {span_end}"
    );
}

#[cfg(unix)]
const HELPER_PARENT_PID_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000001";
#[cfg(unix)]
const HELPER_ROOT_PID_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000002";
#[cfg(unix)]
const HELPER_CHILD_PID_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000003";
#[cfg(unix)]
const HELPER_OTHER_ROOT_PID_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000004";
#[cfg(unix)]
const HELPER_ROOT_ARGV_HASH: &str =
    "sha256:1000000000000000000000000000000000000000000000000000000000000000";
#[cfg(unix)]
const HELPER_CHILD_ARGV_HASH: &str =
    "sha256:2000000000000000000000000000000000000000000000000000000000000000";
#[cfg(unix)]
const HELPER_OTHER_ROOT_ARGV_HASH: &str =
    "sha256:3000000000000000000000000000000000000000000000000000000000000000";

#[cfg(unix)]
#[derive(Clone, Copy)]
enum HelperFixtureMode {
    Complete,
    Loss,
    SequenceGap,
    RunIdMismatch,
    VersionMismatch,
    HelperDisconnect,
    MissingExit,
    ReversedTimestamps,
    MultipleRoots,
    ExitBeforeExec,
    ChildForkAfterParentExit,
}

#[cfg(unix)]
fn spawn_fake_helper_stream(
    socket: &Path,
    run_id_file: &Path,
    mode: HelperFixtureMode,
) -> thread::JoinHandle<()> {
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket).unwrap();
    let run_id_file = run_id_file.to_owned();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let run_id = std::fs::read_to_string(run_id_file).unwrap();
        if matches!(mode, HelperFixtureMode::HelperDisconnect) {
            return;
        }
        let body = helper_stream_fixture_body(run_id.trim(), mode);
        stream.write_all(body.as_bytes()).unwrap();
    })
}

#[cfg(unix)]
fn helper_stream_fixture_body(run_id: &str, mode: HelperFixtureMode) -> String {
    let base = 1_700_000_000_000_000_000_u128;
    let event_run_id = if matches!(mode, HelperFixtureMode::RunIdMismatch) {
        "wrong-run-id"
    } else {
        run_id
    };
    let protocol_version = if matches!(mode, HelperFixtureMode::VersionMismatch) {
        2
    } else {
        1
    };
    let mut events = vec![
        serde_json::json!({
            "_tag": "RunStarted",
            "protocolVersion": protocol_version,
            "runId": event_run_id,
            "eventSeq": 0,
            "timeUnixNano": base,
        }),
        serde_json::json!({
            "_tag": "Fork",
            "protocolVersion": protocol_version,
            "runId": event_run_id,
            "eventSeq": if matches!(mode, HelperFixtureMode::SequenceGap) { 2 } else { 1 },
            "timeUnixNano": base + 1_000_000,
            "pidHash": HELPER_ROOT_PID_HASH,
            "parentPidHash": HELPER_PARENT_PID_HASH,
        }),
    ];
    match mode {
        HelperFixtureMode::Complete
        | HelperFixtureMode::SequenceGap
        | HelperFixtureMode::RunIdMismatch
        | HelperFixtureMode::VersionMismatch
        | HelperFixtureMode::MissingExit
        | HelperFixtureMode::ReversedTimestamps
        | HelperFixtureMode::MultipleRoots => {
            events.extend([
                serde_json::json!({
                    "_tag": "Exec",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 2,
                    "timeUnixNano": base + 2_000_000,
                    "pidHash": HELPER_ROOT_PID_HASH,
                    "argvHash": HELPER_ROOT_ARGV_HASH,
                }),
                serde_json::json!({
                    "_tag": "Fork",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 3,
                    "timeUnixNano": base + 3_000_000,
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "parentPidHash": HELPER_ROOT_PID_HASH,
                }),
                serde_json::json!({
                    "_tag": "Exec",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 4,
                    "timeUnixNano": base + 4_000_000,
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "argvHash": HELPER_CHILD_ARGV_HASH,
                }),
                serde_json::json!({
                    "_tag": "Exit",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 5,
                    "timeUnixNano": if matches!(mode, HelperFixtureMode::ReversedTimestamps) {
                        base + 3_500_000
                    } else {
                        base + 5_000_000
                    },
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "exitCode": 0,
                }),
            ]);
            if matches!(mode, HelperFixtureMode::MultipleRoots) {
                events.extend([
                    serde_json::json!({
                        "_tag": "Fork",
                        "protocolVersion": protocol_version,
                        "runId": event_run_id,
                        "eventSeq": 6,
                        "timeUnixNano": base + 6_000_000,
                        "pidHash": HELPER_OTHER_ROOT_PID_HASH,
                        "parentPidHash": HELPER_PARENT_PID_HASH,
                    }),
                    serde_json::json!({
                        "_tag": "Exec",
                        "protocolVersion": protocol_version,
                        "runId": event_run_id,
                        "eventSeq": 7,
                        "timeUnixNano": base + 7_000_000,
                        "pidHash": HELPER_OTHER_ROOT_PID_HASH,
                        "argvHash": HELPER_OTHER_ROOT_ARGV_HASH,
                    }),
                    serde_json::json!({
                        "_tag": "Exit",
                        "protocolVersion": protocol_version,
                        "runId": event_run_id,
                        "eventSeq": 8,
                        "timeUnixNano": base + 8_000_000,
                        "pidHash": HELPER_OTHER_ROOT_PID_HASH,
                        "exitCode": 0,
                    }),
                ]);
            }
            if !matches!(mode, HelperFixtureMode::MissingExit) {
                events.extend([
                    serde_json::json!({
                        "_tag": "Exit",
                        "protocolVersion": protocol_version,
                        "runId": event_run_id,
                        "eventSeq": if matches!(mode, HelperFixtureMode::MultipleRoots) {
                            9
                        } else {
                            6
                        },
                        "timeUnixNano": if matches!(mode, HelperFixtureMode::MultipleRoots) {
                            base + 9_000_000
                        } else {
                            base + 6_000_000
                        },
                        "pidHash": HELPER_ROOT_PID_HASH,
                        "exitCode": 0,
                    }),
                    serde_json::json!({
                        "_tag": "RunFinished",
                        "protocolVersion": protocol_version,
                        "runId": event_run_id,
                        "eventSeq": if matches!(mode, HelperFixtureMode::MultipleRoots) {
                            10
                        } else {
                            7
                        },
                        "timeUnixNano": if matches!(mode, HelperFixtureMode::MultipleRoots) {
                            base + 10_000_000
                        } else {
                            base + 7_000_000
                        },
                    }),
                ]);
            } else {
                events.push(serde_json::json!({
                    "_tag": "RunFinished",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 6,
                    "timeUnixNano": base + 6_000_000,
                }));
            }
        }
        HelperFixtureMode::ExitBeforeExec => {
            events.extend([
                serde_json::json!({
                    "_tag": "Exit",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 2,
                    "timeUnixNano": base + 2_000_000,
                    "pidHash": HELPER_ROOT_PID_HASH,
                    "exitCode": 0,
                }),
                serde_json::json!({
                    "_tag": "Exec",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 3,
                    "timeUnixNano": base + 3_000_000,
                    "pidHash": HELPER_ROOT_PID_HASH,
                    "argvHash": HELPER_ROOT_ARGV_HASH,
                }),
                serde_json::json!({
                    "_tag": "RunFinished",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 4,
                    "timeUnixNano": base + 4_000_000,
                }),
            ]);
        }
        HelperFixtureMode::ChildForkAfterParentExit => {
            events.extend([
                serde_json::json!({
                    "_tag": "Exec",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 2,
                    "timeUnixNano": base + 2_000_000,
                    "pidHash": HELPER_ROOT_PID_HASH,
                    "argvHash": HELPER_ROOT_ARGV_HASH,
                }),
                serde_json::json!({
                    "_tag": "Exit",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 3,
                    "timeUnixNano": base + 3_000_000,
                    "pidHash": HELPER_ROOT_PID_HASH,
                    "exitCode": 0,
                }),
                serde_json::json!({
                    "_tag": "Fork",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 4,
                    "timeUnixNano": base + 4_000_000,
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "parentPidHash": HELPER_ROOT_PID_HASH,
                }),
                serde_json::json!({
                    "_tag": "Exec",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 5,
                    "timeUnixNano": base + 5_000_000,
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "argvHash": HELPER_CHILD_ARGV_HASH,
                }),
                serde_json::json!({
                    "_tag": "Exit",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 6,
                    "timeUnixNano": base + 6_000_000,
                    "pidHash": HELPER_CHILD_PID_HASH,
                    "exitCode": 0,
                }),
                serde_json::json!({
                    "_tag": "RunFinished",
                    "protocolVersion": protocol_version,
                    "runId": event_run_id,
                    "eventSeq": 7,
                    "timeUnixNano": base + 7_000_000,
                }),
            ]);
        }
        HelperFixtureMode::Loss => {
            events.extend([
                serde_json::json!({
                    "_tag": "Loss",
                    "protocolVersion": 1,
                    "runId": run_id,
                    "eventSeq": 2,
                    "timeUnixNano": base + 2_000_000,
                    "reason": "event-loss",
                }),
                serde_json::json!({
                    "_tag": "RunFinished",
                    "protocolVersion": 1,
                    "runId": run_id,
                    "eventSeq": 3,
                    "timeUnixNano": base + 3_000_000,
                }),
            ]);
        }
        HelperFixtureMode::HelperDisconnect => {}
    }
    events
        .into_iter()
        .map(|event| serde_json::to_string(&event).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

struct TestCollector {
    endpoint: String,
    request_rx: mpsc::Receiver<CapturedRequest>,
}

struct CapturedRequest {
    path: String,
    content_type: Option<String>,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl TestCollector {
    fn start(status: u16) -> Self {
        Self::start_with_response(Some(status))
    }

    fn start_stalling() -> Self {
        Self::start_with_response(None)
    }

    fn start_with_response(status: Option<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read]);
                if captured_request(&bytes).is_some() {
                    break;
                }
            }
            let request = captured_request(&bytes).unwrap();
            request_tx.send(request).unwrap();
            if let Some(status) = status {
                let response = format!(
                    "HTTP/1.1 {status} test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
                stream.write_all(response.as_bytes()).unwrap();
            } else {
                thread::sleep(std::time::Duration::from_secs(2));
            }
        });
        Self {
            endpoint,
            request_rx,
        }
    }

    fn request(self) -> CapturedRequest {
        self.request_rx.recv().unwrap()
    }
}

fn captured_request(bytes: &[u8]) -> Option<CapturedRequest> {
    let headers_end = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&bytes[..headers_end]).ok()?;
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .and_then(|value| value.parse::<usize>().ok())?;
    let body_start = headers_end + 4;
    if bytes.len() < body_start + content_length {
        return None;
    }
    let mut lines = headers.lines();
    let request_line = lines.next()?;
    let path = request_line.split_whitespace().nth(1)?.to_owned();
    let content_type = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Type: "))
        .map(ToOwned::to_owned);
    let captured_headers = headers
        .lines()
        .skip(1)
        .filter_map(|line| {
            line.split_once(": ")
                .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
        })
        .collect();
    Some(CapturedRequest {
        path,
        content_type,
        headers: captured_headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

// ---------------------------------------------------------------------------
// Root trace surfacing (decision 0020, R31). When otel-scrape mints the trace
// root, it prints the trace id (+ a backend-agnostic URL when the trace is
// provably exported and a `{traceId}` template is set) to stderr, so agents and
// humans can reach the trace without querying the backend. Terminal-only: the
// template/URL never enters the summary or OTLP sinks. Tests capture piped
// (non-TTY) stderr, so the plain encoding is asserted.
// ---------------------------------------------------------------------------

const TRACE_URL_TEMPLATE: &str = "https://grafana.example/explore?traceql={traceId}";

/// The `otel-scrape: trace:<id>` surfacing line from captured stderr, if any.
fn trace_surface_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find(|line| line.starts_with("otel-scrape: trace:"))
        .map(ToOwned::to_owned)
}

#[test]
fn root_surfaces_resolvable_url_on_successful_export() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    let trace_id = summary["trace"]["trace_id"].as_str().unwrap();

    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = trace_surface_line(&stderr).expect("expected a surfaced trace line");
    // Plain (non-TTY) encoding: `trace:<id>  <url>`, id substituted into template.
    let expected_url = TRACE_URL_TEMPLATE.replace("{traceId}", trace_id);
    assert_eq!(
        line,
        format!("otel-scrape: trace:{trace_id}  {expected_url}")
    );
    // No OSC 8 escape when stderr is not a TTY.
    assert!(!stderr.contains('\u{1b}'));
}

#[test]
fn root_surfaces_bare_id_when_export_fails() {
    // A 500 makes the first-party exporter return an error: the trace is not
    // provably in the backend, so only the bare id is surfaced (no dead URL).
    let collector = TestCollector::start(500);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    let trace_id = summary["trace"]["trace_id"].as_str().unwrap();

    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = trace_surface_line(&stderr).expect("expected a bare trace line");
    assert_eq!(line, format!("otel-scrape: trace:{trace_id}"));
    assert!(!line.contains("https://"), "no URL when export failed");
}

#[test]
fn root_surfaces_bare_id_summary_only() {
    // Summary configured, no OTLP: the trace exists locally but not in a backend,
    // so only the bare id is surfaced even with a template set.
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    let trace_id = summary["trace"]["trace_id"].as_str().unwrap();

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        trace_surface_line(&stderr),
        Some(format!("otel-scrape: trace:{trace_id}"))
    );
    assert!(!stderr.contains("https://"));
}

#[test]
fn joined_run_surfaces_nothing() {
    // A joined run (inbound traceparent) does not own the root, so it stays silent
    // even with export + template configured.
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .env(
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01",
        )
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        trace_surface_line(&stderr),
        None,
        "joined run must stay silent"
    );
}

#[test]
fn pure_passthrough_surfaces_nothing() {
    // No summary and no OTLP endpoint: R04 pure passthrough must stay
    // byte-identical to direct execution, even with a template configured.
    let out = otel_scrape()
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "printf out; printf err 1>&2"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "out");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "err");
}

#[test]
fn trace_link_off_suppresses_surfacing() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--trace-link", "off"])
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        trace_surface_line(&stderr),
        None,
        "--trace-link off silences surfacing"
    );
}

#[test]
fn trace_link_accepts_boolean_spelling() {
    // `false` is accepted as an alias for `off` (repo OTel boolean convention),
    // via both the flag and the env var.
    let dir = tempfile::tempdir().unwrap();

    let flag_summary = dir.path().join("flag.json");
    let flag = otel_scrape()
        .args(["--trace-link", "false"])
        .args(["--summary-out"])
        .arg(&flag_summary)
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(flag.status.success());
    assert_eq!(
        trace_surface_line(&String::from_utf8_lossy(&flag.stderr)),
        None
    );

    let env_summary = dir.path().join("env.json");
    let env = otel_scrape()
        .env("OTEL_SCRAPE_TRACE_LINK", "false")
        .args(["--summary-out"])
        .arg(&env_summary)
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(env.status.success());
    assert_eq!(
        trace_surface_line(&String::from_utf8_lossy(&env.stderr)),
        None
    );
}

#[test]
fn env_template_and_off_switch_are_honored() {
    // The env forms mirror the flags: OTEL_SCRAPE_TRACE_URL_TEMPLATE supplies the
    // template and OTEL_SCRAPE_TRACE_LINK=off silences surfacing.
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .env("OTEL_SCRAPE_TRACE_URL_TEMPLATE", TRACE_URL_TEMPLATE)
        .env("OTEL_SCRAPE_TRACE_LINK", "off")
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();
    assert_eq!(
        trace_surface_line(&String::from_utf8_lossy(&out.stderr)),
        None
    );
}

#[test]
fn template_without_placeholder_degrades_to_bare_id() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args([
            "--trace-url-template",
            "https://grafana.example/no-placeholder",
        ])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    let trace_id = summary["trace"]["trace_id"].as_str().unwrap();

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("without a {traceId} placeholder"));
    assert_eq!(
        trace_surface_line(&stderr),
        Some(format!("otel-scrape: trace:{trace_id}"))
    );
}

#[test]
fn trace_url_template_never_enters_sinks() {
    // Terminal is not a sink (decision 0017): a sentinel host in the template must
    // be byte-absent from both the OTLP payload and the summary file, even though
    // the rendered URL is printed to stderr.
    const SENTINEL_HOST: &str = "SURFACE_SENTINEL_HOST.example";
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary_path = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args([
            "--trace-url-template",
            &format!("https://{SENTINEL_HOST}/{{traceId}}"),
        ])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let request = collector.request();

    let otlp_bytes = String::from_utf8_lossy(&request.body);
    let summary_json = std::fs::read_to_string(&summary_path).unwrap();
    assert!(
        !otlp_bytes.contains(SENTINEL_HOST),
        "template leaked into OTLP sink"
    );
    assert!(
        !summary_json.contains(SENTINEL_HOST),
        "template leaked into summary sink"
    );
    // But it IS on the operator's terminal (stderr), which is not a sink.
    assert!(String::from_utf8_lossy(&out.stderr).contains(SENTINEL_HOST));
}

#[test]
fn export_disabled_by_env_with_endpoint_surfaces_nothing() {
    // Endpoint configured but export disabled by env (OTEL_SDK_DISABLED) and NO
    // summary: no export is attempted and no local sink exists, so R04 keeps the
    // run silent even though `otlp_export_enabled`-style config is present.
    let out = otel_scrape()
        .env("OTEL_SDK_DISABLED", "true")
        .args(["--otlp-endpoint", "http://127.0.0.1:1"])
        .args(["--trace-url-template", TRACE_URL_TEMPLATE])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        trace_surface_line(&String::from_utf8_lossy(&out.stderr)),
        None
    );
}

#[test]
fn exported_without_template_surfaces_bare_id() {
    // Export succeeds (2xx) but no template is configured: the URL tier needs a
    // template, so the run degrades to the bare-id tier.
    let collector = TestCollector::start(200);

    let out = otel_scrape()
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "true"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _ = collector.request();

    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = trace_surface_line(&stderr).expect("expected a bare trace line");
    assert!(!line.contains("://"), "no URL without a template");
    assert!(
        line.starts_with("otel-scrape: trace:"),
        "bare trace line shape"
    );
}
