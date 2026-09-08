"""Lockfile-derived pnpm normalized store rules (decisions 0022 and 0030).

Generated-data API
------------------
A translator calls ``pnpm_platform_configurations()`` once in its generated
package, then declares:

* ``pnpm_package(name, package_name, url, sha256, bins = {}, patches = [])`` once per
  resolved package version. ``sha256`` is the lowercase hex value from the
  freshness-gated sidecar; the rule performs the only network action and the
  capability-backed archive tool extracts the npm ``package/`` tree offline.
  Each package's ``bins`` maps its executable names to package-relative files.
* ``pnpm_store_entry(name, package, store_key, runtime, ...)`` once per
  peer-resolved snapshot for the whole repository. Edges are given either as
  ``dependencies = {<name>: <entry target>}`` when the lockfile resolves the
  same edges everywhere, or as ``dependencies_by_platform`` when it does not.
  A component member passes ``scc`` instead and declares no edges.
  ``package_override`` names an immutable absolute directory that supplies the
  entry's package bytes instead of the registry archive. A Nix-grafted native
  addon uses it: one normalized entry carries the built addon, so every
  importer and alias resolves the same bytes with no per-consumer copy and no
  host lookup at test time. An empty string keeps the archive.
* ``pnpm_store_scc(name, members, runtime, internal_edges, ...)`` once per real
  lockfile cycle. ``members`` maps each distinct virtual-store key to its
  package target; ``internal_edges`` or ``internal_edges_by_platform`` uses
  ``"<source-key>\\t<name>" -> <target-key>`` and must stay inside the
  component.
* ``pnpm_store_view(name, runtime, direct, closure, bins, ...)`` once per
  importer. ``direct`` maps a dependency name to a store key, ``closure`` maps
  every reachable store key to its entry target, and ``bins`` uses
  ``<bin-name> -> "<store-key>\\t<entrypoint>"``. A view materializes only
  directories and links: it adds no dependency bytes per consumer and exposes
  ``PnpmDeclaredClosureInfo``.

Every store key is one pnpm-encoded, single-component virtual-store path
component including its peer identity. ``workspace_trees`` maps a stable,
single-component workspace key to a declared package-view target; the view
re-exports that target's own declared roots so a workspace first hop stays
resolvable inside a sandbox without copying its dependency bytes. Assembly
is an offline action and never reads a package-manager store. Per-platform
maps have exactly the keys ``linux_x86_64``, ``linux_aarch64``, and
``macos_aarch64``; the macros own the mandatory cpu/os ``select()``.
"""

load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

PnpmPackageInfo = provider(fields = {
    "bins": provider_field(dict[str, str]),
    "package_name": str,
    "tree": Artifact,
})

PnpmDeclaredClosureInfo = provider(fields = {
    "manifest": Artifact,
    "node_modules": Artifact,
    "read_roots": provider_field(list[Artifact]),
    "toolchain_identity": str,
})

# The lockfile's own cpu/os/libc gates, projected as data.
#
# A package tree is materialized for one platform, so the store deliberately
# omits every optional package gated to another. A portable product must go
# further and omit the gated packages this platform DOES provide: inlining a
# host-native binding would make the product bytes host-specific. Which names
# those are is decided by the lockfile, never by scanning what happens to be
# on disk.
PnpmPlatformGatedPackagesInfo = provider(fields = {
    "manifest": Artifact,
})


def _platform_gated_packages_impl(ctx):
    manifest = ctx.actions.declare_output("platform-gated-packages.json")
    families = []
    packages = {}
    for family in sorted(ctx.attrs.families.keys()):
        names = sorted(ctx.attrs.families[family])
        if not names:
            fail("platform-gated family {} declares no packages".format(family))
        for name in names:
            if name in packages:
                fail("platform-gated package {} is claimed by two families".format(name))
            packages[name] = family
        families.append({
            "capability": ctx.attrs.capabilities.get(family),
            "family": family,
            "packages": names,
        })
    ctx.actions.write_json(manifest, {
        "schema": "effect-utils/pnpm-platform-gated-packages/v1",
        "families": families,
        "packages": sorted(packages.keys()),
    }, pretty = True)
    return [
        DefaultInfo(default_output = manifest),
        PnpmPlatformGatedPackagesInfo(manifest = manifest),
    ]


