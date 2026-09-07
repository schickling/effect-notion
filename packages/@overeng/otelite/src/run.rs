//! The `run` verb: stand up the receiver, spawn a child with `OTEL_*` env
//! pointed at it, drain on child exit, and emit the `otelite.summary/v1` line.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::receiver::RunningReceiver;
use crate::sink::{Sink, SinkError};

/// Options for `run`, parsed from the CLI.
pub struct RunOpts {
    /// Capture out-dir; `None` → an auto-unique dir under `$TMPDIR`.
    pub out: Option<PathBuf>,
    /// Overrides the child's `OTEL_SERVICE_NAME`.
    pub service: Option<String>,
    /// Fixed HTTP / gRPC ports (deterministic/debug runs); `None` → ephemeral.
    pub http_port: Option<u16>,
    pub grpc_port: Option<u16>,
    /// The OTLP protocol injected into the child (`http/protobuf` default,
    /// `http/json`, or `grpc` — the last points it at the gRPC endpoint).
    pub protocol: String,
    /// After the child exits, keep capturing until no export arrives for this
    /// many ms (bounded; for fire-and-forget emitters). `None` → in-flight drain
    /// only (0ms tax).
    pub drain_idle_ms: Option<u64>,
    /// Pretty-print the summary instead of one compact line.
    pub pretty: bool,
    /// The child command + args (everything after `--`).
    pub argv: Vec<String>,
}

/// sysexits.h codes for `run`'s own failures (child code preserved otherwise).
const EX_OSERR: u8 = 71; // child spawn failure
const EX_CANTCREAT: u8 = 73; // out-dir create/write
const EX_UNAVAILABLE: u8 = 74; // receiver bind / shared-out collision
const EX_TEMPFAIL: u8 = 75; // --drain-idle never reached quiescence

/// An auto-unique capture dir under `$TMPDIR` (decisions/0010): pid + a
/// high-resolution timestamp, so parallel agents never collide without
/// coordination. The O_EXCL sink files are the final collision guard.
fn auto_out_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("otelite-{}-{nanos}", std::process::id()))
}

pub async fn run(opts: RunOpts) -> u8 {
    let out_dir = opts.out.clone().unwrap_or_else(auto_out_dir);

    let sink = match Sink::create(&out_dir).await {
        Ok(s) => Arc::new(s),
        Err(SinkError::AlreadyExists(p)) => {
            eprintln!("otelite: {}", SinkError::AlreadyExists(p));
            return EX_UNAVAILABLE;
        }
        Err(SinkError::Io(e)) => {
            eprintln!("otelite: cannot create out-dir {}: {e}", out_dir.display());
            return EX_CANTCREAT;
        }
    };

    let rx = match RunningReceiver::start_on(sink.clone(), opts.http_port, opts.grpc_port).await {
        Ok(rx) => rx,
        Err(e) => {
            eprintln!("otelite: cannot bind receiver: {e}");
            return EX_UNAVAILABLE;
        }
    };

    let start = Instant::now();
    let exit_code = match spawn_and_wait(&rx, &opts).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("otelite: cannot spawn child {:?}: {e}", opts.argv);
            rx.shutdown().await;
            return EX_OSERR;
        }
    };

    // Optional bounded idle-drain for fire-and-forget emitters (decisions/0006).
    // If it never quiesces within the bound, the run exits 75 (below).
    let drain_timed_out = match opts.drain_idle_ms {
        Some(idle_ms) => !idle_drain(&rx, idle_ms).await,
        None => false,
    };

    // Capture endpoints + paths before `shutdown` consumes the receiver.
    let http_ep = rx.http_endpoint.clone();
    let grpc_ep = rx.grpc_endpoint.clone();
    let paths = rx.sink().paths();
    let counts = rx.shutdown().await;
    if counts.rejected > 0 {
        eprintln!(
            "otelite: {} export(s) rejected at decode (non-default OTLP dialect or malformed)",
            counts.rejected
        );
    }

    let summary = serde_json::json!({
        "schema": "otelite.summary/v1",
        "out": out_dir,
        "endpoints": { "http": http_ep, "grpc": grpc_ep },
        "files": { "traces": paths.traces, "metrics": paths.metrics, "logs": paths.logs },
        "counts": { "spans": counts.spans, "metrics": counts.metrics, "logs": counts.logs, "rejected": counts.rejected },
        "child": { "argv": opts.argv, "exit_code": exit_code },
        "duration_ms": start.elapsed().as_millis(),
    });
    // stdout = machine JSON only.
    let line = if opts.pretty {
        serde_json::to_string_pretty(&summary).unwrap()
    } else {
        serde_json::to_string(&summary).unwrap()
    };
    println!("{line}");

    // A --drain-idle that never quiesced is a loud failure (exit 75), overriding
    // the child's code; the summary is still emitted so the capture is usable.
    if drain_timed_out {
        eprintln!("otelite: --drain-idle never reached quiescence within the bound");
        return EX_TEMPFAIL;
    }
    exit_code
}

