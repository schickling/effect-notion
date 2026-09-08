"""Reusable effect-tsgo actions over a Buck-materialized package view.

The package view and all normalized roots reachable through its links are the
complete declared action input. The pinned runner hashes every declared input
before and after execution so TypeScript actions remain write-free.
"""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

TsgoTypecheckInfo = provider(fields = {
    "toolchain_identity": str,
    "verdict": Artifact,
})

TsgoEmitInfo = provider(fields = {
    "directory": Artifact,
    "toolchain_identity": str,
})


def _require_relative_path(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if value.startswith("/"):
        fail("{} must be relative to package_tree: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _tsgo_typecheck_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    verdict = ctx.actions.declare_output("typecheck.ok")

    args = cmd_args([
        toolchain.bun,
        toolchain.runner,
        "typecheck",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.project,
        verdict.as_output(),
    ])
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    ctx.actions.run(
        args,
        category = "tsgo_typecheck",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = verdict),
        TsgoTypecheckInfo(
            toolchain_identity = toolchain.identity,
            verdict = verdict,
        ),
    ]


tsgo_typecheck = rule(
    impl = _tsgo_typecheck_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "project": attrs.string(default = "tsconfig.json"),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)


def _tsgo_emit_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    _require_relative_path(ctx.attrs.out_dir, "out_dir")
    _require_relative_path(ctx.attrs.declaration_entrypoint, "declaration_entrypoint")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    directory = ctx.actions.declare_output(ctx.attrs.out_dir, dir = True)

    args = cmd_args([
        toolchain.bun,
        toolchain.runner,
        "emit",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.project,
        ctx.attrs.out_dir,
        ctx.attrs.declaration_entrypoint,
        directory.as_output(),
    ])
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for declaration_path in sorted(ctx.attrs.declaration_sources.keys()):
        _require_relative_path(declaration_path, "declaration source")
        args.add("--copy-declaration", declaration_path)
    args.add(cmd_args(hidden = ctx.attrs.declaration_sources.values()))
    ctx.actions.run(
        args,
        category = "tsgo_emit",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = directory),
        TsgoEmitInfo(
            directory = directory,
            toolchain_identity = toolchain.identity,
        ),
    ]


tsgo_emit = rule(
    impl = _tsgo_emit_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "project": attrs.string(default = "tsconfig.json"),
        "out_dir": attrs.string(default = "dist"),
        "declaration_entrypoint": attrs.string(default = "src/mod.d.ts"),
        "declaration_sources": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)
