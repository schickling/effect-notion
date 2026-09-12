# Git External Cells: Two-Member Fixture

Date: 2026-09-12 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-09-01
(`buck2 2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`), isolation dir
`extcells-proto`, `file_watcher = notify`. Fixture retained at
`/tmp/megarepo-vs-buck2/extcells-fixture/` (origins, consumers, tracer,
71 log files) on dev3; disposable.

## Question

Empirically: do git external cells build and cross-load; where is the content
stored; does the virtual `[cells]` path or the pinned commit enter action
identity; is the checkout shared across project roots; does it build offline;
is there a safe live local override; and what does Buck2 actually run to
fetch?

## Method

Two local bare origins (`member_a.git`, `member_b.git`), each with a
`genrule`; `member_b//:out` is declared by a macro `load()`ed from
`@member_a//:defs.bzl` and depends on `@member_a//:out` (cross-cell load and
cross-cell action dep). Two consumer roots with identical external-cell
config. Action digests extracted from `buck2 log show --trace-id`
(`OmittedLocalCommand.action_digest`); execution from `buck2 log what-ran`.
Git invocations captured by a PATH tracer that records argv and execs the
real git — required because the agent-policy git wrapper refuses Buck2's
internal `git reset --hard FETCH_HEAD` (recorded as friction).

## Result

| Probe | Result |
| --- | --- |
| Build + cross-cell load/dep | succeeds; output `member-b-v1\nmember-a-v1` |
| Leaf dir `repos/member_a` absent | builds; the parent `repos/` must exist (`read_dir` error otherwise) |
| Storage | `consumer/buck-out/extcells-proto/external_cells/git/<commit>/`, no `.git` retained |
| Fetch argv | `git init` → `git fetch file:///…/member_a.git <sha>` → `git reset --hard FETCH_HEAD` |
| Source change (v1→v2) | action digest `5b44…` → `9b60…`, reruns (correct) |
| Unrelated-file commit only | action digest `9b60…` → `c435…`, **reruns**; output digest unchanged (`7ac24f62`) |
| `[cells]` path `repos/`→`mounts/`, same commit | digest identical `c435…`; no command ran after `clean` + rebuild |
| Second consumer root | refetches both members (second init/fetch/reset sequence); 24 MiB `buck-out` each |
| Offline (origins renamed, daemon killed) | builds; tracer shows zero new git calls |
| Commit advance latency (warm, local origin) | 0.31–0.38 s wall including one rerun |
| Absolute `[cells]` path outside the root | rejected (interpreted under the project root) |
| Relative `..` symlink cell | rejected as unnormalized |
| Absolute symlink cell | accepted; edit behind it → no rerun, stale output (content-blind, as COMP-R08 states) |
| Watcher | `file_watcher = notify`, no watchman warning |

An on-disk control cell (`member_a_disk`) did not share the local action
entry, but its name differs, so that comparison is not apples-to-apples; the
exact same-name comparison is the companion record
`2026-09-12-external-cell-key-stability.md`.

## Conclusion

Git external cells work as advertised for immutable one-cell inputs. For
member mounts they fail the contract on two counts observed directly: an
unrelated commit bump re-executes member actions (BUCK criterion 1 fails at
the consumer), and there is no host-global sharing (each root fetches its
own copy). There is no live local override shape that is both accepted and
content-real.

## VRS Impact

Confirms the source read in `2026-09-12-external-cells-source-facts.md`;
grounds decision 0030. No change to COMP-R08/R10.
