"""Typed Buck products for package-local JavaScript tools without ambient `.bin` lookup."""

load("//.buck2/capabilities:defs.bzl", "CAPABILITIES", "GENERATION")
load("//buck2/dependencies:defs.bzl", "PnpmPlatformGatedPackagesInfo")
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/platforms:defs.bzl", "PortableProductPlatformInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo", "host_capability_platform", "require_capability")

JavaScriptModuleInfo = provider(fields = {
    "artifact": Artifact,
    "dependency_closure_identity": str,
    "descriptor": Artifact,
    "external_capabilities": list[str],
    "module_path": str,
    "product_kind": str,
    "runtime_kind": str,
    "target_identity": str,
})
PackageCheckInfo = provider(fields = {
    "descriptor": Artifact,
    "external_capabilities": list[str],
    "verdict": Artifact,
})


JavaScriptLaunchInfo = provider(fields = {
    "args": list[str],
    "descriptor": Artifact,
    "entrypoint": str,
    "env": dict[str, str],
    "executable": provider_field(RunInfo),
    "external_capabilities": list[str],
    "port": int,
    "process_kind": str,
    "runtime_kind": str,
})

NodeLaunchInfo = provider(fields = {
    "descriptor": Artifact,
    "entrypoint": str,
    "executable": provider_field(RunInfo),
    "external_capabilities": list[str],
    "module": provider_field(JavaScriptModuleInfo),
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
    for value in ctx.attrs.args:
        args.add("--arg", value)
    args.add(cmd_args(hidden = package_tree.read_roots))
    for key, value in sorted(ctx.attrs.env.items()):
        args.add("--env", "{}={}".format(key, value))

    # `buck2 run <target> -- ...` appends the caller's arguments verbatim to the
    # `RunInfo` argv. Ending the launcher's own encoded configuration with the
    # runtime-argv delimiter keeps those trailing arguments addressed to the
    # entrypoint, so a flag-shaped argument such as `--repo-root` is never read
    # as launcher configuration. Only `exec` launches a program with a caller
    # command line; the output-producing modes keep their closed argv.
    if mode == "exec":
        args.add("--")
    return args

def _package_check_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    verdict = ctx.actions.declare_output("check.ok")
    descriptor = ctx.actions.declare_output("check.json")
    args = _runner_args(ctx, "check", verdict)
    ctx.actions.run(args, category = "package_bin_check", local_only = True, allow_cache_upload = False)
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/package-check/v1",
        "entrypoint": ctx.attrs.entrypoint,
        "externalCapabilities": ctx.attrs.external_capabilities,
    })
    return [
        DefaultInfo(default_output = verdict, other_outputs = [descriptor], sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]}),
        PackageCheckInfo(descriptor = descriptor, external_capabilities = ctx.attrs.external_capabilities, verdict = verdict),
    ]


package_bin_check = rule(
    impl = _package_check_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "external_capabilities": attrs.list(attrs.string(), default = []),
        "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
        "_runner": attrs.default_only(attrs.source(default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts")),
    },
)

def _package_build_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    output = ctx.actions.declare_output(ctx.attrs.output, dir = True)
    args = _runner_args(ctx, "build-dir", output)
    ctx.actions.run(args, category = "package_bin_build", local_only = True, allow_cache_upload = False)
    return [DefaultInfo(default_output = output)]

package_bin_build = rule(
    impl = _package_build_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string()),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "output": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
        "_runner": attrs.default_only(attrs.source(default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts")),
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
        "externalCapabilities": ctx.attrs.external_capabilities,
    })
    info = JavaScriptLaunchInfo(
        args = ctx.attrs.args,
        descriptor = descriptor,
        entrypoint = ctx.attrs.entrypoint,
        env = ctx.attrs.env,
        executable = executable,
        external_capabilities = ctx.attrs.external_capabilities,
        port = ctx.attrs.port,
        process_kind = ctx.attrs.process_kind,
        runtime_kind = "bun",
    )
    return [
        DefaultInfo(default_output = descriptor, sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]}),
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
        "external_capabilities": attrs.list(attrs.string(), default = []),
        "process_kind": attrs.enum(["one-shot", "long-lived"], default = "one-shot"),
        "port": attrs.int(default = 0),
        "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
        "_runner": attrs.default_only(attrs.source(default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts")),
    },
)

