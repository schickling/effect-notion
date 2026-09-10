import { describe, expect, it } from 'vitest'

import { selectAppAuthSource } from '../src/node/GitHubClient.ts'

describe('selectAppAuthSource', () => {
  const auth = { installationIDs: { schickling: 118180206, livestorejs: 150357842 } }

  it('uses the configured installation for a known owner', () => {
    expect(selectAppAuthSource({ auth, repo: 'livestorejs/livestore' })).toEqual({
      _tag: 'app-installation',
      owner: 'livestorejs',
      installationID: 150357842,
    })
  })

  it('falls back to the gh CLI token for an owner without an installation', () => {
    expect(selectAppAuthSource({ auth, repo: 'vercel/next.js' })).toEqual({
      _tag: 'cli-token-fallback',
      owner: 'vercel',
    })
  })

  it('rejects slugs that are not owner/repo', () => {
    expect(() => selectAppAuthSource({ auth, repo: 'vercel' })).toThrow(/owner\/repo/)
  })
})
