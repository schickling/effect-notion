"""Package-local JavaScript check, build, and launch rules."""

load("//buck2/dependencies:defs.bzl", "PnpmPlatformGatedPackagesInfo")
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")
JavaScriptModuleInfo = provider(fields = {
    "module": Artifact,
    "descriptor": Artifact,
    "dependency_closure_identity": str,
})



PackageCheckInfo = provider(fields = {
    "descriptor": Artifact,
    "verdict": Artifact,
})

JavaScriptLaunchInfo = provider(fields = {
    "args": list[str],
    "descriptor": Artifact,
    "entrypoint": str,
    "env": dict[str, str],
    "executable": provider_field(RunInfo),
    "port": int,
    "process_kind": str,
    "runtime_kind": str,
})


def _relative(value, field):
    if not value or value.startswith("/") or "\\" in value:
        fail("{} must be a normalized relative path: {}".format(field, value))
    for part in value.split("/"):
        if part in ["", ".", ".."]:
            fail("{} must be a normalized relative path: {}".format(field, value))

def _runner(ctx):
    return cmd_args(
        ctx.attrs._runner[DefaultInfo].default_outputs[0],
        format = "{}/package-command-runner.ts",
    )


def _runner_args(ctx, mode, output = None):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    args = cmd_args([
        toolchain.executable,
        _runner(ctx),
        mode,
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.entrypoint,
        output.as_output() if output else "-",
    ])
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for value in ctx.attrs.args:
        args.add("--arg", value)
    for key, value in sorted(ctx.attrs.env.items()):
        args.add("--env", "{}={}".format(key, value))

    # Arguments appended by `buck2 run <target> -- ...` belong to the launched
    # entrypoint, never to this runner's encoded configuration.
    if mode == "exec":
        args.add("--")
    return args


def _package_check_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    verdict = ctx.actions.declare_output("check.ok")
    descriptor = ctx.actions.declare_output("check.json")
    args = _runner_args(ctx, "check", verdict)
    ctx.actions.run(
        args,
        category = "package_bin_check",
        local_only = True,
        allow_cache_upload = False,
    )
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/package-check/v1",
        "entrypoint": ctx.attrs.entrypoint,
    })
    return [
        DefaultInfo(
            default_output = verdict,
            other_outputs = [descriptor],
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        PackageCheckInfo(descriptor = descriptor, verdict = verdict),
    ]


package_bin_check = rule(
    impl = _package_check_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//:package_command_runtime",
            providers = [DefaultInfo],
        )),
    },
)


def _package_build_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    output = ctx.actions.declare_output(ctx.attrs.output, dir = True)
    args = _runner_args(ctx, "build-dir", output)
    ctx.actions.run(
        args,
        category = "package_bin_build",
        local_only = True,
        allow_cache_upload = False,
    )
    return [DefaultInfo(default_output = output)]


package_bin_build = rule(
    impl = _package_build_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string()),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "output": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//:package_command_runtime",
            providers = [DefaultInfo],
        )),
    },
)


def _package_launch_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    executable = RunInfo(args = _runner_args(ctx, "exec"))
    descriptor = ctx.actions.declare_output("launch.json")
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/javascript-launch/v1",
        "runtimeKind": "bun",
        "entrypoint": ctx.attrs.entrypoint,
        "args": ctx.attrs.args,
        "env": ctx.attrs.env,
        "inheritsEnvironment": True,
        "processKind": ctx.attrs.process_kind,
        "port": ctx.attrs.port if ctx.attrs.port > 0 else None,
        "dependencyClosureIdentity": "{};{}".format(toolchain.identity, ctx.attrs.package_tree.label),
    })
    info = JavaScriptLaunchInfo(
        args = ctx.attrs.args,
        descriptor = descriptor,
        entrypoint = ctx.attrs.entrypoint,
        env = ctx.attrs.env,
        executable = executable,
        port = ctx.attrs.port,
        process_kind = ctx.attrs.process_kind,
        runtime_kind = "bun",
    )
    return [
        DefaultInfo(
            default_output = descriptor,
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        executable,
        info,
    ]


package_bin = rule(
    impl = _package_launch_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "process_kind": attrs.enum(["one-shot", "long-lived"], default = "one-shot"),
        "port": attrs.int(default = 0),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//:package_command_runtime",
            providers = [DefaultInfo],
        )),
    },
)


def _closure_root_name(artifact):
    """Return a configuration-free name for one declared package-tree root."""
    owner = artifact.owner
    if owner == None:
        fail("closure root {} has no owning target".format(artifact))
    return "{}/{}/{}/{}".format(owner.cell, owner.package, owner.name, artifact.short_path)


def _package_bundle_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    _relative(ctx.attrs.output, "output")
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    gated = ctx.attrs._platform_gated_packages[PnpmPlatformGatedPackagesInfo]
    module = ctx.actions.declare_output(ctx.attrs.output)
    descriptor = ctx.actions.declare_output("module.json")
    target_identity = "{}//{}:{}".format(ctx.label.cell, ctx.label.package, ctx.label.name)
    dependency_closure_identity = "runtime={};package_tree={}".format(
        ctx.attrs.target,
        ctx.attrs.package_tree.label,
    )
    args = cmd_args([
        toolchain.executable,
        _runner(ctx),
        "bundle",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.entrypoint,
        module.as_output(),
        "--target",
        ctx.attrs.target,
        "--kind",
        ctx.attrs.kind,
        "--descriptor",
        descriptor.as_output(),
        "--target-identity",
        target_identity,
        "--runtime-contract",
        "javascript-esm",
        "--runtime-contract-version",
        "v1",
        "--platform-gated-manifest",
        gated.manifest,
    ])
    for external in ctx.attrs.external:
        args.add("--external", external)
    for capability in ctx.attrs.external_capabilities:
        args.add("--external-capability", capability)
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for read_root in package_tree.read_roots[1:]:
        args.add("--closure-root", cmd_args(
            read_root,
            format = _closure_root_name(read_root) + "\t{}",
        ))
    args.add(cmd_args(hidden = package_tree.read_roots))
    ctx.actions.run(
        args,
        category = "package_bin_artifact",
        local_only = True,
        allow_cache_upload = False,
    )
    return [
        DefaultInfo(
            default_output = module,
            other_outputs = [descriptor],
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        JavaScriptModuleInfo(
            module = module,
            descriptor = descriptor,
            dependency_closure_identity = dependency_closure_identity,
        ),
    ]


_package_bin_artifact = rule(
    impl = _package_bundle_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "output": attrs.string(),
        "target": attrs.enum(["bun", "node"], default = "node"),
        "kind": attrs.enum(["cli", "module"], default = "module"),
        "external": attrs.list(attrs.string(), default = []),
        "external_capabilities": attrs.list(attrs.string(), default = []),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_platform_gated_packages": attrs.default_only(attrs.dep(
            default = "//buck2/dependencies:platform_gated_packages",
            providers = [PnpmPlatformGatedPackagesInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//:package_command_runtime",
            providers = [DefaultInfo],
        )),
    },
)


def package_bin_artifact(name, **kwargs):
    _package_bin_artifact(
        name = name,
        default_target_platform = "//buck2/platforms:javascript_portable",
        **kwargs
    )