pnpm_platform_gated_packages = rule(
    impl = _platform_gated_packages_impl,
    attrs = {
        "capabilities": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "families": attrs.dict(key = attrs.string(), value = attrs.list(attrs.string()), default = {}),
    },
)


def _unique_artifacts(artifacts):
    seen = {}
    roots = []
    for artifact in artifacts:
        if artifact not in seen:
            seen[artifact] = True
            roots.append(artifact)
    return roots

# The admitted platforms a lockfile-derived `select()` must cover exactly. The
# portable platform is one of them, not a fallback: a configuration that
# matches none of the four fails analysis, which is what keeps an unadmitted
# platform from silently inheriting some other platform's package set.
_PLATFORMS = ["javascript_portable", "linux_aarch64", "linux_x86_64", "macos_aarch64"]
_PLATFORM_CONFIGURATIONS = {
    "javascript_portable": ":_pnpm_javascript_portable",
    "linux_x86_64": ":_pnpm_linux_x86_64",
    "linux_aarch64": ":_pnpm_linux_aarch64",
    "macos_aarch64": ":_pnpm_macos_aarch64",
}


def _require_sha256(value):
    if len(value) != 64:
        fail("pnpm package sha256 must contain exactly 64 lowercase hex digits")
    for character in value.elems():
        if character not in "0123456789abcdef":
            fail("pnpm package sha256 must contain exactly 64 lowercase hex digits")

def _require_url(value):
    if not value.startswith("https://"):
        fail("pnpm package URL must use https: {}".format(value))


def _require_portable_path(value, field):
    if not value or value.startswith("/") or "\\" in value or "\x00" in value:
        fail("{} must be a non-empty portable relative path: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _require_absolute_path(value, field):
    if not value.startswith("/") or "\\" in value or "\x00" in value or value.endswith("/"):
        fail("{} must be an absolute, immutable directory path: {}".format(field, value))
    for component in value.split("/")[1:]:
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _require_store_key(value, field):
    _require_portable_path(value, field)
    if "/" in value:
        fail("{} must be one virtual-store path component: {}".format(field, value))


def _record(value, field):
    parts = value.split("\t")
    if len(parts) != 2:
        fail("{} must use the owner\\tname record encoding: {}".format(field, value))
    _require_store_key(parts[0], "{} owner".format(field))
    _require_portable_path(parts[1], "{} name".format(field))
    return parts


def _fetch_impl(ctx):
    _require_sha256(ctx.attrs.sha256)
    _require_url(ctx.attrs.url)
    out = ctx.actions.download_file(
        "package.tgz",
        ctx.attrs.url,
        sha256 = ctx.attrs.sha256,
    )
    return [DefaultInfo(default_output = out)]


_fetch = rule(
    impl = _fetch_impl,
    attrs = {
        "sha256": attrs.string(),
        "url": attrs.string(),
    },
)


def _extract_impl(ctx):
    out = ctx.actions.declare_output("package", dir = True)
    strip_prefix = "package"
    if ctx.attrs.package_name.startswith("@types/"):
        strip_prefix = ctx.attrs.package_name.split("/")[-1]
    args = cmd_args([
        ctx.attrs._archive_tool[RunInfo],
        "extract-npm",
        "--archive",
        ctx.attrs.archive,
        "--out",
        out.as_output(),
        "--strip-prefix",
        strip_prefix,
    ])
    for patch in ctx.attrs.patches:
        args.add("--patch", patch)
    ctx.actions.run(
        args,
        category = "pnpm_extract",
        identifier = ctx.attrs.name,
        allow_cache_upload = True,
    )
    for name, entrypoint in ctx.attrs.bins.items():
        _require_portable_path(name, "package bin name")
        _require_portable_path(entrypoint, "package bin entrypoint")
    return [
        DefaultInfo(default_output = out),
        PnpmPackageInfo(bins = ctx.attrs.bins, package_name = ctx.attrs.package_name, tree = out),
    ]


_extract = rule(
    impl = _extract_impl,
    attrs = {
        "archive": attrs.source(),
        "bins": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "package_name": attrs.string(),
        "patches": attrs.list(attrs.source(), default = []),
        "_archive_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:archive_tool",
            providers = [RunInfo],
        )),
    },
)