/// Options for `capture` (receiver-only; no child).
pub struct CaptureOpts {
    pub out: Option<PathBuf>,
    pub http_port: Option<u16>,
    pub grpc_port: Option<u16>,
    pub pretty: bool,
}

/// `capture`: stand up the receiver, emit an `otelite.endpoints/v1` event line
/// the instant both listeners bind, and serve until SIGINT/SIGTERM or stdin EOF
/// — then drain and emit the same `otelite.summary/v1` (with `child: null`) as
/// the final stdout line. stdout is a tagged event stream (dispatch by `schema`)
/// so an in-process parent learns the ephemeral endpoint with no scraping. For
/// harnesses that own the SUT lifecycle themselves.
pub async fn capture(opts: CaptureOpts) -> u8 {
    let out_dir = opts.out.clone().unwrap_or_else(auto_out_dir);
    let sink = match Sink::create(&out_dir).await {
        Ok(s) => Arc::new(s),
        Err(SinkError::AlreadyExists(p)) => {
            eprintln!("otelite: {}", SinkError::AlreadyExists(p));
            return EX_UNAVAILABLE;
        }
        Err(SinkError::Io(e)) => {
            eprintln!("otelite: cannot create out-dir {}: {e}", out_dir.display());
            return EX_CANTCREAT;
        }
    };
    let rx = match RunningReceiver::start_on(sink.clone(), opts.http_port, opts.grpc_port).await {
        Ok(rx) => rx,
        Err(e) => {
            eprintln!("otelite: cannot bind receiver: {e}");
            return EX_UNAVAILABLE;
        }
    };

    // The instant both listeners are bound, emit ONE compact NDJSON event line to
    // stdout. stdout is a tagged event stream: `otelite.endpoints/v1` now,
    // `otelite.summary/v1` at the end. Consumers dispatch by `schema`, so an
    // in-process parent learns the ephemeral endpoint with no string scraping.
    let endpoints = serde_json::json!({
        "schema": "otelite.endpoints/v1",
        "http": rx.http_endpoint,
        "grpc": rx.grpc_endpoint,
        "out": out_dir,
    });
    println!("{}", serde_json::to_string(&endpoints).unwrap());

    // Endpoints to stderr too so a human / external emitter can read them.
    eprintln!("otelite: capturing to {}", out_dir.display());
    eprintln!("otelite: OTEL_EXPORTER_OTLP_ENDPOINT={}", rx.http_endpoint);
    eprintln!("otelite: OTLP gRPC endpoint {}", rx.grpc_endpoint);
    eprintln!("otelite: serving until SIGINT/SIGTERM or stdin EOF…");

    let start = Instant::now();
    wait_for_stop().await;

    let http_ep = rx.http_endpoint.clone();
    let grpc_ep = rx.grpc_endpoint.clone();
    let paths = rx.sink().paths();
    let counts = rx.shutdown().await;
    if counts.rejected > 0 {
        eprintln!(
            "otelite: {} export(s) rejected at decode (non-default OTLP dialect or malformed)",
            counts.rejected
        );
    }
    let summary = serde_json::json!({
        "schema": "otelite.summary/v1",
        "out": out_dir,
        "endpoints": { "http": http_ep, "grpc": grpc_ep },
        "files": { "traces": paths.traces, "metrics": paths.metrics, "logs": paths.logs },
        "counts": { "spans": counts.spans, "metrics": counts.metrics, "logs": counts.logs, "rejected": counts.rejected },
        "child": serde_json::Value::Null,
        "duration_ms": start.elapsed().as_millis(),
    });
    let line = if opts.pretty {
        serde_json::to_string_pretty(&summary).unwrap()
    } else {
        serde_json::to_string(&summary).unwrap()
    };
    println!("{line}");
    0
}

