"""Configured Rust and TypeScript toolchains realized by pinned Nix inputs."""

load("@prelude//go_bootstrap:go_bootstrap.bzl", "GoBootstrapToolchainInfo")
load("@prelude//python_bootstrap:python_bootstrap.bzl", "PythonBootstrapToolchainInfo")
load(
    "//buck2/platforms:defs.bzl",
    "admitted_rust_target_triple",
    "ProductPlatformInfo",
    "host_execution_constraints",
    "native_execution_constraints",
    "product_platform_constraints",
)

ConfiguredRustToolchainInfo = provider(fields = {
    "archiver": provider_field(RunInfo),
    "compile_env": provider_field(dict[str, str]),
    "compiler": provider_field(RunInfo),
    "identity": provider_field(str),
    "linker": provider_field(RunInfo),
    "target_platform_abi": str,
    "target_platform_architecture": str,
    "target_platform_os": str,
    "target_platform_runtime_contract": str,
    "target_platform_label": str,
    "target_triple": provider_field(str),
})

def host_capability_platform():
    """Returns the projection platform key for the admitted native host.

    This is the same spelling the composition capability resolver keys its
    projection by (`composition-capability-resolver.ts` `executionPlatform`), so
    it indexes `CAPABILITIES` directly. Every capability consumer must use this
    one helper: a second spelling of the macOS key is how a toolchain silently
    misses its realization.
    """
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "x86_64-linux"
    if host.os.is_linux and host.arch.is_aarch64:
        return "aarch64-linux"
    if host.os.is_macos and host.arch.is_aarch64:
        return "aarch64-macos"
    fail("Nix capabilities admit only x86_64-linux, aarch64-linux, and aarch64-macos")

def require_capability(capabilities, generation, platform, tool_id):
    """Returns the projected metadata for one tool, or fails with the reason."""
    platform_capabilities = capabilities.get(platform)
    if platform_capabilities == None:
        fail("generated Buck capabilities do not contain native platform {}".format(platform))
    metadata = platform_capabilities.get(tool_id)
    if metadata == None:
        fail("generated Buck capabilities do not contain {} for {}".format(tool_id, platform))
    for field in ["closureIdentity", "contentDigest", "executableStorePath", "generation"]:
        if not metadata.get(field):
            fail("generated {} capability has no {}".format(tool_id, field))
    if metadata["generation"] != generation:
        fail("generated {} capability belongs to a stale generation".format(tool_id))
    executable = metadata["executableStorePath"]
    if not executable.startswith("/nix/store/") or "/bin/" not in executable:
        fail("generated {} capability is not an immutable Nix executable: {}".format(tool_id, executable))
    if not metadata["closureIdentity"].startswith("/nix/store/"):
        fail("generated {} capability has a non-Nix closure identity".format(tool_id))
    if len(metadata["contentDigest"]) != 64:
        fail("generated {} capability has an invalid content digest".format(tool_id))
    return metadata

def require_capability_closure(capabilities, generation, platform, tool_id):
    """Returns the complete immutable runtime closure a sandboxed action may read.

    The projection publishes the transitive `/nix/store` requisites of each realization
    (`closureStorePaths`). A sandbox exposes exactly these paths read-only and no other store
    path, so an incomplete or non-normalized closure must fail analysis rather than produce an
    action that only works because the host store happens to be visible.
    """
    metadata = require_capability(capabilities, generation, platform, tool_id)
    closure = metadata.get("closureStorePaths")
    if not closure:
        fail("generated {} capability has no closureStorePaths".format(tool_id))
    for path in closure:
        if not path.startswith("/nix/store/") or path.count("/") != 3:
            fail("generated {} capability closure path is not a normalized store path: {}".format(tool_id, path))
    if metadata["closureIdentity"] not in closure:
        fail("generated {} capability closure omits its own realization".format(tool_id))
    return sorted({path: None for path in closure})

def host_rust_target_triple():
    """Returns the Rust target triple for the admitted native host."""
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return admitted_rust_target_triple("linux", "x86_64", "glibc", "elf-dynamic/v1")
    if host.os.is_linux and host.arch.is_aarch64:
        return admitted_rust_target_triple("linux", "aarch64", "glibc", "elf-dynamic/v1")
    if host.os.is_macos and host.arch.is_aarch64:
        return admitted_rust_target_triple("darwin", "aarch64", "darwin", "mach-o-dynamic/v1")
    fail("configured Rust toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")

