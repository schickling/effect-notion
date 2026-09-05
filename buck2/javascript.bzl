"""Pinned-Bun executable and test rules over one declared package view.

The package tree and its normalized read roots are the complete JavaScript dependency input.
Commands execute locally because Nix tool closures are host realizations, while deterministic test
results opt into Buck's shared test cache. The runner applies the same platform sandbox contract as
TypeScript: explicit read roots, scratch-only writes, no network, and a cleared environment.
"""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo", "SandboxToolchainInfo")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")

JavaScriptExecutableInfo = provider(fields = {
    "package_tree": Artifact,
    "toolchain_identity": str,
})


def _require_relative_path(value, field):
    if not value or value.startswith("/"):
        fail("{} must be relative to package_tree: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _sandbox_args(toolchain, sandbox, tool_closure):
    args = ["--sandbox", sandbox.kind]
    if sandbox.launcher:
        args += ["--sandbox-launcher", sandbox.launcher]
    closure = toolchain.closure_store_paths + sandbox.closure_store_paths + tool_closure
    for store_path in sorted({path: None for path in closure}):
        args += ["--tool-closure", store_path]
    for major in sandbox.darwin_kernel_majors:
        args += ["--darwin-kernel-major", major]
    return args


# One attested capability per declared environment name. The exact executable becomes the value of
# that name, and the capability's complete `closureStorePaths` join the sandbox read roots: an
# executable bound without the libraries it links against is not runnable.
def _tool_args(ctx, args):
    closure = []
    for name in sorted(ctx.attrs.tools.keys()):
        tool = ctx.attrs.tools[name][BuckSupportToolInfo]
        args.add("--external-path", name, tool.store_path)
        args.add(cmd_args(hidden = [tool.executable, tool.manifest]))
        closure += tool.closure_store_paths
    return closure


# Capabilities that name a host service rather than a declared input. Containment exists to remove
# exactly these, so a lane that needs one cannot be repaired by binding more read roots: it must
# say so and move to the explicit no-containment executor.
HOST_SERVICE_CAPABILITIES = ["loopback", "network", "nix-daemon", "pty"]


def _host_service_capabilities(ctx):
    return sorted([
        capability
        for capability in ctx.attrs.capabilities
        if capability in HOST_SERVICE_CAPABILITIES
    ])


# The executor is chosen by the declared mode alone, never inferred from the capability set: an
# undeclared host-service capability must fail analysis instead of silently disabling containment.
def _execution_sandbox(ctx):
    host_services = _host_service_capabilities(ctx)
    if ctx.attrs.execution_mode == "sandboxed":
        if host_services:
            fail("capabilities {} require execution_mode = \"unsandboxed-local\"".format(
                ", ".join(host_services),
            ))
        return ctx.attrs._sandbox[SandboxToolchainInfo]
    if not host_services:
        fail("execution_mode = \"unsandboxed-local\" requires a declared host-service capability ({})".format(
            ", ".join(HOST_SERVICE_CAPABILITIES),
        ))
    sandbox = ctx.attrs._unsandboxed[SandboxToolchainInfo]
    if sandbox.kind != "none":
        fail("the unsandboxed local executor must resolve to no containment, not {}".format(sandbox.kind))
    return sandbox


def _configured_args(ctx, command, positional):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sandbox = _execution_sandbox(ctx)
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    runner_tree = ctx.attrs._runner[DefaultInfo].default_outputs[0]
    args = cmd_args([
        toolchain.bun,
        cmd_args(runner_tree, format = "{}/javascript-runner.ts"),
        command,
        toolchain.bun,
        package_tree.tree,
        positional,
    ])
    for test in ctx.attrs.test_files:
        _require_relative_path(test, "test")
        args.add("--test", test)
    for exclude in ctx.attrs.excludes:
        _require_relative_path(exclude, "exclude")
        args.add("--exclude", exclude)
    for name in sorted(ctx.attrs.env.keys()):
        args.add("--env", name, ctx.attrs.env[name])
    for name in sorted(ctx.attrs.external_inputs.keys()):
        args.add("--input", name, ctx.attrs.external_inputs[name])
    for name in sorted(ctx.attrs.configured_external_inputs.keys()):
        value = ctx.attrs.configured_external_inputs[name]
        if not value:
            fail("missing [test_capabilities] value for {}".format(name))
        args.add("--external-path", name, value)
    for name in sorted(ctx.attrs.inherited_env):
        args.add("--inherit-env", name)
    for name in sorted(ctx.attrs.writable_directories.keys()):
        args.add("--writable-directory", name, ctx.attrs.writable_directories[name])
    for capability in sorted(ctx.attrs.capabilities):
        args.add("--capability", capability)
    args.add("--execution-mode", ctx.attrs.execution_mode)
    if command == "vitest":
        args.add("--vitest-runtime", ctx.attrs.vitest_runtime)
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    args.add(_sandbox_args(toolchain, sandbox, _tool_args(ctx, args)))
    args.add(cmd_args(hidden = ctx.attrs.external_inputs.values()))
    return args, package_tree, toolchain, sandbox


def _bun_executable_impl(ctx):
    _require_relative_path(ctx.attrs.entrypoint, "entrypoint")
    args, package_tree, toolchain, sandbox = _configured_args(
        ctx,
        "exec",
        [ctx.attrs.entrypoint, "--"] + ctx.attrs.args,
    )
    return [
        DefaultInfo(),
        RunInfo(args = args),
        JavaScriptExecutableInfo(
            package_tree = package_tree.tree,
            toolchain_identity = "{};sandbox={}".format(toolchain.identity, sandbox.identity),
        ),
    ]


bun_executable = rule(
    impl = _bun_executable_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "external_inputs": attrs.dict(key = attrs.string(), value = attrs.source(), default = {}),
        "configured_external_inputs": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "tools": attrs.dict(
            key = attrs.string(),
            value = attrs.exec_dep(providers = [BuckSupportToolInfo]),
            default = {},
        ),
        "inherited_env": attrs.list(attrs.string(), default = []),
        "writable_directories": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "capabilities": attrs.list(attrs.enum(["network", "loopback", "nix-daemon", "pty", "subprocess"]), default = []),
        "execution_mode": attrs.enum(["sandboxed", "unsandboxed-local"], default = "sandboxed"),
        "test_files": attrs.list(attrs.string(), default = []),
        "excludes": attrs.list(attrs.string(), default = []),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:javascript_action_runtime",
            providers = [DefaultInfo],
        )),
        "_sandbox": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:typescript_sandbox",
            providers = [SandboxToolchainInfo],
        )),
        "_unsandboxed": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:unsandboxed_local_executor",
            providers = [SandboxToolchainInfo],
        )),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)


