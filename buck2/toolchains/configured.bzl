"""Attested executor capabilities provisioned by the activated Nix profile."""

load("//buck2/platforms:defs.bzl", "host_execution_constraints")
load("//buck2/toolchains:defs.bzl", "host_capability_platform", "require_capability_closure")
load("//.buck2/capabilities:defs.bzl", "CAPABILITIES", "GENERATION")

BuckSupportToolInfo = provider(fields = {
    "content_digest": str,
    "closure_identity": str,
    # Complete immutable runtime closure of the realization; a sandbox exposes exactly these.
    "closure_store_paths": list[str],
    "execution_platform": str,
    "executable": Artifact,
    "manifest": Artifact,
    "protocol": str,
    "runtime_contract": str,
    "store_path": str,
    "tool_id": str,
})

def _support_tool_impl(ctx):
    platform = host_capability_platform()
    executable = ctx.attrs.executable
    manifest = ctx.attrs.manifest
    return [
        DefaultInfo(other_outputs = [executable, manifest]),
        RunInfo(args = cmd_args([
            executable,
            "--capability-manifest", manifest,
        ])),
        BuckSupportToolInfo(
            content_digest = ctx.attrs.content_digest,
            closure_identity = ctx.attrs.closure_identity,
            closure_store_paths = ctx.attrs.closure_store_paths,
            execution_platform = platform,
            executable = executable,
            manifest = manifest,
            protocol = ctx.attrs.protocol,
            runtime_contract = ctx.attrs.runtime_contract,
            store_path = ctx.attrs.store_path,
            tool_id = ctx.attrs.tool_id,
        ),
    ]

_support_tool = rule(
    impl = _support_tool_impl,
    attrs = {
        "content_digest": attrs.string(),
        "closure_identity": attrs.string(),
        "closure_store_paths": attrs.list(attrs.string()),
        "executable": attrs.source(),
        "manifest": attrs.source(),
        "protocol": attrs.string(),
        "runtime_contract": attrs.string(),
        "store_path": attrs.string(),
        "tool_id": attrs.string(),
    },
)

def support_tool(name, protocol, tool_id, **kwargs):
    platform = host_capability_platform()
    metadata = CAPABILITIES[platform][tool_id]
    capability = "//.buck2/capabilities/generations/{}/{}/{}".format(metadata["generation"], platform, tool_id)
    _support_tool(
        name = name,
        content_digest = metadata["contentDigest"],
        closure_identity = metadata["closureIdentity"],
        closure_store_paths = require_capability_closure(CAPABILITIES, GENERATION, platform, tool_id),
        executable = capability + ":executable",
        manifest = capability + ":manifest",
        protocol = protocol,
        runtime_contract = "native-executable/v1",
        store_path = metadata["executableStorePath"],
        tool_id = tool_id,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
