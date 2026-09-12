"""Language-neutral portable build-product packaging contract."""

load("//buck2/package_tools.bzl", "JavaScriptModuleInfo")
load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "native_execution_constraints")
load("//buck2/provenance:defs.bzl", "ProductExecutableInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")
load("//buck2/typescript.bzl", "TsgoEmitInfo")

BuildProductInfo = provider(fields = {
    "descriptor": Artifact,
    "payload": Artifact,
})


def _validate_product_name(value):
    if not value:
        fail("javascript_product product_name must not be empty")
    alphanumeric = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    allowed = alphanumeric + "._+-"
    if value[0] not in alphanumeric:
        fail("javascript_product product_name must start with an ASCII letter or digit")
    for character in value.elems():
        if character not in allowed:
            fail("javascript_product product_name contains an unsupported character: {}".format(character))

def _validate_npm_package_name(value):
    if not value:
        fail("npm_package_product product_name must not be empty")
    parts = value.split("/")
    if value.startswith("@"):
        if len(parts) != 2 or len(parts[0]) == 1 or not parts[1]:
            fail("npm_package_product scoped product_name must be @scope/name")
    elif len(parts) != 1:
        fail("npm_package_product product_name must be an npm package name")
    allowed = "abcdefghijklmnopqrstuvwxyz0123456789-._~@/"
    for character in value.elems():
        if character not in allowed:
            fail("npm_package_product product_name contains an unsupported character: {}".format(character))


def _runner(ctx):
    return cmd_args(
        ctx.attrs._runner[DefaultInfo].default_outputs[0],
        format = "{}/package-command-runner.ts",
    )


