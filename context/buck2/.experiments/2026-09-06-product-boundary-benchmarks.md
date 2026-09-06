# Product boundary benchmarks and tripwire measurement semantics

Date: 2026-09-06
Host class: x86_64-linux development host (dev3), 32 threads; Determinate Nix
3.17.3 (nix 2.33.3), buck2-unstable-2026-08-22, watchman 2026.07.27.00; Buck runs
with `--no-remote-cache`, 0% cache hits, every action `executor=Local`.
Units: MB = 10^6 bytes, MiB = 2^20 bytes. Byte counts are exact; `s` is seconds.

## Question

Decision [0031](../.decisions/0031-git-product-authority-and-release-tripwires.md)
accepts tracked Git product authority and retires it only when one of five
numeric tripwires fires. That is only enforceable if each tripwire names a
population and a command, and if the acceptance baselines are traceable to the
runs that produced them. This record supplies both, plus the boundary costs that
justified rejecting cold Buck-in-Nix and confining source-native Nix to
stage zero (see the deferred entries in [roadmap.md](../roadmap.md)). It
prescribes no retention or revocation policy and implements nothing; those stay
parked with [0013](../.decisions/0013-shared-cache-foundation.md)'s partial
supersession of
[0008](../.decisions/0008-untrusted-oci-and-offline-nix-authority.md).

## Method

- Every number below is either **measured** on real product bytes on the host
  class above, or explicitly labelled **modelled** (arithmetic or enumeration
  over measured inputs). Nothing was re-run for this record; the commands in
  _Tripwire measurement semantics_ were re-executed read-only to confirm they
  reproduce the recorded populations, and the drift is reported.
- Payload, artifact and history populations are read from Git objects at an
  explicit ref, not from a worktree, so a dirty or refreshed checkout cannot
  change the answer. The accepted figures are read at the q22 acceptance
  candidate ref, because the default branch carries no product bytes until that
  candidate merges.
- Boundary A (native Buck, no artifact) was measured cold in a fresh isolation
  dir with an untimed `buck2 targets` warm-up so "cold" means cold local action
  cache, not a Watchman crawl.
- Boundary D (per-product fixed-output fetch) was measured against a throwaway
  local origin; a fresh derivation name per repetition defeats the
  content-addressed short circuit, and a wrong digest was asserted to fail.
- Git republication and clone costs were measured in fresh disposable repos over
  two **real** consecutive generations of the product tree, never synthetic
  mutations.

## Result

### Acceptance-candidate shape (tracked Git authority)

All figures in this section are **acceptance-candidate baselines** measured on
the q22 candidate tree — the integration branch that carries the product
cutover. They are not default-branch measurements: the default branch carries no
product bytes yet, so default-branch tripwire evaluation begins only after this
candidate merges. Decision 0031 adopts these as the acceptance baselines; the
first default-branch reading is expected to equal them up to whatever lands
between this record and the merge.

| Population (acceptance candidate)                                | Bytes      |
| ---------------------------------------------------------------- | ---------- |
| Tracked product directory / candidate payload (25 files)         | 41,408,475 |
| — product modules (10)                                           | 41,382,465 |
| — descriptors (10) + manifest                                    | 14,519     |
| — loader and reconcile tooling                                   | 11,491     |
| Largest single artifact (`genie`)                                | 11,532,809 |
| Flake source closure, with products                              | 69,176,504 |
| Flake source closure, same tree without products [reconstructed] | 27,740,360 |
| — delta attributable to products                                 | 41,436,144 |
| Cumulative distinct product-module bytes, candidate history      | 45,060,041 |

The decomposition is exact: 41,382,465 + 14,519 + 11,491 = 41,408,475. The
payload and the cumulative history figure are distinct quantities — a checkout
materializes the first, a full clone carries the second — and neither substitutes
for the other. The flake source closure is a consumer-realized cost ceiling, not
a payload-health signal. The without-products row is a reconstructed
counterfactual: no surviving script contains its original invocation (see
_Reproduction drift_).

Evaluation does not materialize the payload per product: `nix derivation show`
on a one-product candidate lists 3 `inputSrcs` totalling 11,532,921 B (the single
artifact plus builder scripts). The 41.4 MB lands in the flake **source** store
path, i.e. once per evaluated revision and per worktree, whichever product is
built.