def _test_info(ctx, command, positional):
    args, _, _, _ = _configured_args(ctx, command, positional)
    cacheable = ctx.attrs.cacheable
    if (ctx.attrs.inherited_env or "network" in ctx.attrs.capabilities) and ctx.attrs.cacheable:
        fail("inherited environment and network tests must set cacheable = False")
    if ctx.attrs.execution_mode == "unsandboxed-local" and ctx.attrs.cacheable:
        fail("an unsandboxed local test lane must set cacheable = False")
    return [
        DefaultInfo(),
        RunInfo(args = args),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [args],
            env = {},
            labels = ctx.attrs.labels,
            contacts = ctx.attrs.contacts,
            default_executor = CommandExecutorConfig(
                local_enabled = True,
                remote_enabled = False,
                remote_cache_enabled = cacheable,
                allow_cache_uploads = cacheable,
            ),
            run_from_project_root = False,
            use_project_relative_paths = False,
            supports_test_execution_caching = cacheable,
        ),
    ]


def _vitest_test_impl(ctx):
    _require_relative_path(ctx.attrs.config, "config")
    if ctx.attrs.vitest_runtime == "node" and "NODE_BIN" not in ctx.attrs.tools:
        fail("vitest_runtime = \"node\" requires a declared NODE_BIN tool")
    return _test_info(ctx, "vitest", [
        ctx.attrs.config,
        str(ctx.attrs.timeout_ms),
        str(ctx.attrs.hook_timeout_ms),
    ])


_TEST_ATTRS = {
    "package_tree": attrs.dep(providers = [PackageTreeInfo]),
    "test_files": attrs.list(attrs.string(), default = []),
    "excludes": attrs.list(attrs.string(), default = []),
    "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {"CI": "true"}),
    "external_inputs": attrs.dict(key = attrs.string(), value = attrs.source(), default = {}),
    "configured_external_inputs": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
    "tools": attrs.dict(
        key = attrs.string(),
        value = attrs.exec_dep(providers = [BuckSupportToolInfo]),
        default = {},
    ),
    "inherited_env": attrs.list(attrs.string(), default = []),
    "writable_directories": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
    "capabilities": attrs.list(attrs.enum(["network", "loopback", "nix-daemon", "pty", "subprocess"]), default = []),
    "execution_mode": attrs.enum(["sandboxed", "unsandboxed-local"], default = "sandboxed"),
    "cacheable": attrs.bool(default = True),
    "labels": attrs.list(attrs.string(), default = []),
    "contacts": attrs.list(attrs.string(), default = []),
    "_runner": attrs.default_only(attrs.dep(
        default = "//packages/@overeng/buck2-tools:javascript_action_runtime",
        providers = [DefaultInfo],
    )),
    "_sandbox": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:typescript_sandbox",
        providers = [SandboxToolchainInfo],
    )),
    "_unsandboxed": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:unsandboxed_local_executor",
        providers = [SandboxToolchainInfo],
    )),
    "_javascript": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:effect_tsgo",
        providers = [EffectTsgoToolchainInfo],
    )),
}

_VITEST_TEST_ATTRS = dict(_TEST_ATTRS)
_VITEST_TEST_ATTRS.update({
    "config": attrs.string(default = "vitest.config.ts"),
    "timeout_ms": attrs.int(default = 30000),
    "hook_timeout_ms": attrs.int(default = 30000),
    # Which runtime evaluates the suite. Pinned Bun is the default; `node` exists for a suite
    # whose native addon is only correct on Node's libuv loop (in-process `node-pty` reads).
    # `node` requires the lane to declare the `NODE_BIN` tool, which names the exact executable.
    "vitest_runtime": attrs.enum(["bun", "node"], default = "bun"),
})

# Test-ness comes from the returned `ExternalRunnerTestInfo`, which is what `buck2 test` consumes.
vitest_test = rule(
    impl = _vitest_test_impl,
    attrs = _VITEST_TEST_ATTRS,
)


def _bun_test_impl(ctx):
    return _test_info(ctx, "bun-test", [str(ctx.attrs.timeout_ms)])


_BUN_TEST_ATTRS = dict(_TEST_ATTRS)
_BUN_TEST_ATTRS.update({
    "timeout_ms": attrs.int(default = 30000),
})

bun_test = rule(
    impl = _bun_test_impl,
    attrs = _BUN_TEST_ATTRS,
)


def _shell_tests_impl(ctx):
    return _test_info(ctx, "shell-tests", [str(ctx.attrs.timeout_ms)])


_SHELL_TEST_ATTRS = dict(_TEST_ATTRS)
_SHELL_TEST_ATTRS.update({
    "timeout_ms": attrs.int(default = 300000),
})

shell_tests = rule(
    impl = _shell_tests_impl,
    attrs = _SHELL_TEST_ATTRS,
)
