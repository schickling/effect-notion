import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runTsVirtualProject } from './ts-api.ts'

const root = path.resolve('/genie-virtual/ts-api')
const entry = path.resolve(root, 'entry.ts')

describe('runTsVirtualProject', () => {
  it('reports project-wide diagnostics that belong to no file', async () => {
    // `noLib` removes the global types the checker needs but pins the failure to the PROJECT, not to
    // any source position: TypeScript reports it only through `getGlobalDiagnostics`. Collecting just
    // config/program/syntactic/semantic diagnostics makes a broken lib or global-type resolution pass
    // vacuously, which would silently hollow out every proof built on this helper.
    const messages = await runTsVirtualProject({
      root,
      files: new Map([[entry, 'export const answer = 42\n']]),
      rootFiles: [entry],
      compilerOptions: { noEmit: true, noLib: true, strict: true, target: 'es2024' },
      use: async (project) => project.diagnosticMessages(),
    })

    expect(messages.some((message) => message.includes("Cannot find global type 'Array'"))).toBe(
      true,
    )
  })

  it('reports no diagnostics for a project that compiles', async () => {
    const messages = await runTsVirtualProject({
      root,
      files: new Map([[entry, 'export const answer: number = 42\n']]),
      rootFiles: [entry],
      compilerOptions: { noEmit: true, strict: true, target: 'es2024' },
      use: async (project) => project.diagnosticMessages(),
    })

    expect(messages).toEqual([])
  })
})