### Boundary A — native Buck, no artifact

| Measurement                           | One product                            | All ten               |
| ------------------------------------- | -------------------------------------- | --------------------- |
| Cold wall time                        | 5.797 / 4.673 / 5.300 s (median 5.300) | 14.177 s              |
| Cold local actions                    | 583                                    | 902                   |
| Cache hits                            | 0%                                     | 0%                    |
| Cold download from registry.npmjs.org | 52 MiB (5/5 cold runs)                 | 55 MiB                |
| `buck-out` after cold build           | 398.2–400.0 MB                         | 473.1–473.9 MB        |
| Warm no-op on a quiescent tree        | 1.017 s, zero actions                  | 0.550 s, zero actions |

Cold action mix for one product: 287 `pnpm_extract`, 274 `pnpm_store_entry`, 8
`pnpm_store_view`, 8 `package_tree`, 4 `pnpm_store_scc`, 1 `package_bin_bundle`,
1 `javascript_product_descriptor`. The registry traffic is the decisive fact:
removing the artifact trades a durable byte boundary for a hard network and
registry dependency at consumption time. Warm no-op latencies above are the
quiescent minima; other repetitions were contaminated by concurrent tree
mutation and Watchman resyncs and are not usable.

### Boundary D — per-product fixed-output fetch

| Measurement                       | One product             | All ten                 |
| --------------------------------- | ----------------------- | ----------------------- |
| Instantiate                       | 1.402 / 0.764 / 0.982 s | 0.954 / 0.856 / 0.857 s |
| Cold realize (first)              | 3.941 s                 | 4.181 s                 |
| Cold realize (fresh name, forced) | 2.556 / 2.020 / 2.166 s | —                       |
| Warm realize                      | 1.035 / 1.111 / 0.782 s | 1.036 / 1.269 / 0.898 s |
| Output bytes                      | 11,532,809              | —                       |
| NAR closure                       | 11,532,928              | 41,386,416              |

The FOD output has no reference to its origin, so the consumer closure is
exactly the product bytes. The oracle is non-vacuous: a wrong digest fails with
`hash mismatch in fixed-output derivation`, and a missing asset fails with
curl 404. Warm realization performs zero transport reads.

### Source-native Nix (stage zero only)

Measured end-to-end from a clean `git archive HEAD` export with zero Buck
involvement:

| Measurement                           | Value                               |
| ------------------------------------- | ----------------------------------- |
| Fully cold wall time (sum)            | 67.6 s                              |
| — of which the pnpm dependency FOD    | 51.63 s                             |
| Registry bytes on first realization   | 148.74 MiB                          |
| Dependency FOD store size             | 252,902,680 B (252.9 MB)            |
| Output binary (`bun build --compile`) | 129.7 MiB (≈136.0 MB)               |
| Runtime closure                       | 852,130,096 B (852.1 MB), 143 paths |
| Derivation closure                    | 3,598 nodes (3,195 derivations)     |
| Warm end-to-end                       | 3.6 s                               |

Product-import baseline on the same host for comparison: 1.35 s cold, 0.69 s
warm, 3.8 MB output, 894,987,360 B runtime closure, one 3,792,296 B
content-addressed store input, zero network.

The output is **not byte-identical to Buck's**. Forced to the same artifact kind
(same source, same dependency FOD, pinned bun 1.3.13, `--target=node`,
minify off, no sourcemap): 3,781,734 B vs Buck's 3,792,184 B, delta −10,450 B
(0.28%). The normalized module closure is identical (456 modules, none
one-sided), but module _instance_ counts differ on 5 modules (523 vs 520
instances), which cascades into bundler identifier renames. Behavioural equality
is positive and non-vacuous: `mr --help` and all three completion scripts are
byte-equal. Cache-key granularity is the architectural blocker: appending one
line to a file the builder's fileset **excludes** still changed the workspace
derivation and produced a bit-identical tree at a new store path, invalidating
every source-native consumer; the product-import boundary keys on 3.79 MB of
content-addressed bytes instead.

### Git history observations — explicitly not tripwires

