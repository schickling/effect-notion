"""Repository-wide static checks over exact package-local source manifests."""

load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

STATIC_SOURCE_GLOBS = [
    "**/*.cjs",
    "**/*.cts",
    "**/*.css",
    "**/*.gql",
    "**/*.graphql",
    "**/*.handlebars",
    "**/*.hbs",
    "**/*.html",
    "**/*.js",
    "**/*.json",
    "**/*.json5",
    "**/*.jsonc",
    "**/*.jsx",
    "**/*.less",
    "**/*.markdown",
    "**/*.md",
    "**/*.mdx",
    "**/*.mjs",
    "**/*.mts",
    "**/*.sass",
    "**/*.scss",
    "**/*.toml",
    "**/*.ts",
    "**/*.tsx",
    "**/*.vue",
    "**/*.yaml",
    "**/*.yml",
]
STATIC_SOURCE_EXCLUDES = [
    "**/dist/**",
    "**/node_modules/**",
    "**/storybook-static/**",
    "**/tmp/**",
]

StaticSourceSetInfo = provider(fields = {
    "files": provider_field(list[Artifact]),
    "node_modules": provider_field(list[Artifact]),
    "prefix": str,
})


def _static_source_set_impl(ctx):
    node_modules = [] if ctx.attrs.node_modules == None else ctx.attrs.node_modules[DefaultInfo].default_outputs
    if len(node_modules) > 1:
        fail("static source set node_modules dependency must expose exactly one tree")
    return [
        DefaultInfo(),
        StaticSourceSetInfo(files = ctx.attrs.srcs, node_modules = node_modules, prefix = ctx.attrs.prefix),
    ]


_static_source_set = rule(
    impl = _static_source_set_impl,
    attrs = {
        "prefix": attrs.string(),
        "node_modules": attrs.option(attrs.dep(), default = None),
        "srcs": attrs.list(attrs.source()),
    },
)


def static_source_set(name, prefix, srcs, node_modules = None, **kwargs):
    """Declares one package boundary's governed static source files and dependency view."""
    _static_source_set(name = name, node_modules = node_modules, prefix = prefix, srcs = srcs, **kwargs)

def _collect_static_sources(ctx, output, include_node_modules):
    sources = {}
    for source_set_target in ctx.attrs.source_sets:
        source_set = source_set_target[StaticSourceSetInfo]
        for source in source_set.files:
            destination = source.short_path if not source_set.prefix else source_set.prefix + "/" + source.short_path
            if destination in sources:
                fail("duplicate static source destination: {}".format(destination))
            sources[destination] = source
        if include_node_modules:
            for node_modules in source_set.node_modules:
                destination = source_set.prefix + "/node_modules"
                if destination in sources:
                    fail("duplicate static dependency destination: {}".format(destination))
                sources[destination] = node_modules
    return sources, ctx.actions.copied_dir(output, sources)


def _repository_static_check_impl(ctx):
    tool = ctx.attrs.tool[BuckSupportToolInfo]
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sources, source_tree = _collect_static_sources(ctx, "source", True)
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    args = cmd_args([
        toolchain.bun,
        ctx.attrs._runner,
        "--kind",
        ctx.attrs.kind,
        "--source",
        source_tree,
        "--tool",
        tool.executable,
        "--output",
        result.as_output(),
    ])
    for source_path in sorted(sources.keys()):
        args.add("--path", source_path)
    args.add(cmd_args(hidden = [source_tree, tool.manifest]))
    ctx.actions.run(
        args,
        category = "{}_check".format(ctx.attrs.kind),
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


_repository_static_check = rule(
    impl = _repository_static_check_impl,
    attrs = {
        "kind": attrs.enum(["format", "lint"]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "tool": attrs.exec_dep(providers = [BuckSupportToolInfo]),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/static-check-runner.ts",
        )),
    },
)


def _repository_policy_check_impl(ctx):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sources, source_tree = _collect_static_sources(ctx, "policy_source", False)
    manifest = ctx.actions.declare_output("policy_manifest.json")
    ctx.actions.write_json(manifest, {
        "declaredPackages": sorted(ctx.attrs.declared_packages),
        "sourcePaths": sorted(sources.keys()),
    })
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    ctx.actions.run(
        cmd_args([
            toolchain.bun,
            ctx.attrs._runner,
            "--manifest",
            manifest,
            "--source",
            source_tree,
            "--output",
            result.as_output(),
        ], hidden = [source_tree]),
        category = "repository_policy_check",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


_repository_policy_check = rule(
    impl = _repository_policy_check_impl,
    attrs = {
        "declared_packages": attrs.list(attrs.string()),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/repository-policy-runner.ts",
        )),
    },
)

def repository_static_checks(
        name,
        declared_packages,
        source_sets,
        **kwargs):
    """Checks formatting, lint, and source policy against one repository snapshot."""
    _repository_static_check(
        name = name + "_format",
        kind = "format",
        source_sets = source_sets,
        tool = "//buck2/toolchains:tool_oxfmt",
        **kwargs
    )
    _repository_static_check(
        name = name + "_lint",
        kind = "lint",
        source_sets = source_sets,
        tool = "//buck2/toolchains:tool_oxlint",
        **kwargs
    )
    _repository_policy_check(
        name = name + "_policy",
        declared_packages = declared_packages,
        source_sets = source_sets,
        **kwargs
    )
    native.filegroup(
        name = name,
        srcs = [
            ":" + name + "_format",
            ":" + name + "_lint",
            ":" + name + "_policy",
        ],
        **kwargs
    )