def _configured_rust_toolchain_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    if ctx.attrs.target_triple != platform.rust_target_triple:
        fail("configured Rust target triple does not match the product platform")
    if not ctx.attrs.identity:
        fail("configured Rust toolchain identity must not be empty")
    return [
        DefaultInfo(),
        ConfiguredRustToolchainInfo(
            archiver = ctx.attrs.archiver[RunInfo],
            compile_env = ctx.attrs.compile_env,
            compiler = ctx.attrs.compiler[RunInfo],
            identity = ctx.attrs.identity,
            linker = ctx.attrs.linker[RunInfo],
            target_platform_abi = platform.abi,
            target_platform_architecture = platform.architecture,
            target_platform_os = platform.os,
            target_platform_label = str(ctx.attrs.target_platform.label.raw_target()),
            target_platform_runtime_contract = platform.runtime_contract,
            target_triple = ctx.attrs.target_triple,
        ),
    ]

_configured_rust_toolchain = rule(
    impl = _configured_rust_toolchain_impl,
    attrs = {
        "archiver": attrs.exec_dep(providers = [RunInfo]),
        "compile_env": attrs.dict(key = attrs.string(), value = attrs.string()),
        "compiler": attrs.exec_dep(providers = [RunInfo]),
        "identity": attrs.string(),
        "linker": attrs.exec_dep(providers = [RunInfo]),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "target_triple": attrs.string(),
    },
    is_toolchain_rule = True,
)

def configured_rust_toolchain(
        name,
        archiver,
        compile_env,
        compiler,
        identity,
        linker,
        target_platform,
        target_triple,
        **kwargs):
    """Declares a Nix-realized Rust capability for one native platform pair."""
    if "exec_compatible_with" in kwargs or "target_compatible_with" in kwargs:
        fail("configured_rust_toolchain owns target and execution compatibility")
    _configured_rust_toolchain(
        name = name,
        archiver = archiver,
        compile_env = compile_env,
        compiler = compiler,
        identity = identity,
        linker = linker,
        target_platform = target_platform,
        target_triple = target_triple,
        exec_compatible_with = native_execution_constraints(target_platform),
        target_compatible_with = product_platform_constraints(target_platform),
        **kwargs
    )


BunToolchainInfo = provider(fields = {
    "executable": str,
    "identity": str,
})


def _require_nix_store_binary(executable, binary, tool):
    if not executable.startswith("/nix/store/"):
        fail("{} must resolve to an immutable /nix/store executable: {}".format(tool, executable))
    components = executable.split("/")
    if len(components) < 6 or components[-2:] != ["bin", binary]:
        fail("{} executable must have the shape /nix/store/<realization>/bin/{}: {}".format(tool, binary, executable))
    for component in components[3:]:
        if component == "" or component == "." or component == "..":
            fail("{} executable path is not normalized: {}".format(tool, executable))


def _nix_python_bootstrap_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.interpreter, "python3", "Python bootstrap")
    return [
        DefaultInfo(),
        PythonBootstrapToolchainInfo(interpreter = ctx.attrs.interpreter),
    ]


_nix_python_bootstrap_toolchain = rule(
    impl = _nix_python_bootstrap_toolchain_impl,
    attrs = {
        "interpreter": attrs.string(),
    },
    is_toolchain_rule = True,
)


