"""Language-neutral provenance propagated by executable producers."""

load("//buck2/platforms:defs.bzl", "ProductPlatformInfo")

BuildProvenanceInfo = provider(fields = {
    "artifact": Artifact,
    "recipe": str,
    "toolchain": str,
})

ProductExecutableInfo = provider(fields = {
    "executable": Artifact,
    "support_tree": typing.Any,
    "provenance": provider_field(BuildProvenanceInfo),
    "target_platform_abi": str,
    "target_platform_architecture": str,
    "target_platform_os": str,
    "target_platform_runtime_contract": str,
})

def product_executable_info(ctx, executable, recipe, toolchain, target_platform, support_tree = None):
    """Builds the provider a language producer returns with its executable."""
    for field, value in {"recipe": recipe, "toolchain": toolchain}.items():
        if not value or "\n" in value or "\r" in value or "\x00" in value:
            fail("build_provenance {} must be a non-empty structured string".format(field))
    artifact = ctx.actions.declare_output("build-provenance.json")
    ctx.actions.write_json(artifact, {
        "recipe": recipe,
        "schema": "buck-build-provenance/v1",
        "toolchain": toolchain,
    }, pretty = True)
    provenance = BuildProvenanceInfo(
            artifact = artifact,
            recipe = recipe,
            toolchain = toolchain,
    )
    return ProductExecutableInfo(
        executable = executable,
        support_tree = support_tree,
        provenance = provenance,
        target_platform_abi = target_platform.abi,
        target_platform_architecture = target_platform.architecture,
        target_platform_os = target_platform.os,
        target_platform_runtime_contract = target_platform.runtime_contract,
    )
