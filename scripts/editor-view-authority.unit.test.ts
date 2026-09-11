import { describe, expect, it } from 'bun:test'

import { editorViewPackagePaths, editorViewPlan } from './editor-view-authority.ts'

describe('editor view authority orchestration', () => {
  it('derives one deterministic editor publication entry per workspace consumer', () => {
    const plan = editorViewPlan({ cell: 'workspace_cell' })

    expect(plan.packages.map(({ packagePath }) => packagePath)).toEqual(editorViewPackagePaths)
    expect(plan.packages).toHaveLength(39)
    expect(plan.packages[0]?.editor).toMatchObject({
      cell: 'workspace_cell',
      inputsManifestTarget: 'workspace_cell//:editor_view_inputs',
      target: '//:editor_inputs',
      viewName: 'root',
    })
    for (const entry of plan.packages.slice(1)) {
      expect(entry.editor?.cell).toBe('workspace_cell')
      expect(entry.editor?.inputsManifestTarget).toBe(
        `workspace_cell//${entry.packagePath}:editor_view_inputs`,
      )
      expect(entry.editor?.target).toBe(`//${entry.packagePath}:editor_inputs`)
    }
  })
})
