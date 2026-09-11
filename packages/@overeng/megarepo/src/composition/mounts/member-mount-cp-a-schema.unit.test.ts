import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  CP_A_MEMBER_MOUNT_TRANSACTION_VERSION,
  CpAMemberMountRequest,
  CpAMemberMountTransaction,
  cpAMemberMountDestinationPath,
  cpAMemberMountTransactionPath,
  encodeCpAMountMemberFilename,
} from './member-mount-cp-a-schema.ts'

const metadata = {
  version: 2 as const,
  member: 'dep',
  lockedCommit: 'a'.repeat(40),
  sourcePathIdentity: `sha256:${'b'.repeat(64)}`,
  repository: { digest: `sha256:${'c'.repeat(64)}`, count: 2 },
  capabilities: { present: true, digest: `sha256:${'d'.repeat(64)}`, count: 1 },
  declaredOverlays: [],
  overlays: [],
  publishedPath: '/workspace/repos/dep',
}

describe('cp-a lifecycle schemas', () => {
  it('encodes member transaction filenames bijectively without path separators', () => {
    expect(() => encodeCpAMountMemberFilename('é/unsafe')).toThrow()
    expect(encodeCpAMountMemberFilename('é-dep')).toBe('v1-c3a92d646570.json')
    expect(cpAMemberMountTransactionPath({ workspaceRoot: '/workspace', member: 'é-dep' })).toBe(
      '/workspace/repos/.mr/transactions/v1-c3a92d646570.json',
    )
  })

  it('rejects relative paths, traversal-like members, and malformed commits', () => {
    const decode = Schema.decodeUnknownSync(CpAMemberMountRequest)
    expect(() =>
      decode({
        workspaceRoot: 'relative',
        member: '../dep',
        sourcePath: '/source',
        capabilitiesPath: '/caps',
        distOverlays: [],
        lockedCommit: 'short',
        dryRun: false,
        allowVerifiedDarwinAdvance: false,
      }),
    ).toThrow()
  })

  it('strictly decodes the identity-bound transaction envelope', () => {
    const transaction = Schema.decodeSync(CpAMemberMountTransaction, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      version: CP_A_MEMBER_MOUNT_TRANSACTION_VERSION,
      member: 'dep',
      sourcePath: '/source',
      destinationPath: '/workspace/repos/dep',
      stagePath: '/workspace/repos/.mr-stage-dep-1',
      operation: 'FirstPublish',
      phaseHint: 'Intent',
      oldIdentity: { _tag: 'Missing' },
      newIdentity: { metadata, candidateIdentity: null },
    })
    expect(transaction.newIdentity.metadata.lockedCommit).toBe('a'.repeat(40))
    expect(() =>
      Schema.decodeUnknownSync(CpAMemberMountTransaction, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ ...transaction, unexpected: true }),
    ).toThrow()
  })

  it('derives only validated member destinations under repos', () => {
    expect(cpAMemberMountDestinationPath({ workspaceRoot: '/workspace', member: 'dep' })).toBe(
      '/workspace/repos/dep',
    )
    expect(() =>
      cpAMemberMountDestinationPath({ workspaceRoot: '/workspace', member: '../escape' }),
    ).toThrow()
  })
})
