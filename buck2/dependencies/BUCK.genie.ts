import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { loadRealPnpmLockData } from './generate.ts'
import {
  renderPnpmPackageTargets,
  renderPnpmPlatformGatedPackages,
  renderPnpmStoreBuck,
} from './pnpm-store-buck.ts'
import { makePnpmStoreProjection } from './pnpm-store.ts'

const { metadata, sidecar } = loadRealPnpmLockData()
const store = makePnpmStoreProjection({ metadata, sidecar })

export default createGenieOutput({
  data: { store },
  stringify: () =>
    `# Generated file - DO NOT EDIT
# Source: pnpm-lock.yaml
# Store fingerprint: ${store.fingerprint}

load("//buck2:materialization.bzl", "export_materialization_inputs")

# The root Buck suite asserts over this package's own generated declaration and
# over the store fingerprint sidecar, so both are declared inputs, not just
# generated output.
export_materialization_inputs(
    glob(["*.ts"], exclude = ["assemble-store.ts"]) + ["BUCK", "pnpm-lock.sha256.json"],
)

load("//buck2/dependencies:defs.bzl", "pnpm_package", "pnpm_platform_gated_packages")

${renderPnpmPlatformGatedPackages({ metadata })}
${renderPnpmPackageTargets({ metadata, sidecar })}
${renderPnpmStoreBuck(store)}`,
})