def _closure_root_name(artifact):
    """One configuration-free logical name for a declared closure root.

    The farm a bundle is built from is keyed by these names, and they end up
    inside the product bytes as module-comment paths. They are derived from the
    owning label alone: a buck-out path would carry the producer's checkout
    layout and configured-platform hash into every product.
    """
    owner = artifact.owner
    if owner == None:
        fail("closure root {} has no owning target".format(artifact))
    return "{}/{}/{}/{}".format(owner.cell, owner.package, owner.name, artifact.short_path)

def _package_bundle_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    platform = ctx.attrs._portable_platform[PortableProductPlatformInfo]
    gated = ctx.attrs._platform_gated_packages[PnpmPlatformGatedPackagesInfo]
    artifact = ctx.actions.declare_output(ctx.attrs.output)
    descriptor = ctx.actions.declare_output("module.json")
    closure_identity = "{};{}".format(toolchain.identity, ctx.attrs.package_tree.label)
    args = cmd_args([
        toolchain.executable,
        ctx.attrs._runner,
        "bundle",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.entrypoint,
        artifact.as_output(),
        "--target",
        ctx.attrs.target,
        "--kind",
        ctx.attrs.kind,
        "--descriptor",
        descriptor.as_output(),
        "--closure-identity",
        closure_identity,
        "--target-identity",
        "{}//{}:{}".format(ctx.label.cell, ctx.label.package, ctx.label.name),
        "--runtime-contract",
        platform.runtime_contract,
        "--runtime-contract-version",
        platform.runtime_contract_version,
        "--platform-gated-manifest",
        gated.manifest,
    ])
    for external in ctx.attrs.external:
        args.add("--external", external)
    for capability in ctx.attrs.external_capabilities:
        args.add("--external-capability", capability)
    # Every declared root the tree's symlinks may resolve into, named by its
    # own label so the farm can rewrite those links without ever reading an
    # absolute path out of the producer's filesystem. Root zero is the tree
    # itself, which becomes the farm root.
    for read_root in package_tree.read_roots[1:]:
        args.add("--closure-root", cmd_args(read_root, format = _closure_root_name(read_root) + "\t{}"))
    args.add(cmd_args(hidden = package_tree.read_roots))
    ctx.actions.run(args, category = "package_bin_bundle", local_only = True, allow_cache_upload = False)
    info = JavaScriptModuleInfo(
        artifact = artifact,
        dependency_closure_identity = closure_identity,
        descriptor = descriptor,
        external_capabilities = ctx.attrs.external_capabilities,
        module_path = ctx.attrs.output,
        product_kind = ctx.attrs.kind,
        runtime_kind = ctx.attrs.target,
        target_identity = "{}//{}:{}".format(ctx.label.cell, ctx.label.package, ctx.label.name),
    )
    return [
        DefaultInfo(default_output = artifact, other_outputs = [descriptor], sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]}),
        info,
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
        "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
        "_platform_gated_packages": attrs.default_only(attrs.dep(
            default = "//buck2/dependencies:platform_gated_packages",
            providers = [PnpmPlatformGatedPackagesInfo],
        )),
        "_portable_platform": attrs.default_only(attrs.dep(
            default = "//buck2/platforms:javascript_portable",
            providers = [PortableProductPlatformInfo],
        )),
        "_runner": attrs.default_only(attrs.source(default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts")),
    },
)

# Every JavaScript module product is CONFIGURED portable, so its package tree
# and the dependency store beneath it resolve the platform-invariant package
# set. The execution platform stays host-specific — Bun runs on this machine —
# so this buys byte-identical products, not cross-platform action-cache reuse.
def package_bin_artifact(name, **kwargs):
    _package_bin_artifact(
        name = name,
        default_target_platform = "//buck2/platforms:javascript_portable",
        **kwargs
    )