def nix_python_bootstrap_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix interpreter prelude's bootstrap scripts run under.

    Prelude's own Rust rules pull bootstrap-interpreter targets in
    (`@prelude//rust/tools:transitive_dependency_symlinks`), and prelude's ambient
    `system_...` bootstrap toolchain resolves the interpreter by bare basename off the
    ambient PATH. That is the one non-hermetic term the whole Rust graph would otherwise
    carry, so the interpreter comes from the same projected capability set as every other
    tool.

    [Decision 0028](../../context/buck2/.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md)
    admits exactly this realization; `buck2-no-python-actions.test.sh` holds the boundary.
    """
    if "exec_compatible_with" in kwargs:
        fail("nix_python_bootstrap_toolchain owns execution compatibility")
    platform = host_capability_platform()
    interpreter = require_capability(
        capabilities,
        generation,
        platform,
        "python-bootstrap",
    )["executableStorePath"]
    _require_nix_store_binary(interpreter, "python3", "Python bootstrap")
    _nix_python_bootstrap_toolchain(
        name = name,
        interpreter = interpreter,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def _bun_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.executable, "bun", "Bun")
    return [
        DefaultInfo(),
        BunToolchainInfo(
            executable = ctx.attrs.executable,
            identity = ctx.attrs.executable,
        ),
    ]


_bun_toolchain = rule(
    impl = _bun_toolchain_impl,
    attrs = {
        "executable": attrs.string(),
    },
)


def bun_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix Bun executable used by JavaScript actions."""
    if "exec_compatible_with" in kwargs:
        fail("bun_toolchain owns execution compatibility")
    platform = host_capability_platform()
    executable = require_capability(capabilities, generation, platform, "bun")["executableStorePath"]
    _require_nix_store_binary(executable, "bun", "Bun")
    _bun_toolchain(
        name = name,
        executable = executable,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


EffectTsgoToolchainInfo = provider(fields = {
    "bun": str,
    # Every `/nix/store` path the Bun and tsgo realizations need at runtime. The sandbox exposes
    # exactly these read-only, so an action never depends on an ambient store view.
    "closure_store_paths": list[str],
    "executable": str,
    "identity": str,
    "runner": Artifact,
})


def _effect_tsgo_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.bun, "bun", "Bun")
    _require_nix_store_binary(ctx.attrs.executable, "tsgo", "effect-tsgo")
    if not ctx.attrs.closure_store_paths:
        fail("effect-tsgo toolchain requires the complete Bun and tsgo runtime closures")
    return [
        DefaultInfo(),
        EffectTsgoToolchainInfo(
            bun = ctx.attrs.bun,
            closure_store_paths = ctx.attrs.closure_store_paths,
            executable = ctx.attrs.executable,
            identity = "bun={};tsgo={};closure={}".format(
                ctx.attrs.bun,
                ctx.attrs.executable,
                ",".join(ctx.attrs.closure_store_paths),
            ),
            runner = ctx.attrs.runner,
        ),
    ]


_effect_tsgo_toolchain = rule(
    impl = _effect_tsgo_toolchain_impl,
    attrs = {
        "bun": attrs.string(),
        "closure_store_paths": attrs.list(attrs.string()),
        "executable": attrs.string(),
        "runner": attrs.source(),
    },
)


