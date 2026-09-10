import { describe, expect, it } from 'vitest'

import type { RegistryFragment as OtelRegistryFragment } from '@overeng/otel-contract/registry'

import type { RegistryFragment } from '../weaver/mod.ts'
import { orphanSeamPaths, type RegistryMember, registryFromMembers } from './mod.ts'

// Compile-time drift guard: `@overeng/otel-contract` `./registry` cannot import genie (cycle),
// so it re-declares a mirror of this Layer-1 `RegistryFragment`. genie CAN type-import otel-
// contract (allowed direction), so this assignment fails to compile if the mirrors drift apart.
const _driftGuard = (f: OtelRegistryFragment): RegistryFragment => f
void _driftGuard

const member = (f: RegistryFragment): RegistryMember => ({
  data: f,
  stringify: () => '',
  meta: { registry: f },
})

const acme: RegistryFragment = {
  namespace: 'acme',
  memberPath: 'packages/acme',
  displayName: 'Acme',
  attributes: [
    { id: 'acme.name', type: 'string', brief: 'n', stability: 'development', examples: ['x'] },
  ],
  foreignRefs: [],
  signals: [
    {
      kind: 'span',
      id: 'span.acme.x',
      span_kind: 'internal',
      brief: 'x',
      stability: 'development',
      attributes: [{ ref: 'acme.name', requirement_level: 'required' }],
    },
  ],
}

describe('registryFromMembers (SC-R08/R09)', () => {
  it('composes cleanly with no integrity issues', () => {
    const { registry, issues } = registryFromMembers({
      members: [member(acme)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues).toEqual([])
    expect(registry.groups.map((g) => g.namespace)).toEqual(['acme'])
  })

  it('reports a duplicate-namespace issue when two members claim the same namespace', () => {
    const { issues } = registryFromMembers({
      members: [member(acme), member({ ...acme, memberPath: 'packages/acme2' })],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues.some((i) => i.rule === 'weaver/duplicate-namespace')).toBe(true)
  })

  it('reports a dangling-ref issue for a cross-member ref that resolves nowhere', () => {
    const dangling: RegistryFragment = {
      ...acme,
      namespace: 'beta',
      memberPath: 'packages/beta',
      attributes: [
        { id: 'beta.k', type: 'string', brief: 'k', stability: 'development', examples: ['x'] },
      ],
      signals: [
        {
          kind: 'span',
          id: 'span.beta.y',
          span_kind: 'internal',
          brief: 'y',
          stability: 'development',
          // references acme.name, which is NOT present when acme is absent → dangling.
          attributes: [{ ref: 'acme.name', requirement_level: 'required' }],
        },
      ],
    }
    const { issues } = registryFromMembers({
      members: [member(dangling)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues.some((i) => i.rule === 'weaver/dangling-ref')).toBe(true)
  })

  it('carries per-entry owner/source/constName through composition into the registry (typed)', () => {
    // Mirror-elimination flow-through: the additive per-entry metadata must survive from a member
    // fragment into the COMPOSED registry that downstream consumers read — TYPED, not cast.
    const owned: RegistryFragment = {
      namespace: 'owned',
      memberPath: 'packages/owned',
      displayName: 'Owned',
      attributes: [
        {
          id: 'owned.k',
          type: 'string',
          brief: 'k',
          stability: 'development',
          examples: ['x'],
          owner: 'team-a',
          source: 'owned/k.ts',
          constName: 'OWNED_K',
        },
      ],
      foreignRefs: [],
      signals: [
        {
          kind: 'metric',
          id: 'metric.owned.m',
          metric_name: 'owned.m',
          instrument: 'counter',
          unit: '1',
          brief: 'm',
          stability: 'development',
          owner: 'team-b',
          constName: 'OWNED_M',
          attributes: [{ ref: 'owned.k', requirement_level: 'required' }],
        },
      ],
    }
    const { registry } = registryFromMembers({
      members: [member(owned)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    const attribute = registry.groups[0]!.attributes[0]!
    expect(attribute.owner).toBe('team-a')
    expect(attribute.source).toBe('owned/k.ts')
    expect(attribute.constName).toBe('OWNED_K')
    const signal = registry.signals[0]!
    expect(signal.owner).toBe('team-b')
    expect(signal.constName).toBe('OWNED_M')
    expect('source' in signal).toBe(false)
  })

  it('defers upstream-namespaced refs to weaver (no dangling issue)', () => {
    const withUpstream: RegistryFragment = {
      ...acme,
      signals: [
        {
          kind: 'span',
          id: 'span.acme.http',
          span_kind: 'client',
          brief: 'h',
          stability: 'development',
          attributes: [
            { ref: 'acme.name', requirement_level: 'required' },
            { ref: 'http.request.method', requirement_level: 'recommended' },
          ],
        },
      ],
    }
    const { issues } = registryFromMembers({
      members: [member(withUpstream)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
      upstream: [
        {
          dependency: { name: 'otel', registry_path: 'x', schema_url: 's' },
          providesNamespaces: ['http'],
        },
      ],
    })
    expect(issues).toEqual([])
  })
})

describe('orphanSeamPaths (decision 0005 keystone)', () => {
  it('returns [] when every seam on disk is imported', () => {
    expect(
      orphanSeamPaths({
        seamFilesOnDisk: ['a/x.contract.ts'],
        importedSeamPaths: ['a/x.contract.ts'],
      }),
    ).toEqual([])
  })

  it('FAILS (reports the orphan) when a seam is on disk but not imported', () => {
    expect(
      orphanSeamPaths({
        seamFilesOnDisk: ['a/x.contract.ts', 'b/orphan.contract.ts'],
        importedSeamPaths: ['a/x.contract.ts'],
      }),
    ).toEqual(['b/orphan.contract.ts'])
  })
})
