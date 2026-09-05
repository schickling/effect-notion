"""Typed deployable products built from declared JavaScript package views.

A product's identity is semantic and platform-invariant: what it is, which
runtime contract it satisfies, which bytes it is, and which capabilities its
host must supply. The producer's Nix store paths and configured target are
recorded as provenance and are never compared by a consumer, because they are
facts about the machine that built the product rather than about the product.
"""

load("//buck2:package_tools.bzl", "JavaScriptModuleInfo", "NodeLaunchInfo")
load("//buck2/platforms:defs.bzl", "PortableProductPlatformInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

_PRODUCT_ATTRS = {
    "product_name": attrs.string(),
    "_bun": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:bun",
        providers = [BunToolchainInfo],
    )),
    "_portable_platform": attrs.default_only(attrs.dep(
        default = "//buck2/platforms:javascript_portable",
        providers = [PortableProductPlatformInfo],
    )),
    "_runner": attrs.default_only(attrs.source(
        default = "//packages/@overeng/buck2-tools:src/package-command-runner.ts",
    )),
}

def _product_descriptor(ctx, module, product_kind):
    """Projects one module descriptor into the product's semantic descriptor.

    The projection is an action, not analysis: integrity and size are part of a
    product's identity and only exist once its bytes do.
    """
    platform = ctx.attrs._portable_platform[PortableProductPlatformInfo]
    if not ctx.attrs.product_name:
        fail("product_name must not be empty")
    descriptor = ctx.actions.declare_output("product.json")
    ctx.actions.run(
        cmd_args([
            ctx.attrs._bun[BunToolchainInfo].executable,
            ctx.attrs._runner,
            "product-descriptor",
            "--module-descriptor",
            module.descriptor,
            "--descriptor",
            descriptor.as_output(),
            "--product-name",
            ctx.attrs.product_name,
            "--product-kind",
            product_kind,
            "--target-identity",
            "{}//{}:{}".format(ctx.label.cell, ctx.label.package, ctx.label.name),
            "--provenance",
            "dependencyClosureIdentity={}".format(module.dependency_closure_identity),
            "--provenance",
            "configuredTarget={}".format(ctx.label),
        ]),
        category = "javascript_product_descriptor",
        identifier = ctx.attrs.product_name,
        local_only = True,
        allow_cache_upload = False,
    )
    if module.product_kind != product_kind:
        fail("module declares product kind {}, product declares {}".format(module.product_kind, product_kind))
    if platform.os != "any" or platform.architecture != "any" or platform.abi != "any":
        fail("JavaScript products are built only for the constraint-free portable platform")
    return descriptor

JavaScriptModuleProductInfo = provider(fields = {
    "descriptor": Artifact,
    "external_capabilities": list[str],
    "module": Artifact,
    "module_descriptor": Artifact,
    "module_path": str,
    "product_name": str,
    "runtime_kind": str,
    "target_identity": str,
})

JavaScriptCliProductInfo = provider(fields = {
    "descriptor": Artifact,
    "external_capabilities": list[str],
    "launch_descriptor": Artifact,
    "module": Artifact,
    "module_descriptor": Artifact,
    "module_path": str,
    "product_name": str,
    "runtime_kind": str,
    "target_identity": str,
})

BunJavaScriptCliProductInfo = provider(fields = {
    "descriptor": Artifact,
    "external_capabilities": list[str],
    "executable": provider_field(RunInfo),
    "module": Artifact,
    "module_descriptor": Artifact,
    "module_path": str,
    "product_name": str,
    "runtime_kind": str,
    "target_identity": str,
})


def _module_product_impl(ctx):
    module = ctx.attrs.module[JavaScriptModuleInfo]
    descriptor = _product_descriptor(ctx, module, "module")
    return [
        DefaultInfo(
            default_output = module.artifact,
            other_outputs = [descriptor, module.descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
                "module-descriptor": [DefaultInfo(default_output = module.descriptor)],
            },
        ),
        JavaScriptModuleProductInfo(
            descriptor = descriptor,
            external_capabilities = module.external_capabilities,
            module = module.artifact,
            module_descriptor = module.descriptor,
            module_path = module.module_path,
            product_name = ctx.attrs.product_name,
            runtime_kind = module.runtime_kind,
            target_identity = module.target_identity,
        ),
    ]


_MODULE_PRODUCT_ATTRS = dict(_PRODUCT_ATTRS)
_MODULE_PRODUCT_ATTRS["module"] = attrs.dep(providers = [JavaScriptModuleInfo])

_module_product = rule(
    impl = _module_product_impl,
    attrs = _MODULE_PRODUCT_ATTRS,
)

# Every product target is configured for the portable platform, so what it
# publishes is the portable configured module, never a host-configured rebuild.
PORTABLE_PRODUCT_PLATFORM_LABEL = "//buck2/platforms:javascript_portable"

def module_product(name, **kwargs):
    _module_product(name = name, default_target_platform = PORTABLE_PRODUCT_PLATFORM_LABEL, **kwargs)

def _bun_cli_product_impl(ctx):
    module = ctx.attrs.module[JavaScriptModuleInfo]
    if module.runtime_kind != "bun":
        fail("bun_cli_product requires a bun-target JavaScript module")
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    executable = RunInfo(args = cmd_args([toolchain.executable, module.artifact]))
    descriptor = _product_descriptor(ctx, module, "cli")
    return [
        DefaultInfo(
            default_output = module.artifact,
            other_outputs = [descriptor, module.descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
                "module-descriptor": [DefaultInfo(default_output = module.descriptor)],
            },
        ),
        BunJavaScriptCliProductInfo(
            descriptor = descriptor,
            external_capabilities = module.external_capabilities,
            executable = executable,
            module = module.artifact,
            module_descriptor = module.descriptor,
            module_path = module.module_path,
            product_name = ctx.attrs.product_name,
            runtime_kind = "bun",
            target_identity = module.target_identity,
        ),
        executable,
    ]


_bun_cli_product = rule(
    impl = _bun_cli_product_impl,
    attrs = _MODULE_PRODUCT_ATTRS,
)

def bun_cli_product(name, **kwargs):
    _bun_cli_product(name = name, default_target_platform = PORTABLE_PRODUCT_PLATFORM_LABEL, **kwargs)


def _cli_product_impl(ctx):
    launch = ctx.attrs.launch[NodeLaunchInfo]
    module = launch.module
    descriptor = _product_descriptor(ctx, module, "cli")
    return [
        DefaultInfo(
            default_output = module.artifact,
            other_outputs = [descriptor, module.descriptor, launch.descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
                "launch-descriptor": [DefaultInfo(default_output = launch.descriptor)],
                "module-descriptor": [DefaultInfo(default_output = module.descriptor)],
            },
        ),
        JavaScriptCliProductInfo(
            descriptor = descriptor,
            external_capabilities = launch.external_capabilities,
            launch_descriptor = launch.descriptor,
            module = module.artifact,
            module_descriptor = module.descriptor,
            module_path = module.module_path,
            product_name = ctx.attrs.product_name,
            runtime_kind = "node",
            target_identity = module.target_identity,
        ),
    ]


_CLI_PRODUCT_ATTRS = dict(_PRODUCT_ATTRS)
_CLI_PRODUCT_ATTRS["launch"] = attrs.dep(providers = [NodeLaunchInfo])

_cli_product = rule(
    impl = _cli_product_impl,
    attrs = _CLI_PRODUCT_ATTRS,
)

def cli_product(name, **kwargs):
    _cli_product(name = name, default_target_platform = PORTABLE_PRODUCT_PLATFORM_LABEL, **kwargs)
