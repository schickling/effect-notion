import { describe, expect, it } from 'vitest'

import {
  parseAllResolvedVersionsFromLockfile,
  parseSnapshotDependencyConsumers,
  validateCatalogDuplicates,
} from './mod.ts'

const makeLockfileYaml = (packages: string[]) => {
  const lines = ["lockfileVersion: '9.0'", '', 'packages:', '']
  for (const spec of packages) {
    lines.push(spec.startsWith('@') === true ? `  '${spec}':` : `  ${spec}:`)
    lines.push('    resolution: {integrity: sha512-fake}')
    lines.push('')
  }
  lines.push('snapshots:', '')
  return lines.join('\n')
}

describe('parseAllResolvedVersionsFromLockfile', () => {
  it('collects every version per package, not just the first', () => {
    const yaml = makeLockfileYaml([
      'string-width@7.2.0',
      'string-width@8.2.0',
      'string-width@8.2.1',
    ])
    const result = parseAllResolvedVersionsFromLockfile(yaml)
    expect(result.get('string-width')).toEqual(new Set(['7.2.0', '8.2.0', '8.2.1']))
  })

  it('handles scoped packages and skips parenthesised resolution entries', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  '@effect/platform@0.96.0':",
      '    resolution: {integrity: sha512-a}',
      '',
      "  '@effect/platform@0.96.0(effect@3.21.0)':",
      '    resolution: {integrity: sha512-b}',
      '',
      'snapshots:',
      '',
    ]
    const result = parseAllResolvedVersionsFromLockfile(lines.join('\n'))
    expect(result.get('@effect/platform')).toEqual(new Set(['0.96.0']))
  })
})

describe('parseSnapshotDependencyConsumers', () => {
  it('finds peer resolutions inside hashed injected workspace snapshots', () => {
    const yaml = [
      "lockfileVersion: '9.0'",
      '',
      'snapshots:',
      '',
      "  '@overeng/utils-dev@file:packages/@overeng/utils-dev(hash)':",
      '    dependencies:',
      '      effect: 4.0.0-beta.99',
      '',
    ].join('\n')
    expect(parseSnapshotDependencyConsumers({ dependency: 'effect', yamlContent: yaml })).toEqual(
      new Map([
        ['4.0.0-beta.99', new Set(['@overeng/utils-dev@file:packages/@overeng/utils-dev(hash)'])],
      ]),
    )
  })
})

