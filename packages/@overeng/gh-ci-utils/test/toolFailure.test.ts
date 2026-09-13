import { Cause } from 'effect'
import { describe, expect, it } from 'vitest'

import { renderToolFailure } from '../src/node/lib/toolFailure.ts'

describe('renderToolFailure', () => {
  const cause = Cause.fail(new Error('No GitHub App installation is configured for `external-org`'))

  it('renders the error on one line for a direct invocation', () => {
    expect(renderToolFailure({ cause, routedFrom: undefined })).toBe(
      'No GitHub App installation is configured for `external-org`',
    )
  })

  it('names the gh-real escape hatch when the call came through the gh wrapper', () => {
    expect(renderToolFailure({ cause, routedFrom: 'gh' })).toBe(
      'No GitHub App installation is configured for `external-org`\n' +
        "the raw GitHub CLI is available as 'gh-real ...' (e.g. 'gh-real run view --log-failed <run-id>')",
    )
  })

  it('treats an empty routed-from as a direct invocation', () => {
    expect(renderToolFailure({ cause, routedFrom: '' })).not.toContain('gh-real')
  })

  it('still says something when the cause carries no message', () => {
    expect(renderToolFailure({ cause: Cause.empty, routedFrom: 'gh' })).toBe(
      'gh-ci-utils failed without reporting an error\n' +
        "the raw GitHub CLI is available as 'gh-real ...' (e.g. 'gh-real run view --log-failed <run-id>')",
    )
  })
})
