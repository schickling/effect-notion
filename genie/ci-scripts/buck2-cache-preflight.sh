#!/usr/bin/env bash
# Fail-closed reachability gate for the opt-in shared-Buck-cache lane
# (03-materialization DQ1, REUSE-R04).
#
# This script NEVER falls back to a local build. An automatic fallback would turn a
# cache outage into a green run and destroy the only signal the lane exists to produce,
# so an unreachable or unconfigured cache fails the job and prints the documented
# one-line recovery instead.
#
# The endpoint is repository configuration (`vars.BUCK2_CACHE_ENDPOINT`); no host,
# port, or tailnet name is committed here.
set -euo pipefail

endpoint="${BUCK2_CACHE_ENDPOINT:-}"
instance="${BUCK2_CACHE_INSTANCE_NAME:-}"
recovery='export BUCK2_NO_REMOTE_CACHE=1 in the affected environment (the documented one-line pure-local toggle, REUSE-R04); this lane never applies it for you'

fail() {
  echo "::error::$1 Recovery: $recovery" >&2
  exit 1
}

if [ "${BUCK2_NO_REMOTE_CACHE:-}" = "1" ]; then
  echo "::notice::BUCK2_NO_REMOTE_CACHE=1 is set; this dispatch is the deliberate pure-local outage escape hatch"
  exit 0
fi

if [ -z "$endpoint" ]; then
  fail 'vars.BUCK2_CACHE_ENDPOINT is not configured for this repository, so the shared-cache lane has no endpoint to prove.'
fi
if [ -z "$instance" ]; then
  fail 'BUCK2_CACHE_INSTANCE_NAME is empty, so the lane cannot name its candidate cache instance.'
fi

authority="${endpoint#*://}"
authority="${authority%%/*}"
case "$authority" in
  *:*) ;;
  *) fail "BUCK2_CACHE_ENDPOINT must be <scheme>://<host>:<port>, got a value without a port." ;;
esac
host="${authority%:*}"
port="${authority##*:}"
case "$port" in
  ''|*[!0-9]*) fail "BUCK2_CACHE_ENDPOINT must end in a numeric port, got '$port'." ;;
esac
if [ -z "$host" ]; then
  fail 'BUCK2_CACHE_ENDPOINT must name a host.'
fi

echo "::notice::probing shared Buck cache $endpoint for candidate instance $instance"
if ! timeout 15 bash -c 'exec 3<>/dev/tcp/"$1"/"$2"' _ "$host" "$port" 2>/dev/null; then
  fail "Shared Buck cache $endpoint is unreachable from this runner (tailnet route or service down)."
fi
echo "::notice::shared Buck cache $endpoint is reachable"
