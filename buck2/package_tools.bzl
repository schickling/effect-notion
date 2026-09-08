"""Package-local JavaScript check, build, and launch rules."""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

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


def _runner_args(ctx, mode, output = None):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    args = cmd_args([
        toolchain.executable,
        ctx.attrs._runner,
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
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts",
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
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts",
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
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts",
        )),
    },
)