Decision 0031 excludes these from the tripwire set because both are consequences
of committing anything at all, both move with unrelated source churn, and
neither distinguishes a healthy product payload from an unhealthy one. They are
recorded as observations only:

- Real two-generation products-only pack: 4,866,962 B → 4,868,284 B, i.e.
  **+1,322 B** for a full ten-product refresh generation (14 changed paths).
- Independent refresh probe on the same repository: **+4,944 B**.
  Independent reads of the same two probes recorded +1,320 B and +4,942 B; the
  2 B spread is pack-directory measurement granularity, not a different result.
- Real-history marginal clone attributable to products **[supplied, command not
  reconstructible]**: **+4,288,888 B (+18.8%)**, with delta-window sensitivity
  across 4.29–13.18 MB depending on packing parameters. This figure is recorded
  as supplied; no retained script reproduces it (see _Reproduction drift_). A
  different and fully reconstructible population — a single-generation
  `git archive` of the head tree re-packed aggressively with and without the
  product paths — measured 24,426,156 B vs 14,195,983 B, i.e. +10,230,173 B
  (+72%). The spread between these figures is exactly why marginal clone cost is
  not a tripwire.

Upper bound on generation cost: a fully independent generation of the ten-product
tree packs to 4,866,962 B, so republication is bounded between ~1 KB and ~4.87 MB
per generation and which end applies is an empirical property of generation
independence, not a design choice.

### Consumer shape

- Product bytes are 2.0% of a consumer closure under every boundary:
  11,542,113 B of 581,282,448 B across 83 store paths. The remaining 98% is
  identical toolchain closure, so the boundary choice moves ~11.5 MB per
  product, not the closure.
- Every consumer declaration resolved today reaches products through the
  repository's own flake source, so the bytes are already on disk after a
  checkout the consumer performs anyway. The acceptance-candidate baseline for
  tripwire 5 is therefore **zero** non-flake-source consumers, established by
  reading each declaration and import site, not by a text search alone.
- In-repo import sites of the path loader: `flake.nix` (`trackedBuck2Products`,
  re-exported as `lib.trackedBuck2Products`),
  `nix/devenv-modules/tasks/shared/bootstrap-closure.nix`, and the loader
  contract fixture `nix/workspace-tools/lib/tests/tracked-buck-products.sh`
  (which asserts the exact ten-name product list).
- Cross-repo consumers declare a flake input on this repository and consume
  `packages.<system>.<product>` — enumerated on a composed tree as `genie`,
  `megarepo`, `ci-tools`, `genie-bootstrap-closure-check`, `notion-cli`,
  `notion-md`, `notion-db-runtime`. Each resolved declaration realizes the flake
  source; none fetches a product by URL and none reads it outside a Nix build.

## Tripwire measurement semantics

Every tripwire is evaluated against the **default branch**, never against a
feature branch or a dirty worktree. Bind the ref once and reuse it; plain `HEAD`
is not admissible because in a working checkout it usually names the feature
branch:

```sh
DEFAULT_BRANCH_REF=$(git symbolic-ref --short refs/remotes/origin/HEAD)   # e.g. origin/main
git fetch --quiet origin
git diff --quiet && git diff --cached --quiet ||
  { echo 'refusing to measure: dirty checkout' >&2; exit 1; }
```

Measure from the product repository root. `$PWD` keeps the commands
path-neutral, and every size is read from Git objects at
`$DEFAULT_BRANCH_REF`, so worktree state cannot affect a result. Tripwires 1, 2
and 4 are pure object reads and need no checkout of that ref; tripwire 3
realizes flake source and therefore requires a clean checkout **of**
`$DEFAULT_BRANCH_REF` (a worktree at that ref is sufficient:
`git worktree add <dir> "$DEFAULT_BRANCH_REF"`). Until the q22 candidate merges,
`$DEFAULT_BRANCH_REF` carries no product bytes and every payload tripwire reads
zero; substitute the candidate ref explicitly and say so when reporting a
pre-merge reading.

**1. Default-branch tracked product payload** (threshold 100 MB,
acceptance-candidate baseline 41,408,475 B over 25 files):

