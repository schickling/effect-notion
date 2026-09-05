"""Exact native product-platform identities admitted by the public Buck kernel."""

load("@prelude//cfg/exec_platform:marker.bzl", "get_exec_platform_marker")

ProductPlatformInfo = provider(fields = {
    "abi": str,
    "architecture": str,
    "os": str,
    "runtime_contract": str,
    "rust_target_triple": str,
})

def admitted_rust_target_triple(os, architecture, abi, runtime_contract):
    triple = {
        "darwin:aarch64:darwin:mach-o-dynamic/v1": "aarch64-apple-darwin",
        "linux:aarch64:glibc:elf-dynamic/v1": "aarch64-unknown-linux-gnu",
        "linux:x86_64:glibc:elf-dynamic/v1": "x86_64-unknown-linux-gnu",
    }.get("{}:{}:{}:{}".format(os, architecture, abi, runtime_contract))
    if triple == None:
        fail("platform fields do not identify an admitted native Rust pair")
    return triple


# A portable product is a real target platform, not metadata: the graph under a
# product is CONFIGURED for it, which is what makes the dependency store select
# the platform-invariant package set instead of the host's.
#
# It cannot borrow prelude's cpu/os constraints — every value there names a
# concrete machine — so it declares its own `any` values in their own
# constraint settings. Native platforms carry none of those settings and this
# platform carries none of prelude's, so the lockfile-derived `select()` over
# the four admitted platforms is exhaustive and non-overlapping, and an
# unadmitted configuration fails analysis instead of falling through a default.
#
# It has no Rust target triple: `admitted_rust_target_triple` rejects `any`, so
# it can never be used as a native or execution platform.
PortableProductPlatformInfo = provider(fields = {
    "abi": str,
    "architecture": str,
    "os": str,
    "runtime_contract": str,
    "runtime_contract_version": str,
})

PORTABLE_PLATFORM_FIELD = "any"

def _portable_product_platform_impl(ctx):
    for field, value in [
        ("os", ctx.attrs.os),
        ("architecture", ctx.attrs.architecture),
        ("abi", ctx.attrs.abi),
    ]:
        if value != PORTABLE_PLATFORM_FIELD:
            fail("portable product platform {} must be {}, got {}".format(field, PORTABLE_PLATFORM_FIELD, value))
    if not ctx.attrs.runtime_contract or not ctx.attrs.runtime_contract_version:
        fail("portable product platform must name its runtime contract and version")
    if len(ctx.attrs.constraint_values) != 3:
        fail("portable product platform must pin exactly its own os, cpu, and abi `any` values")
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        constraints[value.setting.label] = value
    configuration = ConfigurationInfo(constraints = constraints, values = {})
    return [
        DefaultInfo(),
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = configuration),
        PortableProductPlatformInfo(
            abi = ctx.attrs.abi,
            architecture = ctx.attrs.architecture,
            os = ctx.attrs.os,
            runtime_contract = ctx.attrs.runtime_contract,
            runtime_contract_version = ctx.attrs.runtime_contract_version,
        ),
    ]

portable_product_platform = rule(
    impl = _portable_product_platform_impl,
    attrs = {
        "abi": attrs.string(),
        "architecture": attrs.string(),
        "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
        "os": attrs.string(),
        "runtime_contract": attrs.string(),
        "runtime_contract_version": attrs.string(),
    },
)


def _product_platform_impl(ctx):
    expected_triple = admitted_rust_target_triple(
        ctx.attrs.os,
        ctx.attrs.architecture,
        ctx.attrs.abi,
        ctx.attrs.runtime_contract,
    )
    if ctx.attrs.rust_target_triple != expected_triple:
        fail("product platform Rust target triple does not match its native platform fields")
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        constraints[value.setting.label] = value
    configuration = ConfigurationInfo(constraints = constraints, values = {})
    return [
        DefaultInfo(),
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = configuration),
        ProductPlatformInfo(
            abi = ctx.attrs.abi,
            architecture = ctx.attrs.architecture,
            os = ctx.attrs.os,
            rust_target_triple = ctx.attrs.rust_target_triple,
            runtime_contract = ctx.attrs.runtime_contract,
        ),
    ]

product_platform = rule(
    impl = _product_platform_impl,
    attrs = {
        "abi": attrs.string(),
        "architecture": attrs.string(),
        "os": attrs.string(),
        "rust_target_triple": attrs.string(),
        "runtime_contract": attrs.string(),
        "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
    },
)

def _remote_cache_enabled():
    return read_root_config("buck2", "remote_cache_enabled", "true") == "true"

def _allow_cache_uploads():
    return read_root_config("buck2", "allow_cache_uploads", "true") == "true"

def _native_execution_platform_impl(ctx):
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        constraints[value.setting.label] = value
    configuration = ConfigurationInfo(constraints = constraints, values = {})
    platform = ExecutionPlatformInfo(
        label = ctx.label.raw_target(),
        configuration = configuration,
        executor_config = CommandExecutorConfig(
            local_enabled = True,
            remote_enabled = False,
            remote_cache_enabled = _remote_cache_enabled(),
            allow_cache_uploads = _allow_cache_uploads(),
            use_windows_path_separators = False,
        ),
    )
    return [
        DefaultInfo(),
        platform,
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = configuration),
        ExecutionPlatformRegistrationInfo(
            platforms = [platform],
            exec_marker_constraint = get_exec_platform_marker(),
        ),
    ]

native_execution_platform = rule(
    impl = _native_execution_platform_impl,
    attrs = {
        "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
    },
)

def host_platform_label():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "//buck2/platforms:linux_x86_64"
    if host.os.is_linux and host.arch.is_aarch64:
        return "//buck2/platforms:linux_aarch64"
    if host.os.is_macos and host.arch.is_aarch64:
        return "//buck2/platforms:macos_aarch64"
    fail("host_platform supports only x86_64-linux, aarch64-linux, and aarch64-darwin")

def host_execution_platform_label():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "//buck2/platforms:exec_linux_x86_64"
    if host.os.is_linux and host.arch.is_aarch64:
        return "//buck2/platforms:exec_linux_aarch64"
    if host.os.is_macos and host.arch.is_aarch64:
        return "//buck2/platforms:exec_macos_aarch64"
    fail("host execution platform supports only x86_64-linux, aarch64-linux, and aarch64-darwin")

def native_execution_constraints(target_platform):
    """Returns the execution constraints for an admitted native target pair."""
    constraints = {
        "//buck2/platforms:linux_x86_64": [
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        "//buck2/platforms:linux_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        "//buck2/platforms:macos_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
    }.get(target_platform)
    if constraints == None:
        fail("no native execution pair is admitted for target platform {}".format(target_platform))
    return constraints

def product_platform_constraints(target_platform):
    """Returns the complete target constraints for an admitted product platform."""
    constraints = {
        "//buck2/platforms:linux_x86_64": [
            "prelude//abi/constraints:gnu",
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        "//buck2/platforms:linux_aarch64": [
            "prelude//abi/constraints:gnu",
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        "//buck2/platforms:macos_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
    }.get(target_platform)
    if constraints == None:
        fail("no product constraints are admitted for target platform {}".format(target_platform))
    return constraints

def host_execution_constraints():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return native_execution_constraints("//buck2/platforms:linux_x86_64")
    if host.os.is_linux and host.arch.is_aarch64:
        return native_execution_constraints("//buck2/platforms:linux_aarch64")
    if host.os.is_macos and host.arch.is_aarch64:
        return native_execution_constraints("//buck2/platforms:macos_aarch64")
    fail("host execution constraints support only x86_64-linux, aarch64-linux, and aarch64-darwin")