describe('validateCatalogDuplicates', () => {
  const catalog = { 'string-width': '8.2.1', effect: '3.21.4', prettier: '3.8.4' }

  it('passes when every catalog package resolves to a single version', () => {
    const yaml = makeLockfileYaml(['string-width@8.2.1', 'effect@3.21.4', 'prettier@3.8.4'])
    expect(validateCatalogDuplicates({ catalog, lockfileContent: yaml })).toEqual([])
  })

  it('errors on an unblessed duplicate of a catalog package', () => {
    const yaml = makeLockfileYaml([
      'string-width@7.2.0',
      'string-width@8.2.0',
      'string-width@8.2.1',
    ])
    const issues = validateCatalogDuplicates({ catalog, lockfileContent: yaml })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.rule).toBe('catalog-duplicate-version')
    expect(issues[0]!.dependency).toBe('string-width')
    /* newest-first ordering */
    expect(issues[0]!.message).toContain('8.2.1, 8.2.0, 7.2.0')
  })

  it('ignores duplicates of packages not in the catalog', () => {
    const yaml = makeLockfileYaml(['lodash@4.17.20', 'lodash@4.17.21'])
    expect(validateCatalogDuplicates({ catalog, lockfileContent: yaml })).toEqual([])
  })

  it('downgrades a blessed duplicate to a warning and names the reason', () => {
    const yaml = makeLockfileYaml(['string-width@7.2.0', 'string-width@8.2.1'])
    const issues = validateCatalogDuplicates({
      catalog,
      lockfileContent: yaml,
      exceptions: [
        { package: 'string-width', reason: '@opentui/core hard-pins 7.2.0', issue: '#820' },
      ],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.rule).toBe('catalog-duplicate-version-acknowledged')
    expect(issues[0]!.message).toContain('@opentui/core hard-pins 7.2.0')
    expect(issues[0]!.message).toContain('#820')
  })

  it('accepts an exact version set for an intentional multi-major graph', () => {
    const yaml = makeLockfileYaml(['effect@3.21.4', 'effect@4.0.0-beta.99'])
    const issues = validateCatalogDuplicates({
      catalog,
      lockfileContent: yaml,
      exceptions: [
        {
          package: 'effect',
          versions: ['3.21.4', '4.0.0-beta.99'],
          isolatedVersions: ['4.0.0-beta.99'],
          reason: 'separate Effect 3 and Effect 4 package cohorts',
        },
      ],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.rule).toBe('catalog-duplicate-version-acknowledged')
  })

  it('errors when an acknowledged multi-major graph drifts from its exact version set', () => {
    const yaml = makeLockfileYaml(['effect@3.21.4', 'effect@4.0.0-beta.98', 'effect@4.0.0-beta.99'])
    const issues = validateCatalogDuplicates({
      catalog,
      lockfileContent: yaml,
      exceptions: [
        {
          package: 'effect',
          versions: ['3.21.4', '4.0.0-beta.99'],
          reason: 'separate Effect 3 and Effect 4 package cohorts',
          issue: '#937',
        },
      ],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.rule).toBe('catalog-duplicate-exception-version-drift')
    expect(issues[0]!.message).toContain('permits exactly: 3.21.4, 4.0.0-beta.99')
  })

  // The repo's own TypeScript exception is pinned to `['7.0.2', '6.0.3']` (production compiler plus the
  // isolated oxc-config one). An unpinned exception blesses whatever the lock happens to hold, so the
  // pin is what makes a THIRD compiler — an older peer such as 5.9.3 creeping back in — fail closed
  // rather than ride along on the acknowledgement.
  it('errors when an extra OLDER version joins an exactly pinned compiler cohort', () => {
    const compilerCatalog = { typescript: '7.0.2' }
    const exceptions = [
      {
        package: 'typescript',
        versions: ['7.0.2', '6.0.3'],
        reason: 'production compiles with 7 while the lint rule-tester harness keeps 6',
        issue: '#821',
      },
    ]

    const pinned = validateCatalogDuplicates({
      catalog: compilerCatalog,
      lockfileContent: makeLockfileYaml(['typescript@6.0.3', 'typescript@7.0.2']),
      exceptions,
    })
    expect(pinned).toHaveLength(1)
    expect(pinned[0]!.rule).toBe('catalog-duplicate-version-acknowledged')

    const drifted = validateCatalogDuplicates({
      catalog: compilerCatalog,
      lockfileContent: makeLockfileYaml([
        'typescript@5.9.3',
        'typescript@6.0.3',
        'typescript@7.0.2',
      ]),
      exceptions,
    })
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.severity).toBe('error')
    expect(drifted[0]!.rule).toBe('catalog-duplicate-exception-version-drift')
    expect(drifted[0]!.message).toContain('7.0.2, 6.0.3, 5.9.3')
    expect(drifted[0]!.message).toContain('permits exactly: 7.0.2, 6.0.3')
  })

  it('errors when an importer-only version leaks into a snapshot peer graph', () => {
    const yaml = [
      makeLockfileYaml(['effect@3.21.4', 'effect@4.0.0-beta.99']),
      "  '@overeng/utils-dev@file:packages/@overeng/utils-dev(hash)':",
      '    dependencies:',
      '      effect: 4.0.0-beta.99',
      '',
    ].join('\n')
    const issues = validateCatalogDuplicates({
      catalog,
      lockfileContent: yaml,
      exceptions: [
        {
          package: 'effect',
          versions: ['3.21.4', '4.0.0-beta.99'],
          isolatedVersions: ['4.0.0-beta.99'],
          reason: 'separate Effect 3 and Effect 4 package cohorts',
        },
      ],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.rule).toBe('catalog-duplicate-isolated-version-leak')
    expect(issues[0]!.message).toContain('@overeng/utils-dev')
  })

  it('flags a stale exception that no longer matches a duplicate', () => {
    const yaml = makeLockfileYaml(['string-width@8.2.1'])
    const issues = validateCatalogDuplicates({
      catalog,
      lockfileContent: yaml,
      exceptions: [{ package: 'string-width', reason: 'was locked', issue: '#820' }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.rule).toBe('catalog-duplicate-stale-exception')
  })
})