/// Wait for the harness's stop request: SIGINT, SIGTERM, or — when stdin is a
/// pipe (not a TTY) — EOF on stdin. EOF-stop lets an in-process parent stop the
/// receiver by simply closing the child's stdin (no signal/PID plumbing); a TTY
/// stdin is left to the signal path so an interactive run isn't stopped by the
/// terminal reporting EOF.
async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        // The stdin-EOF future must be *cancellable* on a signal without leaving
        // a parked OS thread: tokio's blocking `io::stdin()` read would keep the
        // runtime from shutting down (it blocks `Runtime::drop`). `wait_stdin_eof`
        // registers fd 0 as a non-blocking `AsyncFd`, so its future drops cleanly
        // when another select arm wins.
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                    _ = wait_stdin_eof() => {}
                }
            }
            Err(_) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = wait_stdin_eof() => {}
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Resolve when stdin reaches EOF (a non-TTY stdin closing), or never for a TTY.
/// Uses a non-blocking `AsyncFd` over fd 0 so the future is cancel-safe: when a
/// signal arm of the outer `select!` wins, this future is dropped without any
/// parked blocking thread keeping the tokio runtime alive.
#[cfg(unix)]
async fn wait_stdin_eof() {
    use std::os::unix::io::RawFd;
    use std::os::unix::io::{AsRawFd, BorrowedFd};

    let stdin = std::io::stdin();
    if std::io::IsTerminal::is_terminal(&stdin) {
        std::future::pending::<()>().await;
        return;
    }
    let fd: RawFd = stdin.as_raw_fd();

    // Put fd 0 into non-blocking mode so `read` can return WouldBlock instead of
    // parking. (We restore nothing: the process is about to stop on EOF anyway.)
    // SAFETY: fcntl on a valid borrowed fd; we only set O_NONBLOCK.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            let _ = libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }

    // SAFETY: fd 0 is owned by the process for its lifetime; we only borrow it.
    let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
    let async_fd = match tokio::io::unix::AsyncFd::new(borrowed) {
        Ok(a) => a,
        // If fd 0 can't be registered (e.g. a regular file), fall back to never
        // resolving — the signal path still stops the receiver.
        Err(_) => {
            std::future::pending::<()>().await;
            return;
        }
    };

    let mut buf = [0u8; 256];
    loop {
        let mut guard = match async_fd.readable().await {
            Ok(g) => g,
            Err(_) => return, // treat a registration error as EOF/stop
        };
        // SAFETY: reading into a stack buffer from a valid fd.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n == 0 {
            return; // EOF → stop
        } else if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::WouldBlock {
                guard.clear_ready();
                continue;
            }
            return; // any other read error → stop
        } else {
            // Discard data and keep waiting for EOF.
            guard.clear_ready();
        }
    }
}