def _javascript_product_impl(ctx):
    _validate_product_name(ctx.attrs.product_name)
    module = ctx.attrs.module[JavaScriptModuleInfo]
    descriptor = ctx.actions.declare_output("descriptor.json")
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    args = cmd_args([
        toolchain.executable,
        _runner(ctx),
        "product-descriptor",
        "--descriptor",
        descriptor.as_output(),
        "--module-descriptor",
        module.descriptor,
        "--product-kind",
        ctx.attrs.product_kind,
        "--product-name",
        ctx.attrs.product_name,
        "--target-identity",
        str(ctx.label.raw_target()),
        "--provenance",
        "configuredTarget={}".format(ctx.label),
        "--provenance",
        "dependencyClosureIdentity={}".format(module.dependency_closure_identity),
    ])
    ctx.actions.run(
        args,
        category = "javascript_product_descriptor",
        local_only = True,
        allow_cache_upload = False,
    )
    return [
        DefaultInfo(
            default_output = module.module,
            other_outputs = [descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        BuildProductInfo(descriptor = descriptor, payload = module.module),
    ]


_javascript_product = rule(
    impl = _javascript_product_impl,
    attrs = {
        "module": attrs.dep(providers = [JavaScriptModuleInfo]),
        "product_kind": attrs.enum(["cli", "module"]),
        "product_name": attrs.string(),
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


def javascript_product(
        name,
        module,
        product_name,
        product_kind,
        **kwargs):
    """Adapts one portable JavaScript module-v2 artifact to product-v2."""
    _javascript_product(
        name = name,
        module = module,
        product_name = product_name,
        product_kind = product_kind,
        default_target_platform = "//buck2/platforms:javascript_portable",
        **kwargs
    )

def _npm_package_product_impl(ctx):
    _validate_npm_package_name(ctx.attrs.product_name)
    dist = ctx.attrs.dist[TsgoEmitInfo]
    payload = ctx.actions.declare_output(ctx.attrs.archive_name)
    descriptor = ctx.actions.declare_output("descriptor.json")
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    ctx.actions.run(
        cmd_args([
            toolchain.executable,
            _runner(ctx),
            "dist-package",
            "--descriptor",
            descriptor.as_output(),
            "--dist",
            dist.directory,
            "--output",
            payload.as_output(),
            "--package-json",
            ctx.attrs.package_json,
            "--product-name",
            ctx.attrs.product_name,
            "--target-identity",
            str(ctx.label.raw_target()),
        ]),
        category = "npm_package_product",
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(
            default_output = payload,
            other_outputs = [descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        BuildProductInfo(descriptor = descriptor, payload = payload),
    ]


_npm_package_product = rule(
    impl = _npm_package_product_impl,
    attrs = {
        "archive_name": attrs.string(),
        "dist": attrs.dep(providers = [TsgoEmitInfo]),
        "package_json": attrs.source(),
        "product_name": attrs.string(),
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


def npm_package_product(
        name,
        dist,
        package_json,
        product_name,
        archive_name,
        **kwargs):
    """Packages one TypeScript dist tree as a deterministic npm tarball."""
    _npm_package_product(
        name = name,
        dist = dist,
        package_json = package_json,
        product_name = product_name,
        archive_name = archive_name,
        default_target_platform = "//buck2/platforms:javascript_portable",
        **kwargs
    )

def _build_product_impl(ctx):
    if not ctx.attrs.product_name:
        fail("build_product product_name must not be empty")
    entrypoint = ctx.attrs.entrypoint
    if not entrypoint or entrypoint.startswith("/"):
        fail("build_product entrypoint must be a normalized relative path")
    for component in entrypoint.split("/"):
        if component == "" or component == "." or component == "..":
            fail("build_product entrypoint must be a normalized relative path")
    product_executable = ctx.attrs.executable[ProductExecutableInfo]
    target_platform = ctx.attrs.target_platform[ProductPlatformInfo]
    actual_platform = (
        product_executable.target_platform_os,
        product_executable.target_platform_architecture,
        product_executable.target_platform_abi,
        product_executable.target_platform_runtime_contract,
    )
    expected_platform = (
        target_platform.os,
        target_platform.architecture,
        target_platform.abi,
        target_platform.runtime_contract,
    )
    if actual_platform != expected_platform:
        fail("build_product executable platform {} does not match requested target platform {}".format(actual_platform, expected_platform))
    executable = product_executable.executable
    provenance = product_executable.provenance
    payload = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._descriptor_tool[RunInfo],
        "package",
        "--executable", executable,
        "--entrypoint", entrypoint,
        "--artifact", payload.as_output(),
        "--name", ctx.attrs.product_name,
        "--target", str(ctx.label.raw_target()),
        "--platform-os", product_executable.target_platform_os,
        "--platform-architecture", product_executable.target_platform_architecture,
        "--platform-abi", product_executable.target_platform_abi,
        "--runtime-contract", product_executable.target_platform_runtime_contract,
        "--provenance", provenance.artifact,
        "--descriptor", descriptor.as_output(),
    ])
    # One action owns deterministic archive creation, native executable
    # inspection, and digesting the exact archive named by the descriptor.
    ctx.actions.run(args, category = "build_product_package", local_only = True)
    return [
        DefaultInfo(
            default_output = payload,
            other_outputs = [descriptor, provenance.artifact],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
                "provenance": [DefaultInfo(default_output = provenance.artifact)],
            },
        ),
        BuildProductInfo(descriptor = descriptor, payload = payload),
    ]

_build_product = rule(
    impl = _build_product_impl,
    attrs = {
        "executable": attrs.dep(providers = [ProductExecutableInfo]),
        "product_name": attrs.string(),
        "entrypoint": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "_descriptor_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:product_tool",
            providers = [RunInfo],
        )),
    },
)

def build_product(
        name,
        executable,
        target_platform,
        product_name,
        entrypoint,
        **kwargs):
    """Packages a payload built under the product's exact target platform."""
    _build_product(
        name = name,
        executable = executable,
        target_platform = target_platform,
        product_name = product_name,
        entrypoint = entrypoint,
        default_target_platform = target_platform,
        exec_compatible_with = native_execution_constraints(target_platform),
        **kwargs
    )
