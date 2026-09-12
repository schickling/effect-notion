# Content-Addressed Dist Tarball as a Cross-Repository TypeScript Channel

Date: 2026-09-12 — Host: dev3 — effect-utils
`49dfa42eed70b6b9a117f58e210d8fab20ae8cf6`; pnpm 12.3.4; tsgo
7.0.0-dev+effect-tsgo.0.14.5; transport bazel-remote 2.6.2 HTTP CAS at
`dev3:41046`. Scratch retained at `/tmp/megarepo-vs-buck2/tarball-channel/`
(27 log files); disposable.

## Question

For the proposed artifact-composition direction: can an ordinary pnpm
consumer replace a `link:`/`file:` source edge into `repos/effect-utils` with
a content-addressed dist tarball, keep declaration resolution and lockfile
integrity, and refuse drift — using only existing infrastructure?

## Method

The canonical Buck-built `tui-core` dist (156 KiB) was copied out of the
read-only main worktree (recursive diff exit 0). `pnpm pack` from the package
dir omitted `dist/` (the manifest's `files`/`exports` describe the source
layout), so an npm-shaped tarball was assembled with `tar` (`package/
{package.json,dist/}`) and corrected `exports` (`types: ./dist/src/mod.d.ts`,
`default: ./dist/src/mod.js`). The tarball was `PUT` to
`http://dev3:41046/cas/<sha256>` and fetched back. A scratch consumer
declared `"@overeng/tui-core": "http://dev3:41046/cas/<sha256>"`, ran
`pnpm install` cold (empty store) and warm (store kept, `node_modules`
removed, `--frozen-lockfile`), and typechecked `src/index.ts` importing
`stripAnsi` and the `Terminal` type with `tsgo --noEmit`. Drift: one byte of
the tarball XORed, `PUT` under its new sha256, lockfile `resolution.tarball`
pointed at the new URL with the old integrity retained, frozen install with an
empty store.

## Result

| Measurement | Value |
| --- | --- |
| Tarball | 28,100 bytes; sha256 `c0dd8266…4875824`; integrity `sha512-T3t6…HNog==` |
| CAS PUT / GET | 200 in 0.57 s / 200 in 1 ms; bytes identical (`cmp` exit 0) |
| Lockfile | `resolution: {integrity: sha512-…, tarball: http://dev3:41046/cas/c0dd…}` recorded by pnpm |
| Typecheck | `tsgo --noEmit` exit 0; resolution trace matched the `types` export → installed `dist/src/mod.d.ts` |
| Cold install (empty store) | 1.75 s wall (9 downloaded, 1 reused) |
| Warm rematerialization | 0.13 s wall (10 reused, 0 downloaded) |
| `node_modules` | 55 MiB allocated / 50.3 MB apparent (dominated by `effect`) |
| Drift | frozen install exit 1, `ERR_PNPM_TARBALL_INTEGRITY` naming wanted vs actual digest |
| CAS state | `CurrSize` 3.44 GB of 500 GiB; LRU, not durable |

## Conclusion

The channel works for this edge with zero new transport: pnpm pins URL +
integrity, tsgo consumes declarations from the installed dist, and drift is
refused at install. Two pieces of machinery it does not supply and the
proposal must own: (1) a per-package publish layout — the current manifests
(`exports` at `src`, `publishConfig` naming `./dist/mod.js`) do not describe
the Buck-built `dist/src/*` layout, so `pnpm pack` produces an unusable
artifact today; (2) a durable origin and retention policy — bazel-remote is
an evictable cache and cannot be the only home of historical lockfile pins.

## VRS Impact

Evidence for the proposed decision `.proposed/artifact-composition.md`: one
artifact-consumption edge is proven end to end. It does not show that the
direction preserves vision criterion 6, source-granular invalidation across
the edge, or atomic cross-repository refactors; those are what the proposal
asks to give up, explicitly.
