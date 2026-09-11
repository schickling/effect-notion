load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")
load("//buck2:static_checks.bzl", "STATIC_SOURCE_EXCLUDES", "STATIC_SOURCE_GLOBS", "static_source_set")

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
static_source_set(
    name = "static_sources",
    prefix = "",
    srcs = glob(
        [
            root + "/" + pattern
            for root in ["context", "packages", "scripts"]
            for pattern in STATIC_SOURCE_GLOBS
        ],
        exclude = [
            root + "/" + pattern
            for root in ["context", "packages", "scripts"]
            for pattern in STATIC_SOURCE_EXCLUDES
        ],
    ) + [
        ".oxfmtrc.json",
        ".oxlintrc.json",
        "devenv.lock",
        "devenv.yaml",
        "flake.lock",
        "flake.nix",
        "megarepo.kdl",
        "megarepo.lock",
        "tsconfig.lint.json",
    ],
    visibility = ["PUBLIC"],
)


# Workspace patches are declared inputs to the generated pnpm extraction actions.
export_file(
    name = "patches/@myobie__pty@0.10.0.patch",
    src = "patches/@myobie__pty@0.10.0.patch",
    visibility = ["PUBLIC"],
)
