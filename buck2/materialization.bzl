"""Generic TypeScript package-tree assembly from declared Buck artifacts."""

load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")
load("//buck2/dependencies:defs.bzl", "PnpmDeclaredClosureInfo")


PackageTreeInfo = provider(fields = {
    "read_roots": provider_field(list[Artifact]),
    "tree": Artifact,
})


def _unique_artifacts(artifacts):
    seen = {}
    roots = []
    for artifact in artifacts:
        if artifact not in seen:
            seen[artifact] = True
            roots.append(artifact)
    return roots


def _require_relative_path(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if value.startswith("/") or "\\" in value:
        fail("{} must be a portable relative path: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _add_mapped_sources(args, flag, sources):
    for destination in sorted(sources.keys()):
        _require_relative_path(destination, flag)
        args.add(flag, destination, sources[destination])

def _package_tree_impl(ctx):
    out = ctx.actions.declare_output("package_tree", dir = True)
    _require_relative_path(ctx.attrs.runtime_entry, "runtime entry")
    dependency_choices = (1 if ctx.attrs.node_modules != None else 0) + (1 if ctx.attrs.dependency_view != None else 0) + (1 if ctx.attrs.empty_dependencies else 0)
    if dependency_choices != 1:
        fail("a package view declares exactly one of empty_dependencies, node_modules, or dependency_view")

    # The runner is staged as a directory holding its complete relative-import
    # closure, so a sibling `./module.ts` import resolves inside the action.
    # Only the declared modules are present: an undeclared one fails closed.
    runtime_tree = ctx.attrs.runtime[DefaultInfo].default_outputs[0]
    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        cmd_args(runtime_tree, format = "{}/" + ctx.attrs.runtime_entry),
        "--output",
        out.as_output(),
    ])

    # A dependency view owns no dependency bytes: the package view links it as
    # one first hop instead of copying a closure per consumer.
    read_roots = [out]
    if ctx.attrs.empty_dependencies:
        args.add("--empty-node-modules", "true")
    elif ctx.attrs.dependency_view != None:
        dependency_view = ctx.attrs.dependency_view[PnpmDeclaredClosureInfo]
        args.add("--dependency-view", dependency_view.node_modules)
        args.add(cmd_args(hidden = dependency_view.read_roots))
        read_roots = _unique_artifacts([out] + dependency_view.read_roots)
    else:
        args.add("--node-modules", ctx.attrs.node_modules)
    _add_mapped_sources(args, "--file", ctx.attrs.files)
    _add_mapped_sources(args, "--workspace-file", ctx.attrs.workspace_files)
    for link_path in sorted(ctx.attrs.workspace_links.keys()):
        target_path = ctx.attrs.workspace_links[link_path]
        _require_relative_path(link_path, "workspace link")
        _require_relative_path(target_path, "workspace link target")
        args.add("--workspace-link", link_path, target_path)
    ctx.actions.run(
        args,
        category = "package_tree",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        # The declared roots beyond the tree itself are exported as
        # `other_outputs` so a workspace importer's view can mount this view's
        # own dependency roots without copying a second closure.
        DefaultInfo(default_output = out, other_outputs = read_roots[1:]),
        PackageTreeInfo(read_roots = read_roots, tree = out),
    ]


_package_tree = rule(
    impl = _package_tree_impl,
    attrs = {
        "node_modules": attrs.option(attrs.source(), default = None),
        "empty_dependencies": attrs.bool(default = False),
        "dependency_view": attrs.option(
            attrs.dep(providers = [PnpmDeclaredClosureInfo]),
            default = None,
        ),
        "files": attrs.dict(key = attrs.string(), value = attrs.source()),
        "workspace_files": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "workspace_links": attrs.dict(
            key = attrs.string(),
            value = attrs.string(),
            default = {},
        ),
        "runtime": attrs.dep(providers = [DefaultInfo]),
        "runtime_entry": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def package_tree(name, node_modules, files, runtime, runtime_entry, workspace_siblings = {}, **kwargs):
    """Assembles one package tree; sibling specs carry files plus node_modules-relative links."""
    workspace_files = {}
    workspace_links = {}
    for sibling_name in sorted(workspace_siblings.keys()):
        _require_relative_path(sibling_name, "workspace sibling")
        sibling = workspace_siblings[sibling_name]
        sibling_root = ".workspace-siblings/{}".format(sibling_name)
        for destination, source in sibling.get("files", {}).items():
            _require_relative_path(destination, "workspace sibling file")
            workspace_files["{}/{}".format(sibling_root, destination)] = source
        for link in sibling.get("links", []):
            _require_relative_path(link, "workspace sibling link")
            link_path = "node_modules/{}".format(link)
            if link_path in workspace_links:
                fail("duplicate workspace sibling link: {}".format(link_path))
            workspace_links[link_path] = sibling_root
    _package_tree(
        name = name,
        node_modules = node_modules,
        files = files,
        runtime = runtime,
        runtime_entry = runtime_entry,
        workspace_files = workspace_files,
        workspace_links = workspace_links,
        **kwargs
    )


def package_view(name, dependency_view, files, runtime, runtime_entry, workspace_dist = {}, **kwargs):
    """Assembles one bounded package view: owned sources, dist boundaries, one linked view.

    The importer dependency view already carries every dependency and workspace
    first hop as metadata links, so this view owns only bytes a resolver must
    find by `realpath` inside the package itself. `workspace_dist` maps a
    package-relative destination to the declared Buck `dist` artifact.
    """
    workspace_files = {}
    for destination in sorted(workspace_dist.keys()):
        _require_relative_path(destination, "workspace dist boundary")
        workspace_files[destination] = workspace_dist[destination]
    _package_tree(
        name = name,
        dependency_view = dependency_view,
        files = files,
        runtime = runtime,
        runtime_entry = runtime_entry,
        workspace_files = workspace_files,
        workspace_links = {},
        **kwargs
    )

def empty_package_view(name, files, runtime, runtime_entry, **kwargs):
    """Assembles a bounded package view for code with no package dependencies."""
    _package_tree(
        name = name,
        empty_dependencies = True,
        files = files,
        runtime = runtime,
        runtime_entry = runtime_entry,
        workspace_files = {},
        workspace_links = {},
        **kwargs
    )


def export_materialization_inputs(inputs):
    """Exports explicit root inputs for package-local rules."""
    names = {}
    for source in inputs:
        name = source.replace("$", "__dollar__")
        if name in names:
            fail("materialization input target collision: {} and {}".format(names[name], source))
        names[name] = source
        native.export_file(
            name = name,
            src = source,
            visibility = ["PUBLIC"],
        )
