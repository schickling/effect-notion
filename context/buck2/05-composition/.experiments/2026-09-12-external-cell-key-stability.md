# External Cell vs On-Disk Cell: Exact Action-Digest Comparison

Date: 2026-09-12 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-09-01, isolation
dir `key-stability`. Fixture retained at `/tmp/megarepo-vs-buck2/key-stability/`
(81 log files, machine-extracted comparison `logs/71-digest-comparison.json`);
disposable.

## Question

With cell name, `[cells]` path, target label, platform, and isolation dir held
byte-identical, does a git external cell produce the same action digest as an
on-disk cell holding the same committed tree? And does an unrelated commit
bump invalidate an action whose input is not rendered into argv (isolating the
input-tree mechanism from argv rendering)?

## Method

Variant D: `member_a = repos/member_a` populated with `git archive <commit> |
tar -x` (a real directory). Variant E: the same `.buckconfig` line plus
`[external_cells] member_a = git` pinned at the same commit. Per variant:
`buck2 kill`, `rm -rf buck-out`, `buck2 build member_a//:out`, digest from
`buck2 log show` (`action_digest` on `Execute` / `OmittedLocalCommand` /
`BuildGraphInfo`; the event log carries no `command_digest` or
`input_root_digest` field, so input-root attribution is inferred). Hidden-input
case: commit `c` adds `genrule(name = "hidden", srcs = ["input.txt"], cmd =
"cat input.txt > $OUT")` (no `$(location)`, argv contains no path); commit `d`
adds an unrelated file. Argv and outputs compared across variants.

## Result

| Case                         | D (on-disk)                  | E (external)                                          | Same?                          |
| ---------------------------- | ---------------------------- | ----------------------------------------------------- | ------------------------------ |
| `member_a//:out` at bb539116 | `723b2845…:142`              | `e4d9e012…:141`                                       | no (argv and output identical) |
| `member_a//:hidden` at c     | `c80cb008…:142`              | `704e441e…:141`                                       | no                             |
| `hidden`, unrelated bump c→d | digest unchanged, 0 commands | `080ce414…:141`, 1 local rerun, argv/output unchanged | —                              |

Source path as seen by Buck: `buck2 audit` reports the virtual `repos/member_a`;
`what-ran` shows `././input.txt`; resolving the action input yields the physical
`buck-out/key-stability/external_cells/git/<commit>/input.txt`.

## Conclusion

Proven: (1) an external-cell source cannot share an action key with an
on-disk cell at the same path, name, and label — the physical commit-keyed
path is what differs; (2) an unrelated commit bump invalidates actions whose
inputs are not in argv, so the mechanism is the input tree, not command
rendering. Together with the fixture record this closes the review's
"not apples-to-apples" objection: under the current release, external cells
are incompatible with COMP-R02's one-cache-namespace-per-repo and with
vision criterion 6 for every action that reads member sources.

## VRS Impact

Grounds decision 0030 without the earlier hedge. Revisit condition 1 (upstream
content-based external-cell keys) is the only thing that could change (1); (2)
follows from (1).
