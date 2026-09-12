import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('buck2/javascript.bzl test cache participation', () => {
  const javascriptRule = readFileSync('buck2/javascript.bzl', 'utf8')
  const platformDefs = readFileSync('buck2/platforms/defs.bzl', 'utf8')

  it('gates every test-executor cache switch on target and root policy', () => {
    expect(platformDefs).toContain('def root_remote_cache_enabled():')
    expect(platformDefs).toContain('def root_allow_cache_uploads():')
    expect(javascriptRule).toContain(
      'load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")',
    )
    expect(javascriptRule).toContain(
      'cache_enabled = ctx.attrs.cacheable and root_remote_cache_enabled()',
    )
    expect(javascriptRule).toContain(
      'cache_uploads = ctx.attrs.cacheable and root_allow_cache_uploads()',
    )

    for (const gated of [
      'remote_cache_enabled = cache_enabled,',
      'allow_cache_uploads = cache_uploads,',
      'supports_test_execution_caching = cache_enabled,',
    ]) {
      expect(javascriptRule).toContain(gated)
    }
    expect(javascriptRule).not.toMatch(
      /(?:remote_cache_enabled|allow_cache_uploads|supports_test_execution_caching) = cacheable,/u,
    )
  })
})

describe('portable JavaScript product cache policy', () => {
  const packageTools = readFileSync('buck2/package_tools.bzl', 'utf8')
  const productRules = readFileSync('buck2/products/defs.bzl', 'utf8')

  it('admits deterministic local product actions under the root shared-cache policy', () => {
    for (const source of [packageTools, productRules]) {
      expect(source).toContain(
        'load("//buck2/platforms:defs.bzl",',
      )
      expect(source).toContain('"root_allow_cache_uploads"')
      expect(source).toContain('"root_remote_cache_enabled"')
      expect(source).toContain(
        'allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),',
      )
    }
    expect(packageTools).toContain(
      'default_target_platform = "//buck2/platforms:javascript_portable",',
    )
  })

  it('keeps every result-affecting tool and product artifact in the action command line', () => {
    expect(packageTools).toContain(`toolchain.executable,
        _runner(ctx),
        "bundle",
        toolchain.executable,
        package_tree.tree,`)
    expect(packageTools).toContain('"--platform-gated-manifest",')
    expect(packageTools).toContain('gated.manifest,')
    expect(packageTools).toContain('args.add(cmd_args(hidden = package_tree.read_roots))')
    expect(productRules).toContain(`toolchain.executable,
        _runner(ctx),
        "product-descriptor",`)
    expect(productRules).toContain(`"--module-descriptor",
        module.descriptor,`)
  })

  it('retains the non-product package check and build cache exceptions', () => {
    for (const category of ['package_bin_check', 'package_bin_build']) {
      expect(packageTools).toContain(`category = "${category}",
        local_only = True,
        allow_cache_upload = False,`)
    }
  })
})