```sh
git ls-tree -r -l "$DEFAULT_BRANCH_REF" -- nix/buck2-products |
  awk '{ bytes += $4; files += 1 } END { print bytes, files }'
```

Population: every tracked file under the product directory at
`$DEFAULT_BRANCH_REF` — modules, descriptors, manifest, and the loader/reconcile
tooling. This is what one checkout of the default branch materializes.

**2. Largest default-branch module** (threshold 50 MiB = 52,428,800 B,
acceptance-candidate baseline 11,532,809 B):

```sh
git show "$DEFAULT_BRANCH_REF:nix/buck2-products/manifest.json" |
  jq -r --arg ref "$DEFAULT_BRANCH_REF" \
    '.products | to_entries[] | "\($ref):nix/buck2-products/\(.value.artifact) \(.key)"' |
  git cat-file --batch-check='%(objectsize) %(rest)' --buffer |
  sort -rn |
  sed -n 1p
```

Population: module artifacts only, enumerated from the manifest so the
descriptor, manifest and loader files cannot mask or inflate the maximum. The
manifest is read from the same ref as the objects it names, so a worktree
carrying a newer refresh cannot produce `missing` lookups.

**3. Flake source closure with products** — the consumer-realized cost ceiling
(threshold 100 MB, acceptance-candidate baseline 69,176,504 B). Run this from a
clean checkout or worktree of `$DEFAULT_BRANCH_REF`, because it realizes source
rather than reading objects:

```sh
src=$(nix eval --impure --raw --expr "toString (builtins.getFlake \"git+file://$PWD\").outPath")
nix path-info -S "$src" | awk '{ print $2 }'
```

Population: the NAR closure size of the flake source store path the consumer
realizes, products included. The 27,740,360 B without-products figure is a
**reconstructed** diagnostic, not a tripwire: its original invocation is not
preserved in any surviving script, and the recipe below is this record's
reconstruction of it — export the same tree, remove the product directory, size
the result:

```sh
tree=$(mktemp -d) && git archive "$DEFAULT_BRANCH_REF" | tar -x -C "$tree"
rm -rf "$tree/nix/buck2-products"
nix path-info -S "$(nix store add-path "$tree" --name source-without-products)" |
  awk '{ print $2 }'
```

**4. Cumulative distinct product-module bytes reachable from the default
branch** (threshold 250 MB, acceptance-candidate baseline 45,060,041 B):

```sh
git rev-list "$DEFAULT_BRANCH_REF" -- nix/buck2-products |
  while read -r commit; do git ls-tree -r "$commit" -- nix/buck2-products; done |
  awk '$4 ~ /^nix\/buck2-products\/[^/]+\/[0-9a-f]{64}-/ { print $3 }' |
  sort -u |
  git cat-file --batch-check='%(objectsize)' --buffer |
  awk '{ bytes += $1; blobs += 1 } END { print bytes, blobs }'
```

Population: each **distinct** module blob that has ever been reachable from the
default branch, counted once, at uncompressed object size — what a full clone
must be able to deliver. The path filter admits only content-addressed module
artifacts (`<product>/<sha256>-<module>`), so descriptor and tooling churn never
enters the count. Uncompressed size is deliberate: packed size moves with
unrelated source churn and delta-window parameters, which is the same reason
clone marginal cost is not a tripwire.

**5. Consumer-shape inventory** (threshold: any consumer that does not consume
products from flake source; acceptance-candidate baseline none). This tripwire
is evaluated against **actual consumer declarations and import sites** — what a
consumer's `flake.nix`/`devenv.nix` inputs and Nix expressions actually resolve
— and only afterwards, and never solely, against a text search. Text search is
the candidate-finding step; the verdict comes from reading each declaration:

```sh
# 1. products offered to consumers, from the generated declaration
jq -r '.products[] | "\(.productName)\t\(.productKind)"' nix/buck2-products/products.json

# 2. declared consumption surface: which flake outputs expose a product
nix eval --json ".#packages.$(nix eval --impure --raw --expr builtins.currentSystem)" \
  --apply 'builtins.attrNames'

# 3. candidate import sites to read (in-repo path loader)
rg -n 'trackedBuck2Products|buck2-products' --glob '*.nix'

# 4. candidate import sites to read (cross-repo, from the root of a
#    composition that contains the consumer repos)
rg -n 'effectUtilsPackages\.|effectUtils\.packages|effect-utils#' \
  --glob '*.nix' --glob '*.ts' repos
```

