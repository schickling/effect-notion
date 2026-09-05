"""Provider-backed manifests for out-of-process editor snapshot publication."""

load("//buck2:materialization.bzl", "PackageTreeInfo")

_EDITOR_VIEW_INPUTS_SCHEMA = "effect-utils/editor-view-inputs/v1"

def _unique_artifacts(artifacts):
    seen = {}
    unique = []
    for artifact in artifacts:
        if artifact not in seen:
            seen[artifact] = True
            unique.append(artifact)
    return unique


def _editor_view_inputs_impl(ctx):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    outputs = _unique_artifacts([ctx.attrs.editor_inputs] + package_tree.read_roots)
    out = ctx.actions.declare_output("editor-view-inputs.json")
    ctx.actions.write_json(out, {
        "schema": _EDITOR_VIEW_INPUTS_SCHEMA,
        "editorInputs": ctx.attrs.editor_inputs,
        "packageTree": package_tree.tree,
        "readRoots": package_tree.read_roots,
    })
    return [
        DefaultInfo(
            default_output = out,
            other_outputs = outputs,
        ),
    ]


_editor_view_inputs = rule(
    impl = _editor_view_inputs_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "editor_inputs": attrs.source(),
    },
)


def editor_view_inputs(name, editor_inputs, package_tree, **kwargs):
    """Write exact package-tree/read-root paths for a trusted external publisher."""
    _editor_view_inputs(
        name = name,
        package_tree = package_tree,
        editor_inputs = editor_inputs,
        **kwargs
    )
