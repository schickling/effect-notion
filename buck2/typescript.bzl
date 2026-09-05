"""Reusable effect-tsgo actions over a Buck-materialized package view.

The package view is the complete declared action input: package sources, tsconfig, and the
normalized importer dependency view. Producing that view belongs to the 03-materialization
boundary; these rules treat it as one opaque input and deliberately do not interpret the
non-authoritative TypeScript input-plan evidence.

No action copies, hashes, or recursively chmods the input. The pinned runner builds a
metadata-only overlay in `BUCK_SCRATCH_PATH` and executes tsgo inside the platform sandbox
(Bubblewrap on Linux, a parameterized Seatbelt profile on Darwin), which enforces read-only
inputs and tool closures, writable output and scratch only, no network, and an explicit
environment allowlist.

The action shape follows
context/buck2/02-execution/.experiments/2026-09-04-metadata-only-typescript-sandboxes.md.
"""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo", "SandboxToolchainInfo")

TsgoTypecheckInfo = provider(fields = {
    "toolchain_identity": str,
    "verdict": Artifact,
})

TsgoEmitInfo = provider(fields = {
    "directory": Artifact,
    "toolchain_identity": str,
})

SandboxProbeInfo = provider(fields = {
    "sandbox_identity": str,
    "verdict": Artifact,
})


def _require_relative_path(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if value.startswith("/"):
        fail("{} must be relative to package_tree: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _sandbox_args(toolchain, sandbox):
    """Sandbox selection, launcher, and read allowlist, as exact runner arguments.

    Every path is a normalized `/nix/store` path, and all of them enter the action command, so a
    tool, closure, or launcher change invalidates exactly the actions that consume it.
    """
    args = ["--sandbox", sandbox.kind]
    if sandbox.launcher:
        args += ["--sandbox-launcher", sandbox.launcher]
    closure = toolchain.closure_store_paths + sandbox.closure_store_paths
    for store_path in sorted({path: None for path in closure}):
        args += ["--tool-closure", store_path]
    for major in sandbox.darwin_kernel_majors:
        args += ["--darwin-kernel-major", major]
    return args


def _identity(toolchain, sandbox):
    return "{};sandbox={}".format(toolchain.identity, sandbox.identity)


def _tsgo_typecheck_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    sandbox = ctx.attrs._sandbox[SandboxToolchainInfo]
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
    args.add(_sandbox_args(toolchain, sandbox))
    ctx.actions.run(
        args,
        category = "tsgo_typecheck",
        identifier = ctx.attrs.name,
        # Placement is local because the tool closures are host Nix realizations, not CAS
        # inputs. That is orthogonal to reuse: the action key is complete, so the result is
        # uploaded to and read from the shared action cache.
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = verdict),
        TsgoTypecheckInfo(
            toolchain_identity = _identity(toolchain, sandbox),
            verdict = verdict,
        ),
    ]


tsgo_typecheck = rule(
    impl = _tsgo_typecheck_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "project": attrs.string(default = "tsconfig.json"),
        "_sandbox": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:typescript_sandbox",
            providers = [SandboxToolchainInfo],
        )),
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
    sandbox = ctx.attrs._sandbox[SandboxToolchainInfo]
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    directory = ctx.actions.declare_output(ctx.attrs.out_dir, dir = True)

    # The runner links `out_dir` inside its metadata-only overlay at this declared output, so
    # tsgo writes result bytes directly and nothing is staged or copied back. Build info is
    # redirected into scratch, so `.tsbuildinfo` never enters the dist or a cache upload.
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
    args.add(_sandbox_args(toolchain, sandbox))
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
            toolchain_identity = _identity(toolchain, sandbox),
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
        "_sandbox": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:typescript_sandbox",
            providers = [SandboxToolchainInfo],
        )),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)


def _sandbox_probe_impl(ctx):
    sandbox = ctx.attrs._sandbox[SandboxToolchainInfo]
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    if sandbox.kind == "none":
        fail("a containment probe requires an active sandbox on this execution platform")
    verdict = ctx.actions.declare_output("{}.probe".format(ctx.attrs.name))
    args = cmd_args([
        toolchain.bun,
        toolchain.runner,
        "probe",
        toolchain.bun,
        ctx.attrs.probe,
        ctx.attrs.target,
        ctx.attrs.expect,
        verdict.as_output(),
    ])
    args.add(_sandbox_args(toolchain, sandbox))
    action_environment = {}
    if ctx.attrs.probe == "env":
        action_environment[ctx.attrs.target] = "seeded-probe-value"
    ctx.actions.run(
        args,
        category = "sandbox_probe",
        identifier = ctx.attrs.name,
        env = action_environment,
        local_only = True,
        allow_cache_upload = False,
    )
    return [
        DefaultInfo(default_output = verdict),
        SandboxProbeInfo(sandbox_identity = sandbox.identity, verdict = verdict),
    ]


# One explicit containment observation made from inside a real action.
#
# Every denied probe first proves the target is available without sandbox enforcement. The
# in-sandbox program accepts only policy-shaped errno failures, never arbitrary target/tool errors.
# Sandbox launcher, closure, and Darwin-major arguments key the verdict to the executor policy;
# uploads remain disabled so a host gate is never imported from another executor.
sandbox_probe = rule(
    impl = _sandbox_probe_impl,
    attrs = {
        "expect": attrs.enum(["allowed", "denied"]),
        "probe": attrs.enum(["read", "write", "connect", "env", "stat", "exec"]),
        "target": attrs.string(),
        "_sandbox": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:typescript_sandbox",
            providers = [SandboxToolchainInfo],
        )),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)