def effect_tsgo_toolchain(name, capabilities, generation, runner, **kwargs):
    """Declares the exact Nix Bun/effect-tsgo pair used by TypeScript actions."""
    if "exec_compatible_with" in kwargs:
        fail("effect_tsgo_toolchain owns execution compatibility")
    platform = host_capability_platform()
    bun = require_capability(capabilities, generation, platform, "bun")["executableStorePath"]
    executable = require_capability(
        capabilities,
        generation,
        platform,
        "effect-tsgo",
    )["executableStorePath"]
    _require_nix_store_binary(bun, "bun", "Bun")
    _require_nix_store_binary(executable, "tsgo", "effect-tsgo")
    closure = (
        require_capability_closure(capabilities, generation, platform, "bun") +
        require_capability_closure(capabilities, generation, platform, "effect-tsgo")
    )
    _effect_tsgo_toolchain(
        name = name,
        bun = bun,
        closure_store_paths = sorted({path: None for path in closure}),
        executable = executable,
        runner = runner,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


# The Linux capability id of the sandbox launcher. Bubblewrap is an exact Nix tool dependency;
# Darwin containment is instead the fixed system Seatbelt path bound to the admitted OS release.
BUBBLEWRAP_TOOL_ID = "sandbox-bubblewrap"

# Seatbelt's public interface is deprecated. It is admitted only at its fixed system path, so no
# ambient `xcrun`/Xcode discovery can substitute a different launcher.
DARWIN_SANDBOX_LAUNCHER = "/usr/bin/sandbox-exec"

# Capability projection keys admitted for platform-native containment. This is deliberately not
# inferred from the generated capability dictionary: a misspelled requested platform must fail
# loading instead of silently selecting the `none` toolchain on that executor.
_SANDBOX_CAPABILITY_PLATFORMS = [
    "x86_64-linux",
    "aarch64-linux",
    "aarch64-macos",
]

def _sandbox_active_platform_error(active_platforms):
    seen = {}
    for platform in active_platforms:
        if platform not in _SANDBOX_CAPABILITY_PLATFORMS:
            return "sandbox active platform must be one of {}: {}".format(
                ", ".join(_SANDBOX_CAPABILITY_PLATFORMS),
                platform,
            )
        if platform in seen:
            return "sandbox active platform must be declared once: {}".format(platform)
        seen[platform] = None
    return None

def _validate_sandbox_active_platforms(active_platforms):
    error = _sandbox_active_platform_error(active_platforms)
    if error != None:
        fail(error)

def _sandbox_platform_key_validation_test_impl(_ctx):
    if _sandbox_active_platform_error(_SANDBOX_CAPABILITY_PLATFORMS) != None:
        fail("admitted sandbox platform keys must validate")
    if _sandbox_active_platform_error(["aarch64-darwin"]) == None:
        fail("the Darwin capability spelling typo must be rejected")
    if _sandbox_active_platform_error(["x86_64-linux", "x86_64-linux"]) == None:
        fail("duplicate sandbox active platforms must be rejected")
    return [DefaultInfo()]

_sandbox_platform_key_validation_test = rule(
    impl = _sandbox_platform_key_validation_test_impl,
    attrs = {},
)

def sandbox_platform_key_validation_test(name, **kwargs):
    """Proves the fail-closed active-platform spelling contract at analysis time."""
    _sandbox_platform_key_validation_test(name = name, **kwargs)

SandboxToolchainInfo = provider(fields = {
    # Darwin kernel majors whose Seatbelt semantics the Darwin gate has proven. Empty on Linux.
    "darwin_kernel_majors": list[str],
    "identity": str,
    "kind": str,
    "launcher": str,
    "closure_store_paths": list[str],
})


def _sandbox_toolchain_impl(ctx):
    kind = ctx.attrs.kind
    if kind == "bubblewrap":
        _require_nix_store_binary(ctx.attrs.launcher, "bwrap", "Bubblewrap")
        if not ctx.attrs.closure_store_paths:
            fail("the Bubblewrap sandbox requires its complete runtime closure")
        if ctx.attrs.darwin_kernel_majors:
            fail("the Bubblewrap sandbox must not declare Darwin kernel majors")
    elif kind == "seatbelt":
        if ctx.attrs.launcher != DARWIN_SANDBOX_LAUNCHER:
            fail("Seatbelt must be the fixed system launcher {}".format(DARWIN_SANDBOX_LAUNCHER))
        if not ctx.attrs.darwin_kernel_majors:
            fail("Seatbelt requires the admitted Darwin kernel majors its gate proved")
    elif kind == "none":
        if ctx.attrs.launcher:
            fail("an inactive sandbox must not declare a launcher")
    else:
        fail("unknown sandbox kind: {}".format(kind))
    return [
        DefaultInfo(),
        SandboxToolchainInfo(
            closure_store_paths = ctx.attrs.closure_store_paths,
            darwin_kernel_majors = ctx.attrs.darwin_kernel_majors,
            identity = "{}:{}:{}:{}".format(
                kind,
                ctx.attrs.launcher,
                ",".join(ctx.attrs.closure_store_paths),
                ",".join(ctx.attrs.darwin_kernel_majors),
            ),
            kind = kind,
            launcher = ctx.attrs.launcher,
        ),
    ]


_sandbox_toolchain = rule(
    impl = _sandbox_toolchain_impl,
    attrs = {
        "closure_store_paths": attrs.list(attrs.string(), default = []),
        "darwin_kernel_majors": attrs.list(attrs.string(), default = []),
        "kind": attrs.string(),
        "launcher": attrs.string(default = ""),
    },
)


def sandbox_toolchain(
        name,
        capabilities,
        generation,
        active_platforms,
        darwin_kernel_majors = [],
        **kwargs):
    """Declares the platform-native containment implementation TypeScript actions run inside.

    `active_platforms` names the execution platforms whose containment gate has passed. On any
    other platform the toolchain resolves to `none`, and the runner keeps hashing the input tree
    to detect mutation instead — the slow evidence stays until the fast enforcement is proven.
    """
    if "exec_compatible_with" in kwargs:
        fail("sandbox_toolchain owns execution compatibility")
    _validate_sandbox_active_platforms(active_platforms)
    platform = host_capability_platform()
    if platform not in active_platforms:
        _sandbox_toolchain(
            name = name,
            kind = "none",
            exec_compatible_with = host_execution_constraints(),
            **kwargs
        )
        return
    if platform == "aarch64-macos":
        _sandbox_toolchain(
            name = name,
            darwin_kernel_majors = darwin_kernel_majors,
            kind = "seatbelt",
            launcher = DARWIN_SANDBOX_LAUNCHER,
            exec_compatible_with = host_execution_constraints(),
            **kwargs
        )
        return
    metadata = require_capability(capabilities, generation, platform, BUBBLEWRAP_TOOL_ID)
    launcher = metadata["executableStorePath"]
    _require_nix_store_binary(launcher, "bwrap", "Bubblewrap")
    _sandbox_toolchain(
        name = name,
        closure_store_paths = require_capability_closure(
            capabilities,
            generation,
            platform,
            BUBBLEWRAP_TOOL_ID,
        ),
        kind = "bubblewrap",
        launcher = launcher,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def unsandboxed_local_toolchain(name, **kwargs):
    """Declares the deliberate no-containment executor for host-service test lanes.

    A lane that must reach the Nix daemon socket, the store's own root registry under
    `/nix/var/nix`, loopback, the outbound network, or the host's `devpts` and controlling-terminal
    semantics cannot be made hermetic by binding more read roots: those services are exactly what
    containment removes. Such a lane names this
    toolchain explicitly through `execution_mode = "unsandboxed-local"` and must also declare the
    host-service capability and `cacheable = False`, so no sandboxed lane can reach an
    unsandboxed executor by omission.
    """
    if "exec_compatible_with" in kwargs:
        fail("unsandboxed_local_toolchain owns execution compatibility")
    _sandbox_toolchain(
        name = name,
        kind = "none",
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def _nix_go_bootstrap_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.go, "go", "Go")
    return [
        DefaultInfo(),
        GoBootstrapToolchainInfo(
            env_go_arch = ctx.attrs.env_go_arch,
            env_go_os = ctx.attrs.env_go_os,
            # `go` locates its own GOROOT relative to the realized executable, and
            # the capability resolver already realpath'd it, so declaring GOROOT
            # would only restate what the store path says.
            env_go_root = None,
            go = RunInfo(args = [ctx.attrs.go]),
            go_wrapper = ctx.attrs.go_wrapper[RunInfo],
        ),
    ]


_nix_go_bootstrap_toolchain = rule(
    impl = _nix_go_bootstrap_toolchain_impl,
    attrs = {
        "env_go_arch": attrs.string(),
        "env_go_os": attrs.string(),
        "go": attrs.string(),
        "go_wrapper": attrs.exec_dep(providers = [RunInfo], default = "prelude//go_bootstrap/tools:go_wrapper_py"),
    },
    is_toolchain_rule = True,
)


def go_platform_pair():
    """Returns the (GOOS, GOARCH) pair for the admitted native host."""
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return ("linux", "amd64")
    if host.os.is_linux and host.arch.is_aarch64:
        return ("linux", "arm64")
    if host.os.is_macos and host.arch.is_aarch64:
        return ("darwin", "arm64")
    fail("Go toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")


def nix_go_bootstrap_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix Go distribution every Go action compiles with.

    This is prelude's `GoBootstrapToolchainInfo`, i.e. the `go build` driver rather
    than the per-package compile/link graph. Upstream's
    `system_go_bootstrap_toolchain` resolves the bare name `go` off the ambient
    PATH; the capability projection makes it an immutable store realization that is
    part of every Go action's key.
    """
    if "exec_compatible_with" in kwargs:
        fail("nix_go_bootstrap_toolchain owns execution compatibility")
    platform = host_capability_platform()
    go = require_capability(capabilities, generation, platform, "go")["executableStorePath"]
    _require_nix_store_binary(go, "go", "Go")
    go_os, go_arch = go_platform_pair()
    _nix_go_bootstrap_toolchain(
        name = name,
        env_go_arch = go_arch,
        env_go_os = go_os,
        go = go,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