def _node_package_bin_impl(ctx):
    module = ctx.attrs.module[JavaScriptModuleInfo]
    if module.runtime_kind != "node":
        fail("node_package_bin requires a node-target JavaScript module")
    node = ctx.attrs.node
    command = RunInfo(args = cmd_args([node, module.artifact] + ctx.attrs.args))
    descriptor = ctx.actions.declare_output("launch.json")
    capabilities = sorted({capability: None for capability in module.external_capabilities + ctx.attrs.external_capabilities}.keys())
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/javascript-launch/v1",
        "runtimeKind": "node",
        "entrypoint": module.module_path,
        "args": ctx.attrs.args,
        "env": ctx.attrs.env,
        "moduleDescriptor": module.module_path + "[descriptor]",
        "dependencyClosureIdentity": module.dependency_closure_identity,
        "externalCapabilities": capabilities,
    })
    info = NodeLaunchInfo(
        descriptor = descriptor,
        entrypoint = module.module_path,
        executable = command,
        external_capabilities = capabilities,
        module = module,
    )
    return [DefaultInfo(default_output = descriptor, other_outputs = [module.artifact, module.descriptor], sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]}), command, info]

_node_package_bin = rule(
    impl = _node_package_bin_impl,
    attrs = {
        "module": attrs.dep(providers = [JavaScriptModuleInfo]),
        "node": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "external_capabilities": attrs.list(attrs.string(), default = []),
    },
)

def node_package_bin(name, module, args = [], env = {}, external_capabilities = [], **kwargs):
    platform = host_capability_platform()
    node = require_capability(CAPABILITIES, GENERATION, platform, "node")["executableStorePath"]
    # Configured portable so the module it wraps is the SAME configured target
    # the product publishes, not a second host-configured build of it.
    _node_package_bin(
        name = name,
        module = module,
        node = node,
        args = args,
        env = env,
        external_capabilities = external_capabilities,
        default_target_platform = "//buck2/platforms:javascript_portable",
        **kwargs
    )

def _type_aware_oxlint_impl(ctx):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    verdict = ctx.actions.declare_output("oxlint.ok")
    args = cmd_args([
        toolchain.executable,
        ctx.attrs._runner,
        "native-check",
        ctx.attrs.oxlint,
        package_tree.tree,
        ctx.attrs.config,
        verdict.as_output(),
        "--arg",
        "--type-aware",
        "--arg",
        "--config",
        "--arg",
        ctx.attrs.config,
        "--arg",
        "{TREE}",
    ])
    ctx.actions.run(args, category = "type_aware_oxlint", local_only = True, allow_cache_upload = False)
    return [DefaultInfo(default_output = verdict)]

_type_aware_oxlint = rule(
    impl = _type_aware_oxlint_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "config": attrs.string(default = ".oxlintrc.json"),
        "oxlint": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
        "_runner": attrs.default_only(attrs.source(default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts")),
    },
)

def type_aware_oxlint(name, package_tree, config = ".oxlintrc.json", **kwargs):
    platform = host_capability_platform()
    oxlint = require_capability(CAPABILITIES, GENERATION, platform, "oxlint")["executableStorePath"]
    _type_aware_oxlint(name = name, package_tree = package_tree, config = config, oxlint = oxlint, **kwargs)

def storybook_candidates(name, package_tree, port, visibility = ["PUBLIC"]):
    entrypoint = "node_modules/storybook/dist/bin/dispatcher.js"
    package_bin_build(name = name + "_build_candidate", package_tree = package_tree, entrypoint = entrypoint, args = ["build", "--output-dir", "{OUT}"], output = "storybook-static", visibility = visibility)
    package_bin(name = name + "_dev_candidate", package_tree = package_tree, entrypoint = entrypoint, args = ["dev", "-p", str(port)], port = port, process_kind = "long-lived", visibility = visibility)