Steps 3 and 4 only produce candidates; each one is then resolved to its
declaration — the flake input it comes from and the expression that consumes it
— and classified. The tripwire fires when a resolved declaration obtains a
product other than by realizing this repository's flake source: a URL fetch, a
pointer file, a `curl`-and-`chmod` install, a registry package, or any non-Nix
consumer. Every declaration resolved today reaches products through flake
source, so the current result is an inventory, not a violation.
`devenv tasks run buck2:products:check` remains the drift gate between tracked
bytes and Buck output; it is not a tripwire.

## Reproduction drift

The accepted baselines above stay as measured on the q22 acceptance candidate.
The following are a **separate, later** reading of the same populations on the
same integration branch after it was rebased and its products regenerated; they
do not replace the baselines and are recorded only so the drift is visible:

| Population (post-rebase committed branch HEAD)           | Reading                          | Acceptance-candidate baseline          |
| -------------------------------------------------------- | -------------------------------- | -------------------------------------- |
| Tracked product payload                                  | 41,409,562 B / 25 files          | 41,408,475 B / 25 files                |
| Largest module (`genie`)                                 | 11,533,390 B                     | 11,532,809 B                           |
| Cumulative distinct product-module bytes, branch history | 45,124,609 B / 11 distinct blobs | 45,060,041 B (blob count not recorded) |

The populations reproduce exactly; the totals moved because the product tree was
regenerated and the branch rebased after the acceptance run (the committed head
tree and the index differ by a staged refresh, which is what made a second real
republication generation measurable). All three readings remain far inside their
thresholds. Evaluated against the real default branch the same commands return 0
today, because products land there only at the integration merge — which is why
the numbers above are acceptance-candidate baselines and default-branch tripwire
evaluation begins after that merge.

Two figures could not be fully reconstructed from the retained prototype
scripts and are recorded as supplied:

- the real-history marginal clone figure (+4,288,888 B, +18.8%, delta-window
  sensitivity 4.29–13.18 MB) — the surviving clone-cost script measures the
  single-generation `git archive` population instead (+10,230,173 B, +72%);
- the without-products flake source closure (27,740,360 B) — the surviving
  scripts keep only the pack-size variant, so the export-and-`nix store add-path`
  recipe above is a reconstruction of that measurement, not the original
  invocation.

Boundary B (cold Buck-inside-Nix: 1,260,274,568 B ground closure, 315 executed
actions, 5.392 s, 115,015,023 B `buck-out`) is carried over from shared context
and was not re-measured here; its action count and isolation dir differ from the
native Buck harness above, so the two are not comparable run-for-run.

## Conclusion

At measured scale tracked Git authority wins on absolute numbers: the payload,
the largest artifact, the consumer-realized closure and the cumulative history
all sit far below the thresholds decision 0031 sets, and a consumer pays zero
network for product bytes. Removing the artifact costs a cold consumer 5.3 s,
583 local actions and 52 MiB of registry traffic per product; realizing products
from source under Nix costs 67.6 s cold, 148.74 MiB of registry traffic and an
852 MB runtime closure and still does not reproduce Buck's bytes, so it stays a
stage-zero exception. Republication churn and clone marginal cost are noisy
consequences of committing anything and are excluded from the tripwire set on
purpose. What this record adds is enforceability: five commands, five named
populations, and the arithmetic that ties each acceptance baseline to the run
that produced it.

## VRS Impact

Supplies the measurement definitions and acceptance baselines referenced by
[decision 0031](../.decisions/0031-git-product-authority-and-release-tripwires.md)
and by the deferred entries in [roadmap.md](../roadmap.md) that reject cold
Buck-inside-Nix as the normal product boundary and confine source-native Nix
realization to stage zero. Records no policy: retention, revocation and the wider
distribution-durability machinery remain parked with
[decision 0013](../.decisions/0013-shared-cache-foundation.md)'s partial
supersession of
[decision 0008](../.decisions/0008-untrusted-oci-and-offline-nix-authority.md).
