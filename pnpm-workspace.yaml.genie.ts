// @genie-bootstrap
import { catalog } from './genie/external.ts'
import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  catalogVersions: catalog,
  catalogDuplicateExceptions: [
    {
      package: 'typescript',
      // Two cohorts, both intentional and both present in the lock at this
      // commit: production compiles with the catalog's TypeScript 7, and
      // @overeng/oxc-config stays on 6.0.3 because @typescript-eslint's
      // rule-tester harness still imports the classic compiler API that 7
      // removed. Pinned to exactly the resolved set, so a third compiler fails
      // closed (drift) instead of riding along on this acknowledgement; a
      // cohort move must update this list in the same change.
      versions: ['7.0.2', '6.0.3'],
      reason:
        'production compiles with catalog typescript@7.0.2 while @overeng/oxc-config keeps typescript@6.0.3 for @typescript-eslint@8.61.1 rule-tester, which imports the classic compiler API removed in 7',
      issue: '#821',
    },
    {
      package: 'string-width',
      // @opentui/core@0.4.1 (latest) pins string-width@7.2.0 exactly, so pnpm
      // dedupe cannot collapse it onto the catalog 8.x. We deliberately do NOT
      // force it via an override: string-width 8 changed wide-char/emoji width
      // computation (dropped emoji-regex, bumped get-east-asian-width), and
      // @opentui/core is a terminal renderer that depends on that width logic —
      // forcing 8.x risks subtle rendering breakage. Blessed instead; revisit
      // when @opentui/core moves to string-width 8.x. See #821.
      reason:
        '@opentui/core@0.4.1 exact-pins string-width@7.2.0; not force-overridden because string-width 8 changes emoji/wide-char width logic that the TUI renderer relies on',
      issue: '#821',
    },
  ],
  ...commonPnpmWorkspaceData,
  overrides: {
    // A caret prerelease range selects newer RCs. Pin the transitive package so
    // the intentionally frozen Effect RC cohort remains on one release.
    '@effect/platform-node-shared': catalog.effect,
  },
})
