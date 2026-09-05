# Generated file - DO NOT EDIT
# Source: root_test_layout.bzl.genie.ts

"""Root-package inputs of the repository-root Vitest suite.

The suite under `genie/buck2` and `buck2/dependencies` loads repository
generator sources by their original relative paths, and the root Buck package
owns some of them. They are declared here rather than globbed in `BUCK` so the
census is derived from the suite's actual import closure
(`genie/buck2/root-test-layout.ts`) and fails freshness when it drifts.
"""

load("//buck2:materialization.bzl", "export_materialization_inputs")

# Root-package generator directories: mount prefix -> (tree-relative destination
# -> root-package source). Each becomes one `filegroup` the root test package
# tree mounts at `<mount prefix>`, which reproduces the original paths.
ROOT_TEST_SOURCE_TREES = {
    ".github": {
        "repo-settings.json": ".github/repo-settings.json",
        "workflows/auto-review.yml": ".github/workflows/auto-review.yml",
        "workflows/ci.yml": ".github/workflows/ci.yml",
        "workflows/ci.yml.genie.ts": ".github/workflows/ci.yml.genie.ts",
    },
    "buck2": {
        "materialization.bzl": "buck2/materialization.bzl",
        "root_test_layout.bzl": "buck2/root_test_layout.bzl",
        "typescript.bzl": "buck2/typescript.bzl",
    },
    "genie": {
        "auto-review.ts": "genie/auto-review.ts",
        "ci-scripts/bootstrap-closure-check.ts": "genie/ci-scripts/bootstrap-closure-check.ts",
        "ci-scripts/bootstrap-cold-proof.sh": "genie/ci-scripts/bootstrap-cold-proof.sh",
        "ci-scripts/buck2-cache-lane.sh": "genie/ci-scripts/buck2-cache-lane.sh",
        "ci-scripts/buck2-cache-preflight.sh": "genie/ci-scripts/buck2-cache-preflight.sh",
        "ci-scripts/buck2-candidate-graph.txt": "genie/ci-scripts/buck2-candidate-graph.txt",
        "ci-scripts/buck2-candidate-graph.txt.genie.ts": "genie/ci-scripts/buck2-candidate-graph.txt.genie.ts",
        "ci-scripts/bundle-smoke.ts": "genie/ci-scripts/bundle-smoke.ts",
        "ci-scripts/ci-measurement-comparison.test.sh": "genie/ci-scripts/ci-measurement-comparison.test.sh",
        "ci-scripts/cleanup-effect-utils-composition.sh": "genie/ci-scripts/cleanup-effect-utils-composition.sh",
        "ci-scripts/native-binding-closure-check.test.sh": "genie/ci-scripts/native-binding-closure-check.test.sh",
        "ci-scripts/native-binding-closure-check.ts": "genie/ci-scripts/native-binding-closure-check.ts",
        "ci-scripts/native-dep-policy-audit.test.sh": "genie/ci-scripts/native-dep-policy-audit.test.sh",
        "ci-scripts/native-dep-policy-audit.ts": "genie/ci-scripts/native-dep-policy-audit.ts",
        "ci-scripts/native-dep-policy-lib.ts": "genie/ci-scripts/native-dep-policy-lib.ts",
        "ci-scripts/nix-gc-race-retry.sh": "genie/ci-scripts/nix-gc-race-retry.sh",
        "ci-scripts/nix-gc-race-retry.sh.genie.ts": "genie/ci-scripts/nix-gc-race-retry.sh.genie.ts",
        "ci-scripts/nix-gc-race-retry.test.sh": "genie/ci-scripts/nix-gc-race-retry.test.sh",
        "ci-scripts/pr-snapshot-artifact.mjs": "genie/ci-scripts/pr-snapshot-artifact.mjs",
        "ci-scripts/pr-snapshot-artifact.test.mjs": "genie/ci-scripts/pr-snapshot-artifact.test.mjs",
        "ci-scripts/prepare-effect-utils-composition.sh": "genie/ci-scripts/prepare-effect-utils-composition.sh",
        "ci-scripts/prepare-job-local-rust-state.sh": "genie/ci-scripts/prepare-job-local-rust-state.sh",
        "ci-scripts/prepare-job-local-rust-state.sh.genie.ts": "genie/ci-scripts/prepare-job-local-rust-state.sh.genie.ts",
        "ci-scripts/resolve-devenv.sh": "genie/ci-scripts/resolve-devenv.sh",
        "ci-scripts/resolve-devenv.sh.genie.ts": "genie/ci-scripts/resolve-devenv.sh.genie.ts",
        "ci-scripts/run-with-nix-gc-race-retry.sh": "genie/ci-scripts/run-with-nix-gc-race-retry.sh",
        "ci-scripts/run-with-nix-gc-race-retry.sh.genie.ts": "genie/ci-scripts/run-with-nix-gc-race-retry.sh.genie.ts",
        "ci-workflow.ts": "genie/ci-workflow.ts",
        "ci-workflow/deploy.ts": "genie/ci-workflow/deploy.ts",
        "ci-workflow/measurements.ts": "genie/ci-workflow/measurements.ts",
        "ci-workflow/megarepo.ts": "genie/ci-workflow/megarepo.ts",
        "ci-workflow/merge-queue.ts": "genie/ci-workflow/merge-queue.ts",
        "ci-workflow/pr-snapshot.ts": "genie/ci-workflow/pr-snapshot.ts",
        "ci-workflow/release.ts": "genie/ci-workflow/release.ts",
        "ci-workflow/reporting.ts": "genie/ci-workflow/reporting.ts",
        "ci-workflow/setup.ts": "genie/ci-workflow/setup.ts",
        "ci-workflow/shared.ts": "genie/ci-workflow/shared.ts",
        "ci-workflow/support-files.ts": "genie/ci-workflow/support-files.ts",
        "ci.ts": "genie/ci.ts",
        "deploy-preview/netlify.ts": "genie/deploy-preview/netlify.ts",
        "deploy-preview/shared.ts": "genie/deploy-preview/shared.ts",
        "deploy-preview/vercel.ts": "genie/deploy-preview/vercel.ts",
        "external.ts": "genie/external.ts",
        "internal.ts": "genie/internal.ts",
        "labels.ts": "genie/labels.ts",
        "native-dependency-policy.ts": "genie/native-dependency-policy.ts",
        "otel-scrape-registry.ts": "genie/otel-scrape-registry.ts",
        "oxfmt-base.ts": "genie/oxfmt-base.ts",
        "oxlint-base.ts": "genie/oxlint-base.ts",
        "packages.ts": "genie/packages.ts",
        "system-labels.ts": "genie/system-labels.ts",
        "tsconfig-projects.ts": "genie/tsconfig-projects.ts",
        "weaver-registry/attributes.yaml.genie.ts": "genie/weaver-registry/attributes.yaml.genie.ts",
        "weaver-registry/constants.rs.genie.ts": "genie/weaver-registry/constants.rs.genie.ts",
        "weaver-registry/constants.ts": "genie/weaver-registry/constants.ts",
        "weaver-registry/constants.ts.genie.ts": "genie/weaver-registry/constants.ts.genie.ts",
        "weaver-registry/manifest.yaml.genie.ts": "genie/weaver-registry/manifest.yaml.genie.ts",
        "weaver-registry/registry.ts": "genie/weaver-registry/registry.ts",
        "weaver-registry/signals.yaml.genie.ts": "genie/weaver-registry/signals.yaml.genie.ts",
    },
    "nix": {
        "buck2-products/products.json": "nix/buck2-products/products.json",
    },
}

# Root-package generator sources that sit directly at the repository root and
# therefore cannot belong to a mounted directory tree.
ROOT_TEST_SOURCE_FILES = [
    "BUCK",
    "buck2-member.json.genie.ts",
    "devenv.nix",
    "package.json.genie.ts",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
]

def declare_root_test_sources(visibility = ["PUBLIC"]):
    """Exports every root-package input the root test package tree stages."""
    export_materialization_inputs(ROOT_TEST_SOURCE_FILES)
    for prefix in sorted(ROOT_TEST_SOURCE_TREES):
        native.filegroup(
            name = "root_test_sources/" + prefix,
            srcs = ROOT_TEST_SOURCE_TREES[prefix],
            visibility = visibility,
        )
