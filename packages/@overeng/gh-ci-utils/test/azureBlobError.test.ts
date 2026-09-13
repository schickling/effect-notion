import { describe, expect, it } from 'vitest'

import { isAzureBlobError } from '../src/node/GitHubClient.ts'

describe('isAzureBlobError', () => {
  it('detects XML error response from Azure Blob Storage', () => {
    const xmlError = `<?xml version="1.0" encoding="utf-8"?><Error><Code>BlobNotFound</Code><Message>The specified blob does not exist.\nRequestId:7dbeac44-201e-0068-23ce-bdbc31000000\nTime:2026-03-27T09:48:00.8921323Z</Message></Error>`
    expect(isAzureBlobError(xmlError)).toBe(true)
  })

  it('detects XML response without BlobNotFound code', () => {
    const xmlError = `<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request.</Message></Error>`
    expect(isAzureBlobError(xmlError)).toBe(true)
  })

  it('detects BlobNotFound even without XML declaration', () => {
    const partial = `<Error><Code>BlobNotFound</Code><Message>not found</Message></Error>`
    expect(isAzureBlobError(partial)).toBe(true)
  })

  it('does not flag normal log content', () => {
    const log = `2026-03-27T09:18:25Z ##[group]Run actions/checkout@v4\n2026-03-27T09:18:30Z ##[error]Process completed with exit code 1.`
    expect(isAzureBlobError(log)).toBe(false)
  })

  it('does not flag empty string', () => {
    expect(isAzureBlobError('')).toBe(false)
  })
})
