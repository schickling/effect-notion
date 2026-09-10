import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { StoreState } from './cli/renderers/StoreOutput/schema.ts'
import { MegarepoConfig } from './core/config.ts'
import { LockFile, LockedMember } from './core/lock.ts'

const encodeJson = <A, I>(schema: Schema.Codec<A, I>, value: A): string =>
  Schema.encodeSync(Schema.fromJsonString(schema, { space: 2 }))(value)

const decodeJson = <A, I>(schema: Schema.Codec<A, I>, encoded: string): A =>
  Schema.decodeSync(Schema.fromJsonString(schema))(encoded)

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A) => {
  const encoded = encodeJson(schema, value)
  const decoded = decodeJson(schema, encoded)
  const reencoded = encodeJson(schema, decoded)

  return {
    encoded,
    decoded,
    reencoded,
    byteIdentical: reencoded === encoded,
  }
}

const decodeFailure = <A, I>(schema: Schema.Codec<A, I>, encoded: string) => {
  try {
    return { _tag: 'decoded' as const, value: decodeJson(schema, encoded) }
  } catch (error) {
    return {
      _tag: 'failed' as const,
      error: error instanceof Error ? String(error) : String(error),
    }
  }
}

describe('megarepo wire baselines (cross-major invariant)', () => {
  it('captures megarepo config JSON bytes and failure partition', () => {
    expect(
      roundTrip(
        MegarepoConfig,
        new MegarepoConfig({
          $schema: 'https://example.invalid/megarepo.schema.json',
          members: {
            '': './empty-name',
            'unicode-ß': 'https://github.com/example/unicode#feature/ß',
            windows: '../windows\r\npath',
          },
          generators: {
            vscode: {
              enabled: true,
              exclude: ['tmp', 'unicode-ß'],
              color: '#123abc',
              colorEnvVar: 'MEGAREPO_COLOR',
              settings: {
                'editor.formatOnSave': true,
                'terminal.integrated.defaultProfile.linux': 'bash\r\nzsh',
                nullable: null,
              },
            },
            composition: {
              enabled: true,
              platformHub: 'unicode-hub',
              isolationDir: 'fleet-buck',
            },
          },
          lockSync: {
            enabled: false,
            exclude: ['unicode-ß'],
            sharedInputSource: 'nixpkgs',
          },
        }),
      ),
    ).toMatchSnapshot()

    expect({
      nullDocument: decodeFailure(MegarepoConfig, 'null'),
      missingMembers: decodeFailure(MegarepoConfig, '{}'),
      nullMemberSource: decodeFailure(MegarepoConfig, '{"members":{"bad":null}}'),
    }).toMatchSnapshot()
  })

  it('captures megarepo lock JSON bytes and failure partition', () => {
    expect(
      roundTrip(
        LockFile,
        new LockFile({
          version: 1,
          members: {
            'unicode-ß': new LockedMember({
              url: 'https://github.com/example/unicode',
              ref: 'feature/ß',
              commit: '0123456789abcdef0123456789abcdef01234567',
              pinned: true,
              lockedAt: '2026-07-28T11:50:00.000Z',
            }),
            'out-of-range-date-string': new LockedMember({
              url: 'git@github.com:example/out-of-range.git',
              ref: 'main',
              commit: 'ffffffffffffffffffffffffffffffffffffffff',
              pinned: false,
              lockedAt: '99999-99-99T99:99:99.999Z',
            }),
          },
        }),
      ),
    ).toMatchSnapshot()

    expect({
      nullDocument: decodeFailure(LockFile, 'null'),
      missingPinned: decodeFailure(
        LockFile,
        '{"version":1,"members":{"repo":{"url":"https://github.com/example/repo","ref":"main","commit":"0123456789abcdef0123456789abcdef01234567","lockedAt":"2026-07-28T11:50:00.000Z"}}}',
      ),
      nullMembers: decodeFailure(LockFile, '{"version":1,"members":null}'),
    }).toMatchSnapshot()
  })

  it('captures megarepo store state JSON bytes and failure partition', () => {
    expect(
      roundTrip(StoreState, {
        _tag: 'Gc',
        basePath: '/store/root',
        dryRun: true,
        showForceHint: false,
        warning: {
          type: 'custom',
          message: 'line one\r\nline two',
        },
        results: [
          {
            repo: 'example/unicode',
            ref: 'feature/ß',
            refType: 'heads',
            path: '/store/root/github.com/example/unicode/refs/heads/feature/ß',
            status: 'kept',
            reason: 'live',
            message: 'protected by workspace registry',
          },
          {
            repo: 'example/commit',
            ref: '0123456789abcdef0123456789abcdef01234567',
            refType: 'commits',
            path: '/store/root/github.com/example/commit/refs/commits/0123456789abcdef0123456789abcdef01234567',
            status: 'archived',
            recoverPath: '/store/root/.archive/example-commit',
            pathRef: 'main',
            actualHeadBranch: 'feature/old',
          },
        ],
        processedCount: 2,
        repoCount: 2,
        completedRepoCount: 1,
        discoveredWorktreeCount: 3,
        activeWorktreeCount: 1,
        statusMessage: 'gc complete',
        done: true,
        interrupted: false,
      }),
    ).toMatchSnapshot()

    expect({
      nullDocument: decodeFailure(StoreState, 'null'),
      unknownTag: decodeFailure(StoreState, '{"_tag":"Unknown"}'),
      nullOptionalMessage: decodeFailure(StoreState, '{"_tag":"Error","error":"E","message":null}'),
    }).toMatchSnapshot()
  })
})
