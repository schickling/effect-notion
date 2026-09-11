# Lightweight, repository-agnostic devenv observability.
#
# This module deliberately keeps hermetic capture, verification, and backend
# composition in effect-utils while leaving domain assertions in the owning
# repository. Native devenv owns orchestration tracing; the Effect task bridge
# temporarily preserves status-versus-exec phase detail until devenv can export
# Debug task activities without coupling them to global CLI verbosity:
# https://github.com/cachix/devenv/issues/3037
{
  project,
  backend ? "ambient",
  profile ? {
    name = "setup";
    task = "setup:strict";
    mode = "before";
    smokeTask = "setup:gate";
    smokeMode = "single";
    bridgeTask = "setup:gate";
    prerequisiteTasks = [ ];
  },
  wireInto ? [ ],
}:
{
  pkgs,
  lib,
  ...
}:
let
  validBackends = [
    "ambient"
    "auto"
    "local"
    "system"
  ];
  _backend =
    if builtins.elem backend validBackends then
      backend
    else
      throw "effect-utils observability: backend must be one of ${builtins.concatStringsSep ", " validBackends}";

  # Temporary compatibility producer for task-phase detail. Keep otelite and
  # the profile/verify surface after this producer can be retired.
  otelSpan = import ./otel/otel-span.nix { inherit pkgs; };
  otelite = (import ../buck2-native-products { inherit pkgs; }).products.otelite;

  capture =
    if profile == null then
      null
    else
      pkgs.writeShellApplication {
        name = "devenv-otel-capture-${profile.name}";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.jq
        ];
        text = ''
          target_task="$1"
          task_mode="$2"
          capture_dir="$3"
          bridge_task="$4"

          mkdir -p "$capture_dir"
          summary_file="$capture_dir/summary.json"
          spans_file="$capture_dir/spans.ndjson"

          # Native devenv uses OTLP/gRPC while the temporary task-phase
          # producer uses OTLP/HTTP. Otelite owns the isolated capture.
          # shellcheck disable=SC2016
          env \
            -u DEVENV_TRACE_TO \
            -u OTEL_TASK_TRACEPARENT \
            -u TRACEPARENT \
            -u OTEL_SHELL_ENTRY_NS \
            ${otelite}/bin/otelite run \
              --out "$capture_dir/capture" \
              --protocol grpc \
              -- \
              bash -ceu '
                export OTEL_EXPORTER_OTLP_ENDPOINT="$OTELITE_HTTP_ENDPOINT"
                export DEVENV_TUI=false
                exec 3>&2
                export OTEL_TASK_STDERR_FD=3
                devenv --verbose tasks run "$1" \
                  --mode "$2" \
                  --no-tui \
                  --refresh-task-cache \
                  --trace-to "otlp-grpc:''${OTELITE_GRPC_ENDPOINT}" \
                  2>"$3/devenv-verbose.log" || {
                    status=$?
                    cat "$3/devenv-verbose.log" >&2
                    exit "$status"
                  }
              ' bash "$target_task" "$task_mode" "$capture_dir" \
              | tee "$summary_file"

          ${otelite}/bin/otelite inspect "$capture_dir/capture" \
            --signal traces > "$spans_file"

          jq -e '
            .schema == "otelite.summary/v1"
            and .child.exit_code == 0
            and .counts.rejected == 0
            and .counts.spans > 0
          ' "$summary_file" >/dev/null

          jq -s -e --arg task "$target_task" '
            ([.[] | select(
              .service == "devenv"
              and .name == "devenv"
              and .parent_span_id == null
            )][0].trace_id) as $root_trace
            | $root_trace != null
            and any(.[];
              .service == "devenv"
              and .name == $task
              and .trace_id == $root_trace
              and .attrs["devenv.activity.kind"] == "task"
            )
          ' "$spans_file" >/dev/null

          jq -s -e \
            --arg bridge "$bridge_task" \
            --arg project ${lib.escapeShellArg project} '
            ([.[] | select(
                .service == "effect-utils-devenv"
                and .name == "devenv.task.exec"
                and .attrs["task.name"] == $bridge
                and .attrs["devenv.project.name"] == $project
              )][0]) as $effect
            | $effect != null
              and any(.[];
                .service == "devenv"
                and .name == $bridge
                and .attrs["devenv.activity.kind"] == "task"
                and .span_id == $effect.parent_span_id
                and .trace_id == $effect.trace_id
              )
              and any(.[];
                .service == "devenv"
                and .name == "execute command"
                and .parent_span_id == $effect.parent_span_id
                and .trace_id == $effect.trace_id
              )
          ' "$spans_file" >/dev/null

          ${otelite}/bin/otelite inspect "$capture_dir/capture" \
            --signal traces --summary --pretty >&2
          printf 'Trace capture: %s\n' "$capture_dir" >&2
        '';
      };

  profileTaskName = if profile == null then null else "otel:profile:${profile.name}";
  verifyTaskName = if profile == null then null else "otel:verify:${profile.name}";
  profilePrerequisiteTasks = if profile == null then [ ] else profile.prerequisiteTasks or [ ];
  profileTasks =
    if profile == null then
      { }
    else
      {
        "${profileTaskName}" = {
          description = "Capture ${profile.task} with native devenv and effect-utils spans";
          after = profilePrerequisiteTasks;
          exec = ''
            capture_dir="''${DEVENV_OTEL_CAPTURE_DIR:-$DEVENV_ROOT/tmp/devenv-traces/${profile.name}-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
            exec ${capture}/bin/devenv-otel-capture-${profile.name} \
              ${lib.escapeShellArg profile.task} \
              ${lib.escapeShellArg profile.mode} \
              "$capture_dir" \
              ${lib.escapeShellArg profile.bridgeTask}
          '';
        };

        "${verifyTaskName}" = {
          description = "Verify native devenv and effect-utils ${profile.name} spans form one trace";
          after = profilePrerequisiteTasks;
          exec = ''
            test_dir="$(mktemp -d)"
            trap 'rm -rf "$test_dir"' EXIT
            ${capture}/bin/devenv-otel-capture-${profile.name} \
              ${lib.escapeShellArg profile.smokeTask} \
              ${lib.escapeShellArg profile.smokeMode} \
              "$test_dir/trace" \
              ${lib.escapeShellArg profile.bridgeTask}
          '';
        };
      };
  wiredTasks = lib.genAttrs wireInto (_: {
    after = [ verifyTaskName ];
  });
in
{
  assertions = [
    {
      assertion = project != "";
      message = "effect-utils observability: project must not be empty";
    }
    {
      assertion = profile != null || wireInto == [ ];
      message = "effect-utils observability: wireInto requires a profile";
    }
  ];

  imports = lib.optional (_backend != "ambient") (
    import ./otel.nix {
      mode = _backend;
    }
  );

  env = {
    OTEL_DEVENV_PROJECT = project;
    # Devenv task execution may reconstruct PATH independently of the capture
    # process, so task wrappers resolve the module-owned bridge explicitly.
    OTEL_SPAN_BIN = "${otelSpan}/bin/otel-span";
  };
  packages = [
    otelSpan
    otelite
  ];
  tasks = profileTasks // wiredTasks;
}