/// Spawn the child with the owned/respected `OTEL_*` env and wait for it,
/// swallowing SIGINT in otelite so the child handles it and we still drain.
/// Returns the child's exit code (signal deaths map to 128+signo via the OS).
async fn spawn_and_wait(rx: &RunningReceiver, opts: &RunOpts) -> std::io::Result<u8> {
    let mut cmd = tokio::process::Command::new(&opts.argv[0]);
    cmd.args(&opts.argv[1..]);

    // Owned: always overwrite so telemetry points at our receiver. `--protocol
    // grpc` points the child at the gRPC endpoint; otherwise the HTTP endpoint
    // (json or protobuf encoding both land on the HTTP port).
    let endpoint = if opts.protocol == "grpc" {
        &rx.grpc_endpoint
    } else {
        &rx.http_endpoint
    };
    cmd.env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    cmd.env("OTEL_EXPORTER_OTLP_PROTOCOL", &opts.protocol);
    // A parent per-signal endpoint/protocol override would silently win over our
    // base endpoint and misroute telemetry away from the receiver — clear them.
    for signal in ["TRACES", "METRICS", "LOGS"] {
        cmd.env_remove(format!("OTEL_EXPORTER_OTLP_{signal}_ENDPOINT"));
        cmd.env_remove(format!("OTEL_EXPORTER_OTLP_{signal}_PROTOCOL"));
    }
    // Convenience (non-standard) so gRPC-configured children and tests can find
    // both endpoints without extra wiring.
    cmd.env("OTELITE_HTTP_ENDPOINT", &rx.http_endpoint);
    cmd.env("OTELITE_GRPC_ENDPOINT", &rx.grpc_endpoint);
    // Respected: OTEL_SERVICE_NAME passes through unless --service overrides it;
    // all other parent OTEL_* are inherited untouched (no env_clear).
    if let Some(svc) = &opts.service {
        cmd.env("OTEL_SERVICE_NAME", svc);
    }

    #[cfg(unix)]
    let mut interrupts = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    // Register before spawning. A fast child can emit readiness before the wait
    // loop starts; installing the handler in that loop leaves a default-action
    // window where the shared process-group SIGINT also kills otelite.
    // Child stdout → our stderr (keep our stdout clean for the summary JSON);
    // child stderr inherits our stderr; stdin inherits.
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());

    let mut child = cmd.spawn()?;
    let stdout_forward = child.stdout.take().map(|out| {
        tokio::spawn(async move {
            let mut reader = out;
            let mut err = tokio::io::stderr();
            let _ = tokio::io::copy(&mut reader, &mut err).await;
        })
    });

    #[cfg(unix)]
    let status = loop {
        tokio::select! {
            s = child.wait() => break s?,
            // Terminal Ctrl-C reaches the child too (shared process group), so we
            // swallow it here and keep waiting to drain. Limitation: a SIGTERM
            // sent directly to otelite's PID (not the group) is not caught — the
            // child is then orphaned. A forwarding SIGTERM handler is future work.
            _ = interrupts.recv() => continue,
        }
    };
    #[cfg(not(unix))]
    let status = loop {
        tokio::select! {
            s = child.wait() => break s?,
            _ = tokio::signal::ctrl_c() => continue,
        }
    };

    // Await the forwarder so any stdout still buffered in the pipe after the
    // child exits is fully copied to our stderr before we return — otherwise
    // dropping the runtime could truncate output the spec promises to preserve.
    if let Some(handle) = stdout_forward {
        let _ = handle.await;
    }
    Ok(child_exit_code(status))
}

/// Faithful child exit code: the process code, or `128 + signo` for a
/// signal-killed child (so a segfault/OOM-kill isn't reported as SIGINT).
fn child_exit_code(status: std::process::ExitStatus) -> u8 {
    if let Some(code) = status.code() {
        return code as u8;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128u8.wrapping_add(sig as u8);
        }
    }
    EX_OSERR
}

/// Keep the receiver open until no new export arrives for `idle_ms`, bounded by
/// an overall cap so a never-flushing child can never hang otelite. Returns
/// `true` if it reached quiescence, `false` if it hit the cap (→ exit 75).
async fn idle_drain(rx: &RunningReceiver, idle_ms: u64) -> bool {
    let idle = Duration::from_millis(idle_ms);
    // Overall bound: at most 50 idle windows (never unbounded — decisions/0006).
    let max_windows = 50u32;
    let mut last = rx.sink().requests_received();
    for _ in 0..max_windows {
        tokio::time::sleep(idle).await;
        let now = rx.sink().requests_received();
        if now == last {
            return true; // quiescent for a full window
        }
        last = now;
    }
    false
}
