// Force TTY mode for consistent output in tests (e.g. colored diffs in snapshots).
// Opt-out by setting VITEST_NO_TTY=1.
if (process.env.VITEST_NO_TTY !== '1') {
  process.stdout.isTTY = true
}
