"""Language-neutral portable build-product packaging contract."""

load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/package_tools.bzl", "JavaScriptModuleInfo")
load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "native_execution_constraints", "product_platform_constraints", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/provenance:defs.bzl", "ProductExecutableInfo", "product_executable_info")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

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
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
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
            default = "//packages/@overeng/buck2-tools:package_command_runtime",
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


def _validate_relative_path(value, subject):
    if not value or value.startswith("/"):
        fail("{} must be a normalized relative path".format(subject))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be a normalized relative path".format(subject))


def _package_tree_product_executable_impl(ctx):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    target_platform = ctx.attrs.target_platform[ProductPlatformInfo]
    platform_key = "{}-{}-{}".format(
        target_platform.architecture,
        target_platform.os,
        target_platform.abi,
    )
    executable_path = ctx.attrs.executable_paths.get(platform_key)
    if executable_path == None:
        fail("package_tree_product_executable has no executable path for {}".format(platform_key))
    _validate_relative_path(ctx.attrs.package_anchor, "package_tree_product_executable package anchor")
    _validate_relative_path(executable_path, "package_tree_product_executable executable path")
    # Package trees link dependency entries. Resolve the anchor's real store
    # entry before materializing declared sibling files.
    executable = ctx.actions.declare_output("executable")
    anchor = cmd_args(package_tree.tree, format = "{}/" + ctx.attrs.package_anchor)
    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        "-e",
        "import { chmod, realpath } from 'node:fs/promises'; import { dirname, join } from 'node:path'; const anchor = await realpath(process.argv[1]); await Bun.write(process.argv[3], Bun.file(join(dirname(anchor), process.argv[2]))); await chmod(process.argv[3], 0o555)",
        anchor,
        executable_path,
        executable.as_output(),
    ])
    args.add(cmd_args(hidden = package_tree.read_roots))
    ctx.actions.run(
        args,
        category = "package_tree_product_executable",
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    support_tree = None
    support_directory_path = ctx.attrs.support_directory_paths.get(platform_key)
    if support_directory_path != None:
        _validate_relative_path(support_directory_path, "package_tree_product_executable support directory path")
        _validate_relative_path(ctx.attrs.support_destination, "package_tree_product_executable support destination")
        support_tree = ctx.actions.declare_output("support-tree", dir = True)
        support_args = cmd_args([
            ctx.attrs._bun[BunToolchainInfo].executable,
            "-e",
            "import { mkdir, readdir, realpath } from 'node:fs/promises'; import { dirname, join, relative } from 'node:path'; const root = dirname(await realpath(process.argv[1])); const source = join(root, process.argv[2]); const executable = join(root, process.argv[3]); const output = join(process.argv[5], process.argv[4]); const copy = async (from, to) => { await mkdir(to, { recursive: true }); for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const input = join(from, entry.name); const destination = join(to, entry.name); if (input === executable) continue; if (entry.isSymbolicLink()) throw new Error(`support tree contains symlink: ${relative(source, input)}`); if (entry.isDirectory()) await copy(input, destination); else if (entry.isFile()) await Bun.write(destination, Bun.file(input)); else throw new Error(`support tree contains special file: ${relative(source, input)}`); } }; await copy(source, output)",
            anchor,
            support_directory_path,
            executable_path,
            ctx.attrs.support_destination,
            support_tree.as_output(),
        ])
        support_args.add(cmd_args(hidden = package_tree.read_roots))
        ctx.actions.run(
            support_args,
            category = "package_tree_product_support",
            local_only = True,
            allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
        )
    product_executable = product_executable_info(
        ctx,
        executable,
        ctx.attrs.recipe,
        ctx.attrs.toolchain,
        target_platform,
        support_tree = support_tree,
    )
    return [
        DefaultInfo(
            default_output = executable,
            other_outputs = [product_executable.provenance.artifact] + ([support_tree] if support_tree != None else []),
        ),
        product_executable,
    ]


_package_tree_product_executable = rule(
    impl = _package_tree_product_executable_impl,
    attrs = {
        "executable_paths": attrs.dict(key = attrs.string(), value = attrs.string()),
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "package_anchor": attrs.string(),
        "support_destination": attrs.string(default = "support"),
        "support_directory_paths": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "recipe": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "toolchain": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def package_tree_product_executable(
        name,
        package_tree,
        package_anchor,
        executable_paths,
        recipe,
        target_platform,
        toolchain,
        support_directory_paths = {},
        support_destination = "support",
        **kwargs):
    """Projects a platform executable from a lockfile-derived package tree."""
    _package_tree_product_executable(
        name = name,
        package_tree = package_tree,
        executable_paths = executable_paths,
        package_anchor = package_anchor,
        recipe = recipe,
        support_directory_paths = support_directory_paths,
        support_destination = support_destination,
        toolchain = toolchain,
        target_platform = target_platform,
        default_target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform),
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
    if product_executable.support_tree != None:
        args.add("--support-tree", product_executable.support_tree)
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
