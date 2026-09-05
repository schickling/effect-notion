load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")
load("//buck2:root_test_layout.bzl", "declare_root_test_sources")

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

# Stable root labels retained for generated callers; the owning rules live in
# the buck2-tools package alongside their source files.
alias(
    name = "package_tree_runtime",
    actual = "//packages/@overeng/buck2-tools:package_tree_runtime",
    visibility = ["PUBLIC"],
)

alias(
    name = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    actual = "//packages/@overeng/buck2-tools:src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)

alias(
    name = "packages/@overeng/buck2-tools/src/owned-files.ts",
    actual = "//packages/@overeng/buck2-tools:src/owned-files.ts",
    visibility = ["PUBLIC"],
)

# Generated pnpm dependency rules name every lockfile patch by its repository-root label
# (`buck2/dependencies/pnpm-lock.ts`), while the file itself is an input of the package that
# owns it. The alias is the stable root label; the source stays exported once.
alias(
    name = "packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch",
    actual = "//packages/@overeng/utils:patches/@myobie__pty@0.10.0.patch",
    visibility = ["PUBLIC"],
)

# Root-package generator sources the repository-root Vitest suite imports.
#
# The census is derived from that suite's relative-import closure
# (`genie/buck2/root-test-layout.ts`) and generated into
# `buck2/root_test_layout.bzl`, so a new import is a declared input after
# `genie:run` instead of a `Cannot find module` inside the test action.
declare_root_test_sources()
