load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")

# Conventional prelude toolchain targets, owned by the platform hub.
#
# The composition root sets `[cell_aliases] toolchains = <platformHubCell>`
# (`composition/root/composition-root.ts`), so prelude's conventional
# `toolchains//:<lang>` spelling resolves into *this* package for every member cell in the
# composed workspace. Prelude rules used by any member therefore find exactly one instance
# of each conventional toolchain, and it is the hub's capability-backed one. Keeping them
# here preserves `05-composition/spec.md:51-56` ("the root carries no synthetic toolchains
# or `none` cell").
toolchain_alias(
    name = "rust",
    actual = "//buck2/toolchains:rust",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "cxx",
    actual = "//buck2/toolchains:cxx",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "go_bootstrap",
    actual = "//buck2/toolchains:go_bootstrap",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "python_bootstrap",
    actual = "//buck2/toolchains:python_bootstrap",
    visibility = ["PUBLIC"],
)

# Prelude's genrule toolchain carries no executable at all (`zip_scrubber = None`,
# `@prelude//:genrule_toolchain.bzl`), so there is nothing to pin and nothing to project:
# the upstream instance is already hermetic.
system_genrule_toolchain(
    name = "genrule",
    visibility = ["PUBLIC"],
)

# The package-tree runner and its complete relative-import closure, staged side
# by side in one directory so the runner's sibling imports resolve inside the
# action. A Buck action sees only declared inputs: a module missing here fails
# closed at run time instead of silently reaching into the source tree.
# Declared in genie/buck2/runtime-modules.ts and gated by
# genie/buck2/buck2-runtime-closure.unit.test.ts.
filegroup(
    name = "package_tree_runtime",
    srcs = {
        "package-tree.ts": "packages/@overeng/buck2-tools/src/package-tree.ts",
        "real-path.ts": "packages/@overeng/buck2-tools/src/real-path.ts",
    },
    visibility = ["PUBLIC"],
)

# Package command actions execute this runner beside its only relative import.
# The rules address the entry inside this declared tree rather than reaching
# back into the source checkout.
filegroup(
    name = "package_command_runtime",
    srcs = {
        "package-command-runner.ts": "packages/@overeng/buck2-tools/src/package-command-runner.ts",
        "typescript-runner.ts": "packages/@overeng/buck2-tools/src/typescript-runner.ts",
        "real-path.ts": "packages/@overeng/buck2-tools/src/real-path.ts",
    },
    visibility = ["PUBLIC"],
)

# JavaScript command and test actions execute this runner beside its declared
# import closure. `//buck2:javascript.bzl` addresses the entry inside this tree,
# so the runner never reaches back into the source checkout for its own modules.
filegroup(
    name = "javascript_action_runtime",
    srcs = {
        "javascript-runner.ts": "packages/@overeng/buck2-tools/src/javascript-runner.ts",
        "typescript-runner.ts": "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    },
    visibility = ["PUBLIC"],
)

# Hermetic TypeScript actions execute this source with their pinned Bun runtime.
# Single-file staging: this runner must import nothing relative.
export_file(
    name = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    src = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)

# Stateless completeness gate: Git supplies candidates and Buck remains the sole owner matcher.
# Single-file staging: this runner must import nothing relative.
export_file(
    name = "packages/@overeng/buck2-tools/src/owned-files.ts",
    src = "packages/@overeng/buck2-tools/src/owned-files.ts",
    visibility = ["PUBLIC"],
)
