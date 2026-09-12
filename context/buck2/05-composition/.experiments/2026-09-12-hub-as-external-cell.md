# effect-utils as a Git External Cell in the Hub Role

Date: 2026-09-12 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-09-01, isolation
dir `hub-extcell`; effect-utils at `49dfa42eed70b6b9a117f58e210d8fab20ae8cf6`
(main) fetched from the local bare store repo. Scratch root retained at
`/tmp/megarepo-vs-buck2/hub-extcell/` on dev3 (16 log files); disposable.

## Question

Can the real effect-utils repository be consumed as a git external cell in
the platform/toolchain hub role — the way the prelude is consumed — from a
consumer root that owns the composition wiring? Which hub references block it?

## Method

Scratch root with the 05-composition root shape (`workspace = .`, bundled
prelude, `effect_utils = repos/effect-utils` as a git external cell, detector
spec and execution platform on `effect_utils//buck2/platforms:*`, a
`toolchains` alias cell). Queries: `buck2 audit cell`, `buck2 targets
effect_utils//buck2/platforms:`, `buck2 targets effect_utils//buck2/toolchains:`.
Then `buck2 expand-external-cell effect_utils` plus a `cp -a` of an existing
per-host `.buck2/capabilities` projection (read from a canonical composed
workspace, unchanged) into the expanded cell, and `buck2 build
effect_utils//packages/@overeng/tui-core:typecheck`. Remote cache disabled
(no credentials in the scratch shell; upload off).

## Result

- Pure external cell: `audit cell` maps the virtual path without fetching
  (0.22 s). The first cold fetch attempt exceeded 120 s and was interrupted;
  a retry after daemon restart took 12.48 s (not a clean cold number). The
  checkout tree is 37 MB. `buck2/platforms` lists all 15 targets purely
  externally.
- Pure external cell, toolchains: fails at parse —
  `File not found: effect_utils//.buck2/capabilities/defs.bzl`, from
  `buck2/toolchains/BUCK:1`. The complete set of generated-path references in
  the hub: `buck2/toolchains/BUCK:1` (`load("//.buck2/capabilities:defs.bzl",
  "CAPABILITIES", "GENERATION")`), `buck2/toolchains/configured.bzl:5` (same
  load) and `configured.bzl:59` (label
  `//.buck2/capabilities/generations/{generation}/{platform}/{tool_id}`).
  `buck2/platforms` and the root `buck2/*.bzl` files contain none.
- Expanded cell + copied projection (424 KB): all 14 toolchain targets load;
  `tui-core:typecheck` builds — 139 actions, all local, 4.63 s, 0 cache hits
  (cache not configured). `buck-out` 246 MB before cleanup.

## Conclusion

Half of the hub is external-cell consumable today (platforms); the other half
(toolchains) is not, because the per-host capability projection is a
cell-relative load inside the member. Making the hub a pure external cell
requires a root-owned `capabilities` cell and rewriting the three references
above to cross-cell labels — a change that is the right ownership boundary
regardless (host-specific projected state belongs to the root, not inside a
member mount). The expanded-cell result proves only "hub rules and toolchains
work when the projection is present"; it does not prove pure external-cell
consumption, and `expand-external-cell` forfeits immutability.

## VRS Impact

Names the concrete hub refactor (root-owned `capabilities//` cell) as the
second condition of decision 0030's revisit clause and as an open question in
05-composition. The mr projection contract in the 05-composition spec
("exactly one producer, installed per mount") stands until that refactor is
decided.
