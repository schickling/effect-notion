# Closure-Free TypeScript Sandboxes

Status: accepted
Date: 2026-09-04

## Question

Can TypeScript actions eliminate closure-sized staging, retain deterministic
outputs, and enforce the same declared capability boundary inside pinned Buck
on Linux and Darwin?

## Baseline

A dev3 PR #1209 run was stopped after exceeding 30 minutes while still running
and after reaching at least 24 GB. For tui-react, the retained package layer
was 2,137,358,981 bytes/131,690 files; typecheck took 70.76 s and emit 62.18 s.
Compilation was not the bottleneck: closure copying, hashing, chmod walks, and
cleanup dominated.

## Method

A closure-free package execution view copied only declared package-owned
sources/workspace dist boundaries and linked the normalized importer dependency
view. The runner created a metadata-only package-relative overlay in
`BUCK_SCRATCH_PATH`, linked `dist` to the declared output, and executed pinned
tsgo with incremental build-info suppressed.

The Linux fixture ran Bubblewrap 0.11.2 from its exact Nix closure inside a
local action on pinned Buck 2026-08-22. It mounted declared inputs and 31 tsgo
closure paths read-only, output and scratch writable, cleared the environment,
and unshared filesystem/process/network namespaces. Direct Darwin profile
probes exercised filesystem, network, environment, and write controls. A
separate Darwin fixture ran the same pinned Buck revision on mbp2021 with a
parameterized Seatbelt profile and proved output bytes plus denial of a required
undeclared import. Unsandboxed controls used the same output path for byte
comparison.

## Result

- tui-react's closure-free consumer layer was 2,404,212 bytes/734 entries
  (2.4 MB), down from 2.14 GB. Typecheck fell 70.76 s → 0.76 s and emit
  62.18 s → 0.84 s.
- All 12 then-green admitted packages typechecked and emitted cold in 16.46 s
  wall (24 local actions).
- Linux nested Buck produced nine fixture artifacts — eight JavaScript,
  declaration, and map files plus `tsconfig.tsbuildinfo` — byte-identically to
  the control. Declared input and tool reads
  succeeded; writes to them failed. Output and scratch writes succeeded.
  Undeclared repository, host, home, and Nix-store reads were absent; external
  and host-loopback network access was denied; ambient secret variables were
  absent. A non-vacuous undeclared-read assertion passed inside the action.
- Direct Darwin probes proved the filesystem/network/environment/write
  contract. Separately on mbp2021, Darwin nested Buck produced four
  JS/declaration/map artifacts byte-identically at the same output path; a
  source requiring an undeclared file failed in the Seatbelt action and
  succeeded outside it.
- Repository audit found no consumer of `tsconfig.tsbuildinfo`. No Buck action
  reuses it incrementally; committed-dist freshness already excludes it.
  JavaScript, declaration, and map bytes are the durable output contract.

An undeclared read denial does not universally imply a nonzero tool exit. These
results use explicit negative probes; the Darwin leaky compile failed because
its required input was denied.

## Conclusion

Bubblewrap is a supported exact tool dependency on Linux. Seatbelt's public
interface is deprecated. It is available and proven on the measured mbp2021
release, but each supported macOS upgrade must rerun the in-Buck positive,
negative, and byte-identity smoke gate; failure blocks that OS. The repository's
full Darwin capability projection was absent, so the experiment used a
throwaway pinned-Buck project rather than a production target.

Neither fixture used true remote execution. Both platform implementations and
the exact sandbox-tool closures are required before the final authority flip.

## VRS Impact

EXEC-R02 and EXEC-R05–R11 require exact tool/OS capabilities, platform-native
sandboxes, metadata-only scratch overlays, deterministic outputs, explicit
negative probes, and the Darwin OS-upgrade gate. The execution spec suppresses
`.tsbuildinfo` and retains only JavaScript, declarations, and maps.
