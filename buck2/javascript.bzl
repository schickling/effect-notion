"""Pinned-Bun executable and test rules over one declared package view.

The package tree and its normalized read roots are the complete declared JavaScript
input. The runner hashes all declared inputs before and after execution.
"""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")
load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")

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


def _tool_args(ctx, args):
    for name in sorted(ctx.attrs.tools.keys()):
        tool = ctx.attrs.tools[name][BuckSupportToolInfo]
        args.add("--external-path", name, tool.store_path)
        args.add(cmd_args(hidden = [tool.executable, tool.manifest]))


def _configured_args(ctx, command, positional):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
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
            fail("missing configured external input value for {}".format(name))
        args.add("--external-path", name, value)
    for name in sorted(ctx.attrs.inherited_env):
        args.add("--inherit-env", name)
    for name in sorted(ctx.attrs.writable_directories.keys()):
        args.add("--writable-directory", name, ctx.attrs.writable_directories[name])
    if command == "vitest" or command == "vitest-collect":
        args.add("--vitest-runtime", ctx.attrs.vitest_runtime)
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    _tool_args(ctx, args)
    args.add(cmd_args(hidden = ctx.attrs.external_inputs.values()))
    return args, package_tree, toolchain


def _bun_executable_impl(ctx):
    _require_relative_path(ctx.attrs.entrypoint, "entrypoint")
    args, package_tree, toolchain = _configured_args(
        ctx,
        "exec",
        [ctx.attrs.entrypoint, "--"] + ctx.attrs.args,
    )
    return [
        DefaultInfo(),
        RunInfo(args = args),
        JavaScriptExecutableInfo(
            package_tree = package_tree.tree,
            toolchain_identity = toolchain.identity,
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
        "test_files": attrs.list(attrs.string(), default = []),
        "excludes": attrs.list(attrs.string(), default = []),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:javascript_action_runtime",
            providers = [DefaultInfo],
        )),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)


def _test_info(ctx, command, positional):
    args, _, _ = _configured_args(ctx, command, positional)
    if ctx.attrs.inherited_env and ctx.attrs.cacheable:
        fail("tests inheriting the environment must set cacheable = False")
    cache_enabled = ctx.attrs.cacheable and root_remote_cache_enabled()
    cache_uploads = ctx.attrs.cacheable and root_allow_cache_uploads()
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
                remote_cache_enabled = cache_enabled,
                allow_cache_uploads = cache_uploads,
            ),
            run_from_project_root = False,
            use_project_relative_paths = False,
            supports_test_execution_caching = cache_enabled,
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
    "cacheable": attrs.bool(default = True),
    "labels": attrs.list(attrs.string(), default = []),
    "contacts": attrs.list(attrs.string(), default = []),
    "_runner": attrs.default_only(attrs.dep(
        default = "//packages/@overeng/buck2-tools:javascript_action_runtime",
        providers = [DefaultInfo],
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
    "vitest_runtime": attrs.enum(["bun", "node"], default = "bun"),
})

vitest_test = rule(
    impl = _vitest_test_impl,
    attrs = _VITEST_TEST_ATTRS,
)


def _vitest_collect_impl(ctx):
    """Produces one declared collection artifact for a Vitest lane."""
    _require_relative_path(ctx.attrs.config, "config")
    if ctx.attrs.vitest_runtime == "node" and "NODE_BIN" not in ctx.attrs.tools:
        fail("vitest_runtime = \"node\" requires a declared NODE_BIN tool")

    # `_configured_args` puts only the NAMES of inherited variables in the
    # action command while the runner reads their live values, so those values
    # are outside the action identity: a collection produced under one
    # environment would be served again after they change, yielding a stale
    # test inventory. Same invariant as `_test_info`.
    if ctx.attrs.inherited_env and ctx.attrs.cacheable:
        fail("collections inheriting the environment must set cacheable = False")
    collection = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    args, _, _ = _configured_args(ctx, "vitest-collect", [ctx.attrs.config])
    args.add("--collect-output", collection.as_output())
    ctx.actions.run(
        args,
        category = "vitest_collect",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = ctx.attrs.cacheable,
    )
    return [DefaultInfo(default_output = collection)]


_VITEST_COLLECT_ATTRS = dict(_TEST_ATTRS)
_VITEST_COLLECT_ATTRS.update({
    "config": attrs.string(default = "vitest.config.ts"),
    "vitest_runtime": attrs.enum(["bun", "node"], default = "bun"),
})

vitest_collect = rule(
    impl = _vitest_collect_impl,
    attrs = _VITEST_COLLECT_ATTRS,
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
