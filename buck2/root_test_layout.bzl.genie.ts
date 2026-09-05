import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { rootTestLayout, rootTestSourcesTarget } from '../genie/buck2/root-test-layout.ts'

const starlarkString = (value: string): string => JSON.stringify(value)

const treeEntries = rootTestLayout.rootTrees.map(({ prefix, files }) =>
  [
    `    ${starlarkString(prefix)}: {`,
    ...files.map(
      ([destination, source]) =>
        `        ${starlarkString(destination)}: ${starlarkString(source)},`,
    ),
    '    },',
  ].join('\n'),
)

const bzl = `"""Root-package inputs of the repository-root Vitest suite.

The suite under \`genie/buck2\` and \`buck2/dependencies\` loads repository
generator sources by their original relative paths, and the root Buck package
owns some of them. They are declared here rather than globbed in \`BUCK\` so the
census is derived from the suite's actual import closure
(\`genie/buck2/root-test-layout.ts\`) and fails freshness when it drifts.
"""

load("//buck2:materialization.bzl", "export_materialization_inputs")

# Root-package generator directories: mount prefix -> (tree-relative destination
# -> root-package source). Each becomes one \`filegroup\` the root test package
# tree mounts at \`<mount prefix>\`, which reproduces the original paths.
ROOT_TEST_SOURCE_TREES = {
${treeEntries.join('\n')}
}

# Root-package generator sources that sit directly at the repository root and
# therefore cannot belong to a mounted directory tree.
ROOT_TEST_SOURCE_FILES = [
${rootTestLayout.rootFiles.map((file) => `    ${starlarkString(file)},`).join('\n')}
]

def declare_root_test_sources(visibility = ["PUBLIC"]):
    """Exports every root-package input the root test package tree stages."""
    export_materialization_inputs(ROOT_TEST_SOURCE_FILES)
    for prefix in sorted(ROOT_TEST_SOURCE_TREES):
        native.filegroup(
            name = "root_test_sources/" + prefix,
            srcs = ROOT_TEST_SOURCE_TREES[prefix],
            visibility = visibility,
        )
`

export default createGenieOutput({
  data: {
    rootFiles: rootTestLayout.rootFiles,
    rootTrees: rootTestLayout.rootTrees,
    schema: 'effect-utils/buck2-root-test-layout/v1',
    targets: rootTestLayout.rootTrees.map(({ prefix }) => rootTestSourcesTarget(prefix)),
  },
  stringify: () => bzl,
})
