import { readFileSync } from 'node:fs'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import dispositionArtifact from '../../buck2-operation-dispositions.json.genie.ts'
import { CI_JOB_NAMES } from '../ci.ts'
import {
  ciOperationDispositions,
  developerOperationDispositions,
  operationDispositionProjection,
} from './operation-dispositions.ts'

const sort = (values: Iterable<string>) => [...values].sort((left, right) => left.localeCompare(right))

const documentedDeveloperOperations = () => {
  const operations = new Set<string>()
  for (const path of ['AGENTS.md', 'README.md']) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/devenv tasks run ([^\s`]+)/g)) {
      const operation = match[1]
      if (operation !== '<task>') operations.add(operation)
    }
  }
  return sort(operations)
}

describe('Buck operation disposition coverage', () => {
  it('classifies every documented public developer operation exactly once', () => {
    expect(sort(Object.keys(developerOperationDispositions))).toEqual(documentedDeveloperOperations())
  })

  it('classifies every generated CI job exactly once', () => {
    expect(sort(Object.keys(ciOperationDispositions))).toEqual(sort(CI_JOB_NAMES))
  })

  it('uses only actionable or explicit policy dispositions', () => {
    for (const disposition of [
      ...Object.values(developerOperationDispositions),
      ...Object.values(ciOperationDispositions),
    ]) {
      expect(disposition).toMatch(
        /^(?:buck-owned|buck-pending:(?:static|editor|rust|consumer)|outside-by-policy:[a-z0-9-]+)$/,
      )
    }
  })

  it('projects the source registry without a second classification table', () => {
    expect(JSON.parse(dispositionArtifact.stringify({ cwd: process.cwd(), location: '' }))).toEqual({
      schemaVersion: 1,
      ...operationDispositionProjection,
    })
  })
})
