import { Effect, Exit, Schema } from 'effect'
import type { SchemaError } from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { NOTION_PROPERTY_TYPES } from '@overeng/notion-core'

import { DataSourceId, propertyWriteClassFromType } from './canonical.ts'
import {
  canonicalPropertyDescriptorJson,
  ConfigHash,
  decodePropertyDescriptor,
  decodePropertyDescriptors,
  PropertyIdentityEvidenceSource,
} from './descriptor.ts'

const hashOf = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`

const validDescriptor = {
  property_id: 'prop_abc',
  property_name: 'Status',
  property_type: 'select',
  data_source_id: '00000000-0000-4000-8000-000000000002',
  config_hash: hashOf(1),
}

const isFailure = <A>(exit: Exit.Exit<A, unknown>): boolean => Exit.isFailure(exit)

const decode = <A>(effect: Effect.Effect<A, SchemaError>): Exit.Exit<A, unknown> =>
  Effect.runSyncExit(effect)

describe('PropertyDescriptor decoding', () => {
  it('accepts a valid descriptor', () => {
    const exit = decode(decodePropertyDescriptor(validDescriptor))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it('rejects unknown fields (fails closed)', () => {
    const exit = decode(decodePropertyDescriptor({ ...validDescriptor, schema_hash: hashOf(2) }))
    expect(isFailure(exit)).toBe(true)
  })

  it('rejects a missing required field', () => {
    const { config_hash: _omitted, ...withoutHash } = validDescriptor
    expect(isFailure(decode(decodePropertyDescriptor(withoutHash)))).toBe(true)
  })

  it('rejects an unknown property type', () => {
    expect(
      isFailure(decode(decodePropertyDescriptor({ ...validDescriptor, property_type: 'mystery' }))),
    ).toBe(true)
  })

  it('rejects a malformed config hash', () => {
    expect(
      isFailure(
        decode(decodePropertyDescriptor({ ...validDescriptor, config_hash: 'not-a-hash' })),
      ),
    ).toBe(true)
  })

  it('decodes a descriptors map and rejects unknown fields inside an entry', () => {
    expect(Exit.isSuccess(decode(decodePropertyDescriptors({ Status: validDescriptor })))).toBe(
      true,
    )
    expect(
      isFailure(decode(decodePropertyDescriptors({ Status: { ...validDescriptor, extra: 'x' } }))),
    ).toBe(true)
  })
})

describe('canonical descriptor JSON', () => {
  it('produces stable schema-encoded bytes regardless of input key insertion order', () => {
    const reordered = {
      config_hash: validDescriptor.config_hash,
      property_type: validDescriptor.property_type,
      data_source_id: validDescriptor.data_source_id,
      property_name: validDescriptor.property_name,
      property_id: validDescriptor.property_id,
    }
    const left = Effect.runSync(decodePropertyDescriptor(validDescriptor))
    const right = Effect.runSync(decodePropertyDescriptor(reordered))
    expect(canonicalPropertyDescriptorJson(left)).toBe(canonicalPropertyDescriptorJson(right))
    expect(canonicalPropertyDescriptorJson(left)).toMatchInlineSnapshot(
      `"{"property_id":"prop_abc","property_name":"Status","property_type":"select","data_source_id":"00000000-0000-4000-8000-000000000002","config_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000001"}"`,
    )
  })
})

describe('DataSourceId brand', () => {
  const decodeId = Schema.decodeUnknownSync(DataSourceId)

  it('accepts a non-empty trimmed string', () => {
    expect(decodeId('00000000-0000-4000-8000-000000000002')).toBe(
      '00000000-0000-4000-8000-000000000002',
    )
  })

  it('rejects empty / whitespace input', () => {
    expect(isFailure(decode(Schema.decodeEffect(DataSourceId)('')))).toBe(true)
    expect(isFailure(decode(Schema.decodeEffect(DataSourceId)('  ')))).toBe(true)
  })
})

describe('ConfigHash brand', () => {
  it('accepts a sha256 hash and rejects other shapes', () => {
    expect(Schema.decodeSync(ConfigHash)(hashOf(7))).toBe(hashOf(7))
    expect(isFailure(decode(Schema.decodeEffect(ConfigHash)('md5:abc')))).toBe(true)
    expect(isFailure(decode(Schema.decodeEffect(ConfigHash)('sha256:XYZ')))).toBe(true)
  })
})

describe('PropertyIdentityEvidenceSource', () => {
  const decodeSource = Schema.decodeUnknownSync(PropertyIdentityEvidenceSource)

  it('decodes the three evidence-source variants', () => {
    for (const _tag of ['descriptor', 'workspace_state', 'live_schema'] as const) {
      expect(decodeSource({ _tag })._tag).toBe(_tag)
    }
  })

  it('rejects an unknown evidence source', () => {
    expect(
      isFailure(
        decode(Schema.decodeUnknownEffect(PropertyIdentityEvidenceSource)({ _tag: 'remote' })),
      ),
    ).toBe(true)
  })
})

describe('write-class consistency', () => {
  it('classifies writable, computed, and unsupported types', () => {
    const computed = new Set([
      'formula',
      'rollup',
      'created_time',
      'created_by',
      'last_edited_time',
      'last_edited_by',
      'unique_id',
      'verification',
    ])
    for (const type of NOTION_PROPERTY_TYPES) {
      const expected =
        computed.has(type) === true ? 'computed' : type === 'button' ? 'unsupported' : 'writable'
      expect(propertyWriteClassFromType(type), type).toBe(expected)
    }
  })

  it('treats unknown/ambiguous types as unsupported (fails closed)', () => {
    expect(propertyWriteClassFromType('future_type')).toBe('unsupported')
  })

  it('computed and unsupported types are never writable (R14)', () => {
    for (const type of ['formula', 'rollup', 'unique_id', 'verification', 'button', 'mystery']) {
      expect(propertyWriteClassFromType(type) === 'writable', type).toBe(false)
    }
  })
})
