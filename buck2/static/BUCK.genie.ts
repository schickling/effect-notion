import { pnpmWorkspaceMemberPaths } from '../../genie/packages.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'


const declaredPackages = pnpmWorkspaceMemberPaths

const sourceSets = [
  '//:static_sources',
  ...pnpmWorkspaceMemberPaths.map((packagePath) => `//${packagePath}:static_sources`),
].toSorted()

if (new Set(sourceSets).size !== sourceSets.length) {
  throw new Error('Static source-set census contains duplicate Buck labels')
}

export default createGenieOutput({
  data: { declaredPackages, sourceSets },
  stringify: () => `# Generated file - DO NOT EDIT
# Source: TypeScript admission package boundaries and root static source ownership

load("//buck2:static_checks.bzl", "repository_static_checks")

repository_static_checks(
    name = "check",
    declared_packages = ${JSON.stringify(declaredPackages, null, 4)},
    source_sets = ${JSON.stringify(sourceSets, null, 4)},
    visibility = ["PUBLIC"],
)
`,
})
