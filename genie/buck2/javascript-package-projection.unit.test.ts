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
