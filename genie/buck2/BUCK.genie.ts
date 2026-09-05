import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import {
  rootTestContractDirectories,
  rootTestLayout,
  rootTestSuiteDirectories,
  rootTestSuitePackage,
} from './root-test-layout.ts'
import { buck2DependencyViewLabel } from './typescript-package-projection.ts'

const starlarkString = (value: string): string => JSON.stringify(value)

const renderLayoutDict = (entries: readonly { destination: string; label: string }[]): string =>
  entries
    .map(({ destination, label }) => `    ${starlarkString(destination)}: ${starlarkString(label)},`)
    .join('\n')

/**
 * Workspace importer whose declared dependencies the root test suite runs on.
 *
 * The repository root importer (`.`) declares nothing — root installs are gone —
 * so projecting the root test tree against it yields an empty `node_modules` and
 * Vitest cannot even be resolved. The suite under `genie/buck2` and
 * `buck2/dependencies` exercises the genie generators, whose runtime is
 * `@overeng/genie`; that package's importer is the real, lockfile-declared
 * authority for `vitest` and `effect`, the only external packages the suite
 * loads. Naming it here keeps the dependency view a normalized store view
 * instead of a root install or a source-tree fallback.
 */
export const rootTestDependencyAuthority = 'packages/@overeng/genie'

/** Normalized store view the root test package tree materializes. */
export const rootTestDependencyView = buck2DependencyViewLabel(rootTestDependencyAuthority)

const buck = `load("//buck2:javascript.bzl", "vitest_test")
load("//buck2:materialization.bzl", "empty_package_view", "package_view")
load("//buck2:package_tools.bzl", "package_bin")

# Composed repository-root layout: the suite imports repository sources by their
# original relative paths, so the tree reproduces those paths. Its own sources
# come from this package, contributing packages export the generator sources
# they own as one tree each, and individual library modules come from the
# per-package exported inputs. The census is derived from the suite's relative
# import closure by \`genie/buck2/root-test-layout.ts\`, never hand-listed.
root_test_files = {
    "${rootTestSuitePackage}/{}".format(source): source
    for source in glob(["*.ts"])
}

# Directory trees mounted at their repository paths.
root_test_files.update({
${renderLayoutDict(rootTestLayout.sourceTrees)}
})

# Individual modules the suite loads from other Buck packages.
root_test_files.update({
${renderLayoutDict(rootTestLayout.sourceFiles)}
})

# Declared test data: repository bytes the suite reads by path rather than
# importing — the real lockfile pair, generated Starlark and \`BUCK\` text, the
# generated workflows, the emitted CI scripts and the devenv task modules. The
# census is \`rootTestDataRoots\` plus \`rootTestDataFiles\` in
# \`genie/buck2/root-test-layout.ts\`, expanded from the repository.
root_test_files.update({
${renderLayoutDict(rootTestLayout.dataFiles)}
})

export_file(
    name = "typescript-authority-manifest.json",
    src = "typescript-authority-manifest.json",
    visibility = ["PUBLIC"],
)

# The suite asserts over its own generated declaration, so that file is a
# declared input of the test action and not only its output.
export_file(
    name = "BUCK",
    src = "BUCK",
    visibility = ["PUBLIC"],
)

empty_package_view(
    name = "authority_runtime_package_tree",
    files = {
        "genie/buck2/typescript-authority-manifest.json": "typescript-authority-manifest.json",
        "genie/buck2/typescript-authority-runtime.ts": "typescript-authority-runtime.ts",
    },
    runtime = "//:package_tree_runtime",
    runtime_entry = "package-tree.ts",
    visibility = ["PUBLIC"],
)

package_view(
    name = "root_test_package_tree",
    dependency_view = "${rootTestDependencyView}",
    files = root_test_files,
    runtime = "//:package_tree_runtime",
    runtime_entry = "package-tree.ts",
    visibility = ["PUBLIC"],
)

vitest_test(
    name = "test",
    package_tree = ":root_test_package_tree",
    config = "genie/buck2/vitest.config.ts",
    test_files = ${JSON.stringify([...rootTestSuiteDirectories, ...rootTestContractDirectories])},
    # Repository-contract suites execute the CI scripts and generated workflows they assert
    # over: \`bash\` is the interpreter the emitted scripts are run through, \`git\`, \`jq\`,
    # and \`wc\` are driven directly by the workflow-helper fixtures, \`grep\` is what
    # \`genie/ci-scripts/resolve-devenv.sh\` extracts an invalid store path with, \`env\` and the
    # rest of the coreutils realization back the scripts' own utility lookups, and \`bun\` runs
    # the generator probes. Each is the attested capability, never a host PATH lookup.
    tools = {
        "BASH_BIN": "//buck2/toolchains:tool_test_bash",
        "BUN_BIN": "//buck2/toolchains:tool_bun",
        "ENV_BIN": "//buck2/toolchains:tool_coreutils_env",
        "GIT_BIN": "//buck2/toolchains:tool_test_git",
        "GREP_BIN": "//buck2/toolchains:tool_test_grep",
        "DEVENV_MODULE_TOOLS_BIN": "//buck2/toolchains:tool_test_devenv_module_tools",
        "WC_BIN": "//buck2/toolchains:tool_coreutils_wc",
    },
    capabilities = ["subprocess"],
    timeout_ms = 120000,
    hook_timeout_ms = 120000,
    visibility = ["PUBLIC"],
)

package_bin(
    name = "typescript-authority-runtime",
    entrypoint = "genie/buck2/typescript-authority-runtime.ts",
    external_capabilities = ["buck2", "coreutils"],
    package_tree = ":authority_runtime_package_tree",
    visibility = ["PUBLIC"],
)
`

export default createGenieOutput({
  data: { schema: 'effect-utils/typescript-authority-runtime-target/v1' },
  stringify: () => buck,
})
