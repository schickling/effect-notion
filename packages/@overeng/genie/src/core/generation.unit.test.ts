import { describe, expect, it } from 'vitest'

import { addHeaderComment, getHeaderComment, pinStagedModuleIdentity } from './generation.ts'

describe('getHeaderComment', () => {
  it.each(['BUCK', 'defs.bzl', 'tooling.bxl'])(
    'uses Starlark comments for %s',
    (targetFilePath) => {
      expect(
        getHeaderComment({
          targetFilePath,
          sourceFile: `${targetFilePath}.genie.ts`,
        }),
      ).toBe(`# Generated file - DO NOT EDIT\n# Source: ${targetFilePath}.genie.ts\n\n`)
    },
  )

  it('uses shell comments for shell scripts', () => {
    expect(
      getHeaderComment({
        targetFilePath: 'genie/ci-scripts/run-with-nix-gc-race-retry.sh',
        sourceFile: 'run-with-nix-gc-race-retry.sh.genie.ts',
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: run-with-nix-gc-race-retry.sh.genie.ts\n\n')
  })
})

describe('getExpectedContent', () => {
  it('keeps shell shebangs before generated provenance', () => {
    expect(
      addHeaderComment({
        header: '# Generated file - DO NOT EDIT\n# Source: run.sh.genie.ts\n\n',
        content: '#!/usr/bin/env bash\nexit 0\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env bash',
        '# Generated file - DO NOT EDIT',
        '# Source: run.sh.genie.ts',
        '',
        'exit 0',
        '',
      ].join('\n'),
    )
  })

  it('keeps non-shell shebangs before generated provenance', () => {
    // A hashbang is only legal as the very first bytes of a file, so a banner emitted ahead of it
    // turns a `.mjs` into a SyntaxError rather than merely mis-executing it.
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: tool.mjs.genie.ts\n',
        content: '#!/usr/bin/env node\nexport const run = () => {}\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env node',
        '// Generated file - DO NOT EDIT',
        '// Source: tool.mjs.genie.ts',
        'export const run = () => {}',
        '',
      ].join('\n'),
    )
  })

  it('prepends the banner when there is no shebang', () => {
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\n',
        content: 'export const x = 1\n',
      }),
    ).toBe('// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\nexport const x = 1\n')
  })
})

describe('pinStagedModuleIdentity', () => {
  const sourcePath = '/repo/generators/identity.json.genie.ts'
  const pin = (sourceCode: string) => pinStagedModuleIdentity({ sourceCode, sourcePath })

  it('pins each identity field to the original source location', () => {
    expect(pin('export const id = import.meta.url')).toBe(
      'export const id = "file:///repo/generators/identity.json.genie.ts"',
    )
    expect(pin('export const dir = import.meta.dirname')).toBe(
      'export const dir = "/repo/generators"',
    )
    expect(pin('export const file = import.meta.filename')).toBe(
      'export const file = "/repo/generators/identity.json.genie.ts"',
    )
  })

  it('pins accesses written with arbitrary whitespace and interleaved comments', () => {
    expect(pin('export const id = import\n  . meta\n  . url')).toBe(
      'export const id = "file:///repo/generators/identity.json.genie.ts"',
    )
    expect(pin('export const dir = import . /* here */ meta . dirname')).toBe(
      'export const dir = "/repo/generators"',
    )
  })

  it('leaves comments and string literals byte-identical', () => {
    // Genie generates TypeScript, so a generator legitimately documents or emits the very text
    // being pinned. A textual rewrite corrupts exactly these bytes.
    const sourceCode = [
      '// derives identity from import.meta.url',
      '/* also import . meta . dirname */',
      `const emitted = "const here = import.meta.filename"`,
      "const single = 'import.meta.url'",
      'const template = `emits import.meta.dirname verbatim`',
      'export const emit = () => [emitted, single, template]',
    ].join('\n')

    expect(pin(sourceCode)).toBe(sourceCode)
  })

  it('pins interpolations inside a template literal without touching its raw text', () => {
    expect(pin('const t = `import.meta.url is ${import.meta.url}`')).toBe(
      'const t = `import.meta.url is ${"file:///repo/generators/identity.json.genie.ts"}`',
    )
  })

  it('leaves other import.meta members and same-named property accesses alone', () => {
    const sourceCode = [
      'const resolved = import.meta.resolve("./sibling.ts")',
      'const shadowed = { url: 1 }.url',
      'const meta = import.meta',
    ].join('\n')

    expect(pin(sourceCode)).toBe(sourceCode)
  })

  it('returns the input unchanged when there is no identity access', () => {
    const sourceCode = 'export const value = 1\n'
    expect(pin(sourceCode)).toBe(sourceCode)
  })

  it('pins identity in TSX sources', () => {
    expect(
      pinStagedModuleIdentity({
        sourceCode: 'export const view = () => <div title={import.meta.url} />',
        sourcePath: '/repo/generators/view.genie.tsx',
      }),
    ).toBe('export const view = () => <div title={"file:///repo/generators/view.genie.tsx"} />')
  })
})