def pnpm_package(name, package_name, url, sha256, bins = {}, patches = [], **kwargs):
    """Declares one hash-pinned fetch and one offline npm extraction target."""
    _require_url(url)
    _require_portable_path(package_name, "package_name")
    _require_sha256(sha256)
    fetch_name = "{}__fetch".format(name)
    _fetch(
        name = fetch_name,
        sha256 = sha256,
        url = url,
        visibility = [],
    )
    _extract(
        name = name,
        archive = ":{}".format(fetch_name),
        bins = bins,
        package_name = package_name,
        patches = patches,
        **kwargs
    )


def pnpm_platform_configurations():
    """Declares the four config settings owned by the store selects."""
    native.config_setting(
        name = "_pnpm_javascript_portable",
        constraint_values = [
            "//buck2/platforms:abi_any",
            "//buck2/platforms:cpu_any",
            "//buck2/platforms:os_any",
        ],
        visibility = [],
    )
    native.config_setting(
        name = "_pnpm_linux_x86_64",
        constraint_values = [
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        visibility = [],
    )
    native.config_setting(
        name = "_pnpm_linux_aarch64",
        constraint_values = [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        visibility = [],
    )
    native.config_setting(
        name = "_pnpm_macos_aarch64",
        constraint_values = [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
        visibility = [],
    )


def _platform_select(values, field):
    if sorted(values.keys()) != _PLATFORMS:
        fail("{} must provide exactly these admitted platforms: {}".format(field, ", ".join(_PLATFORMS)))
    return select({_PLATFORM_CONFIGURATIONS[platform]: values[platform] for platform in _PLATFORMS})


# ---------------------------------------------------------------------------
# Normalized store (decision 0030)
#
# One entry per peer-resolved snapshot for the whole repository, one sandboxed
# assembly per strongly connected component, and metadata-only importer views.
# A view adds no dependency bytes, so a consumer never receives a second copy
# of a dependency.
#
# Only entries whose lockfile edges actually differ per platform receive a
# configured `select()`; the generator derives that set from the lockfile
# rather than declaring how many such entries exist.
# ---------------------------------------------------------------------------

PnpmStoreEntryInfo = provider(fields = {
    # `artifact` is always the owning action's root. A standalone normalized
    # entry owns its artifact; a component member points into its group.
    "artifact": Artifact,
    "bins": provider_field(dict[str, str]),
    "entry_path": str,
    "package_name": str,
    "read_roots": provider_field(list[Artifact]),
    "store_key": str,
})

PnpmStoreSccInfo = provider(fields = {
    "group": Artifact,
    "members": provider_field(dict[str, str]),
    "read_roots": provider_field(list[Artifact]),
})


def _exactly_one(invariant, by_platform, field):
    if (invariant == None) == (by_platform == None):
        fail("{} requires exactly one of the invariant or per-platform form".format(field))
    if by_platform == None:
        return invariant
    return _platform_select(by_platform, field)


def _entry_dir(info):
    if info.entry_path == "":
        return info.artifact
    return cmd_args(info.artifact, format = "{}/" + info.entry_path)


def _entry_link_args(args, flag, name, entry):
    info = entry[PnpmStoreEntryInfo]
    args.add(flag, name, info.package_name, _entry_dir(info))


def _workspace_tree(view):
    outputs = view[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("a workspace dependency must declare exactly one package view output: {}".format(view.label))
    return outputs[0]


def _workspace_roots(view):
    # A package view exports its own declared roots as `other_outputs`, so the
    # sibling's dependency view and store entries travel with the first hop.
    return [_workspace_tree(view)] + list(view[DefaultInfo].other_outputs)


def _store_entry_impl(ctx):
    _require_store_key(ctx.attrs.store_key, "store_key")
    package = ctx.attrs.package[PnpmPackageInfo]
    _require_portable_path(package.package_name, "package name")

    dependency_keys = sorted(ctx.attrs.dependencies.keys())
    for name in dependency_keys:
        _require_portable_path(name, "dependency name")

    override = ctx.attrs.package_override
    if override != "":
        _require_absolute_path(override, "package_override")

    if ctx.attrs.scc != None:
        if override != "":
            fail("a component member cannot override its package bytes: {}".format(ctx.attrs.store_key))
        group = ctx.attrs.scc[PnpmStoreSccInfo]
        if group.members.get(ctx.attrs.store_key) != package.package_name:
            fail("{} is not a declared member of its component".format(ctx.attrs.store_key))
        if dependency_keys:
            fail("a component member declares its edges on the component, not the entry: {}".format(ctx.attrs.store_key))
        return [
            DefaultInfo(default_output = group.group),
            PnpmStoreEntryInfo(
                artifact = group.group,
                bins = package.bins,
                entry_path = "{}/node_modules".format(ctx.attrs.store_key),
                package_name = package.package_name,
                read_roots = group.read_roots,
                store_key = ctx.attrs.store_key,
            ),
        ]

    out = ctx.actions.declare_output("entry", dir = True)
    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs.runtime,
        "--mode",
        "entry",
        "--output",
        out.as_output(),
        "--package-name",
        package.package_name,
    ])

    # Exactly one declared source of package bytes. An override replaces the
    # registry archive outright, so the archive is not joined as an input: the
    # entry would otherwise claim bytes it never materializes. The override path
    # is content-addressed and immutable, and it appears in the command line, so
    # the action key still distinguishes overridden from archive-backed bytes.
    if override == "":
        args.add("--package-tree", package.tree)
    else:
        args.add("--package-override", override)
    bins = {}
    read_root_candidates = [out]
    for name in dependency_keys:
        read_root_candidates.extend(ctx.attrs.dependencies[name][PnpmStoreEntryInfo].read_roots)
    read_roots = _unique_artifacts(read_root_candidates)
    for name in dependency_keys:
        dependency = ctx.attrs.dependencies[name]
        _entry_link_args(args, "--dependency", name, dependency)
        info = dependency[PnpmStoreEntryInfo]
        for bin_name, entrypoint in info.bins.items():
            _require_portable_path(bin_name, "dependency bin name")
            _require_portable_path(entrypoint, "dependency bin entrypoint")
            value = (info.package_name, info.artifact, info.entry_path, entrypoint)
            existing = bins.get(bin_name)
            if existing != None and existing != value:
                fail("{} exposes ambiguous bin {}".format(ctx.attrs.store_key, bin_name))
            bins[bin_name] = value
    for bin_name in sorted(bins.keys()):
        package_name, artifact, entry_path, entrypoint = bins[bin_name]
        args.add(
            "--bin",
            bin_name,
            package_name,
            artifact if entry_path == "" else cmd_args(artifact, format = "{}/" + entry_path),
            entrypoint,
        )
    ctx.actions.run(
        args,
        category = "pnpm_store_entry",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(
            default_output = out,
            other_outputs = read_roots[1:],
        ),
        PnpmStoreEntryInfo(
            artifact = out,
            bins = package.bins,
            entry_path = "node_modules",
            package_name = package.package_name,
            store_key = ctx.attrs.store_key,
            read_roots = read_roots,
        ),
    ]


_store_entry = rule(
    impl = _store_entry_impl,
    attrs = {
        "dependencies": attrs.dict(
            key = attrs.string(),
            value = attrs.dep(providers = [PnpmStoreEntryInfo]),
            default = {},
        ),
        "package": attrs.dep(providers = [PnpmPackageInfo]),
        "package_override": attrs.string(default = ""),
        "runtime": attrs.source(),
        "scc": attrs.option(attrs.dep(providers = [PnpmStoreSccInfo]), default = None),
        "store_key": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def pnpm_store_entry(
        name,
        package,
        store_key,
        runtime,
        dependencies = None,
        dependencies_by_platform = None,
        package_override = "",
        scc = None,
        **kwargs):
    """Declares one normalized store entry; only varying edges are selected."""
    _store_entry(
        name = name,
        dependencies = {} if scc != None else _exactly_one(
            dependencies,
            dependencies_by_platform,
            "pnpm_store_entry dependencies",
        ),
        package = package,
        package_override = package_override,
        runtime = runtime,
        scc = scc,
        store_key = store_key,
        **kwargs
    )


def _store_scc_impl(ctx):
    members = {}
    for store_key in sorted(ctx.attrs.members.keys()):
        _require_store_key(store_key, "component member key")
        package = ctx.attrs.members[store_key][PnpmPackageInfo]
        _require_portable_path(package.package_name, "component member package name")
        members[store_key] = package
    if not members:
        fail("a component must declare at least one member")

    out = ctx.actions.declare_output("group", dir = True)
    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs.runtime,
        "--mode",
        "scc",
        "--output",
        out.as_output(),
    ])
    for store_key in sorted(members.keys()):
        args.add("--member", store_key, members[store_key].package_name, members[store_key].tree)
    for record in sorted(ctx.attrs.internal_edges.keys()):
        source, dependency_name = _record(record, "internal_edges")
        target = ctx.attrs.internal_edges[record]
        if source not in members or target not in members:
            fail("internal_edges names a package outside the declared component: {} -> {}".format(record, target))
        args.add("--member-dependency", source, dependency_name, target)
        for bin_name, entrypoint in members[target].bins.items():
            args.add("--member-bin", source, bin_name, target, entrypoint)
    for record in sorted(ctx.attrs.external_edges.keys()):
        source, dependency_name = _record(record, "external_edges")
        if source not in members:
            fail("external_edges names an undeclared member: {}".format(record))
        entry = ctx.attrs.external_edges[record][PnpmStoreEntryInfo]
        if entry.store_key in members:
            fail("external_edges names component member {}; declare it as an internal edge".format(entry.store_key))
        args.add("--member-external", source, dependency_name, entry.package_name, _entry_dir(entry))
        for bin_name, entrypoint in entry.bins.items():
            args.add("--member-external-bin", source, bin_name, entry.package_name, _entry_dir(entry), entrypoint)
    read_root_candidates = [out]
    for record in sorted(ctx.attrs.external_edges.keys()):
        read_root_candidates.extend(ctx.attrs.external_edges[record][PnpmStoreEntryInfo].read_roots)
    read_roots = _unique_artifacts(read_root_candidates)
    ctx.actions.run(
        args,
        category = "pnpm_store_scc",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = out, other_outputs = read_roots[1:]),
        PnpmStoreSccInfo(
            group = out,
            members = {key: members[key].package_name for key in members},
            read_roots = read_roots,
        ),
    ]


_store_scc = rule(
    impl = _store_scc_impl,
    attrs = {
        "external_edges": attrs.dict(
            key = attrs.string(),
            value = attrs.dep(providers = [PnpmStoreEntryInfo]),
            default = {},
        ),
        "internal_edges": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "members": attrs.dict(key = attrs.string(), value = attrs.dep(providers = [PnpmPackageInfo])),
        "runtime": attrs.source(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def pnpm_store_scc(
        name,
        members,
        runtime,
        internal_edges = None,
        internal_edges_by_platform = None,
        external_edges = None,
        external_edges_by_platform = None,
        **kwargs):
    """Assembles one strongly connected component with platform-selected edges."""
    _store_scc(
        name = name,
        external_edges = _exactly_one(
            external_edges,
            external_edges_by_platform,
            "pnpm_store_scc external_edges",
        ),
        internal_edges = _exactly_one(
            internal_edges,
            internal_edges_by_platform,
            "pnpm_store_scc internal_edges",
        ),
        members = members,
        runtime = runtime,
        **kwargs
    )


def _store_view_impl(ctx):
    closure = ctx.attrs.closure
    for store_key in closure.keys():
        _require_store_key(store_key, "closure key")
    for store_key in ctx.attrs.workspace_trees.keys():
        _require_store_key(store_key, "workspace key")
    for name, store_key in ctx.attrs.direct.items():
        _require_portable_path(name, "direct dependency")
        if store_key not in closure:
            fail("direct names a store entry outside the declared closure: {}".format(store_key))
    for name, workspace_key in ctx.attrs.workspace_dependencies.items():
        _require_portable_path(name, "direct workspace dependency")
        if workspace_key not in ctx.attrs.workspace_trees:
            fail("workspace_dependencies names an undeclared workspace: {}".format(workspace_key))
    for name in ctx.attrs.direct.keys():
        if name in ctx.attrs.workspace_dependencies:
            fail("{} is declared as both a package and a workspace dependency".format(name))

    out = ctx.actions.declare_output("node_modules", dir = True)
    manifest = ctx.actions.declare_output("view-manifest.json")
    ctx.actions.write_json(manifest, {
        "schema": "effect-utils/pnpm-store-view/v1",
        "bins": ctx.attrs.bins,
        "closure": sorted(closure.keys()),
        "direct": ctx.attrs.direct,
        "workspaceDependencies": ctx.attrs.workspace_dependencies,
    }, pretty = True)

    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs.runtime,
        "--mode",
        "view",
        "--output",
        out.as_output(),
    ])
    for name in sorted(ctx.attrs.direct.keys()):
        _entry_link_args(args, "--link", name, closure[ctx.attrs.direct[name]])
    for name in sorted(ctx.attrs.workspace_dependencies.keys()):
        args.add("--workspace-link", name, _workspace_tree(ctx.attrs.workspace_trees[ctx.attrs.workspace_dependencies[name]]))
    for bin_name in sorted(ctx.attrs.bins.keys()):
        _require_portable_path(bin_name, "bin name")
        store_key, entrypoint = _record(ctx.attrs.bins[bin_name], "bins")
        if store_key not in closure:
            fail("bins names a store entry outside the declared closure: {}".format(store_key))
        _require_portable_path(entrypoint, "bin entrypoint")
        entry = closure[store_key][PnpmStoreEntryInfo]
        args.add("--bin", bin_name, entry.package_name, _entry_dir(entry), entrypoint)
    read_root_candidates = [out]
    for key in sorted(closure.keys()):
        read_root_candidates.extend(closure[key][PnpmStoreEntryInfo].read_roots)
    for key in sorted(ctx.attrs.workspace_trees.keys()):
        # A workspace first hop resolves through the sibling's own view, so its
        # declared roots travel with the link instead of being copied into it.
        read_root_candidates.extend(_workspace_roots(ctx.attrs.workspace_trees[key]))
    read_roots = _unique_artifacts(read_root_candidates)

    # Every root reachable through the view's links is both an action input and
    # an exported declared root for downstream sandbox mounting and hashing.
    args.add(cmd_args(hidden = read_roots[1:]))
    ctx.actions.run(
        args,
        category = "pnpm_store_view",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(
            default_output = out,
            other_outputs = [manifest] + read_roots[1:],
        ),
        PnpmDeclaredClosureInfo(
            manifest = manifest,
            node_modules = out,
            read_roots = read_roots,
            toolchain_identity = ctx.attrs._bun[BunToolchainInfo].identity,
        ),
    ]


_store_view = rule(
    impl = _store_view_impl,
    attrs = {
        "bins": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "closure": attrs.dict(
            key = attrs.string(),
            value = attrs.dep(providers = [PnpmStoreEntryInfo]),
            default = {},
        ),
        "direct": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "runtime": attrs.source(),
        "workspace_dependencies": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "workspace_trees": attrs.dict(key = attrs.string(), value = attrs.dep(providers = [DefaultInfo]), default = {}),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def pnpm_store_view(
        name,
        runtime,
        closure = None,
        closure_by_platform = None,
        direct = None,
        direct_by_platform = None,
        bins = None,
        bins_by_platform = None,
        workspace_trees = {},
        workspace_dependencies = {},
        **kwargs):
    """Declares one metadata-only importer dependency view over the shared store."""
    _store_view(
        name = name,
        bins = _exactly_one(bins, bins_by_platform, "pnpm_store_view bins"),
        closure = _exactly_one(closure, closure_by_platform, "pnpm_store_view closure"),
        direct = _exactly_one(direct, direct_by_platform, "pnpm_store_view direct"),
        runtime = runtime,
        workspace_dependencies = workspace_dependencies,
        workspace_trees = workspace_trees,
        **kwargs
    )
