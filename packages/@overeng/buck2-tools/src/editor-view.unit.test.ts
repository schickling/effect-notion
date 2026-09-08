import { describe, expect, it } from 'vitest'

import {
  defaultEditorViewName,
  editorViewSchema,
  workspaceDependencyAuthoritySchema,
} from './editor-view.ts'

describe('editor view record', () => {
  it('owns a stable versioned schema identifier', () => {
    expect(editorViewSchema).toBe('effect-utils/editor-view/v2')
  })

  it('owns a stable whole-workspace dependency authority schema', () => {
    expect(workspaceDependencyAuthoritySchema).toBe(
      'effect-utils/workspace-dependency-authority/v1',
    )
  })
})

describe('editor view identity', () => {
  it('defaults the view name to the package directory name', () => {
    expect(defaultEditorViewName('packages/@overeng/tui-core')).toBe('tui-core')
    expect(defaultEditorViewName('packages/@overeng/tui-react')).toBe('tui-react')
  })

  it('rejects package paths and view names that are not portable identifiers', () => {
    expect(() => defaultEditorViewName('/packages/@overeng/tui-core')).toThrow(
      'package must be a normalized repository-relative path',
    )
    expect(() => defaultEditorViewName('packages/@overeng/tui.core')).toThrow(
      'view name must be a portable identifier',
    )
  })
})
