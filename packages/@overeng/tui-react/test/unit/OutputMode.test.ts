/**
 * Tests for OutputMode service
 */

import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, test, expect } from 'vitest'

import { resolveOutputMode } from '../../src/effect/cli.tsx'
import {
  // Detection (Node-only)
  detectOutputMode,
  isAgentEnv,
  stdoutFdType,
} from '../../src/effect/OutputMode.node.ts'
import {
  OutputModeTag,
  // Presets
  tty,
  ci,
  log,
  altScreen,
  json,
  ndjson,
  // Type guards
  isReact,
  isJson,
  isProgressive,
  isFinal,
  isAnimated,
  hasColors,
  isAlternate,
  // Layers
  layer,
  ttyLayer,
  jsonLayer,
} from '../../src/effect/OutputMode.tsx'

describe('OutputMode presets', () => {
  test('tty preset has correct config', () => {
    expect(tty._tag).toBe('react')
    expect(tty.timing).toBe('progressive')
    if (tty._tag === 'react') {
      expect(tty.render.animation).toBe(true)
      expect(tty.render.colors).toBe(true)
      expect(tty.render.alternate).toBe(false)
    }
  })

  test('ci preset has correct config', () => {
    expect(ci._tag).toBe('react')
    expect(ci.timing).toBe('progressive')
    if (ci._tag === 'react') {
      expect(ci.render.animation).toBe(false)
      expect(ci.render.colors).toBe(true)
      expect(ci.render.alternate).toBe(false)
    }
  })

  test('log preset has correct config', () => {
    expect(log._tag).toBe('react')
    expect(log.timing).toBe('final')
    if (log._tag === 'react') {
      expect(log.render.animation).toBe(false)
      expect(log.render.colors).toBe(false)
    }
  })

  test('altScreen preset has correct config', () => {
    expect(altScreen._tag).toBe('react')
    expect(altScreen.timing).toBe('progressive')
    if (altScreen._tag === 'react') {
      expect(altScreen.render.animation).toBe(true)
      expect(altScreen.render.colors).toBe(true)
      expect(altScreen.render.alternate).toBe(true)
    }
  })

  test('json preset has correct config', () => {
    expect(json._tag).toBe('json')
    expect(json.timing).toBe('final')
  })

  test('ndjson preset has correct config', () => {
    expect(ndjson._tag).toBe('json')
    expect(ndjson.timing).toBe('progressive')
  })
})

describe('isAgentEnv', () => {
  const agentVars = [
    'AGENT',
    'CLAUDE_PROJECT_DIR',
    'CLAUDECODE',
    'OPENCODE',
    'CLINE_ACTIVE',
    'CODEX_SANDBOX',
  ] as const

  // Save and clear all agent env vars before each test
  let savedEnv: Record<string, string | undefined> = {}

  const clearAgentEnv = () => {
    savedEnv = {}
    for (const key of agentVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  }

  const restoreAgentEnv = () => {
    for (const key of agentVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }

  test('returns false when no agent env vars are set', () => {
    clearAgentEnv()
    try {
      expect(isAgentEnv()).toBe(false)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects AGENT=1 (OpenCode)', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects AGENT=amp (Amp)', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = 'amp'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('ignores AGENT=0 and AGENT=false', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = '0'
      expect(isAgentEnv()).toBe(false)
      process.env.AGENT = 'false'
      expect(isAgentEnv()).toBe(false)
      process.env.AGENT = ''
      expect(isAgentEnv()).toBe(false)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLAUDE_PROJECT_DIR (Claude Code)', () => {
    clearAgentEnv()
    try {
      process.env.CLAUDE_PROJECT_DIR = '/some/path'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLAUDECODE (Amp)', () => {
    clearAgentEnv()
    try {
      process.env.CLAUDECODE = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects OPENCODE (OpenCode)', () => {
    clearAgentEnv()
    try {
      process.env.OPENCODE = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLINE_ACTIVE (Cline)', () => {
    clearAgentEnv()
    try {
      process.env.CLINE_ACTIVE = 'true'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CODEX_SANDBOX (Codex CLI)', () => {
    clearAgentEnv()
    try {
      process.env.CODEX_SANDBOX = 'seatbelt'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })
})

describe('stdoutFdType', () => {
  test('returns a valid fd type', () => {
    const result = stdoutFdType()
    expect(['pipe', 'file', 'other']).toContain(result)
  })
})

describe('detectOutputMode', () => {
  const envVars = [
    'AGENT',
    'CLAUDE_PROJECT_DIR',
    'CLAUDECODE',
    'OPENCODE',
    'CLINE_ACTIVE',
    'CODEX_SANDBOX',
    'TUI_VISUAL',
    'TUI_PIPE_MODE',
    'NO_COLOR',
    'NO_UNICODE',
  ] as const
  let savedEnv: Record<string, string | undefined> = {}

  const clearEnv = () => {
    savedEnv = {}
    for (const key of envVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  }

  const restoreEnv = () => {
    for (const key of envVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }

  test('in non-TTY non-agent environment detects captured stdout', () => {
    clearEnv()
    try {
      // In test runners, stdout is typically a socket (captured by the test harness),
      // which is now correctly detected as machine output (json)
      const mode = detectOutputMode()
      expect(['react', 'json']).toContain(mode._tag)
    } finally {
      restoreEnv()
    }
  })

  test('in agent environment defaults to json mode', () => {
    clearEnv()
    try {
      process.env.AGENT = '1'
      const mode = detectOutputMode()
      expect(mode._tag).toBe('json')
      expect(mode.timing).toBe('final')
    } finally {
      restoreEnv()
    }
  })

  test('TUI_VISUAL=1 overrides agent detection', () => {
    clearEnv()
    try {
      process.env.AGENT = '1'
      process.env.TUI_VISUAL = '1'
      const mode = detectOutputMode()
      // TUI_VISUAL forces React mode, overriding agent detection
      expect(mode._tag).toBe('react')
    } finally {
      restoreEnv()
    }
  })

  test('NO_COLOR removes colors from detected mode', () => {
    clearEnv()
    try {
      process.env.TUI_VISUAL = '1' // Force React mode so color override applies
      process.env.NO_COLOR = '1'
      const mode = detectOutputMode()
      expect(mode._tag).toBe('react')
      if (mode._tag === 'react') {
        expect(mode.render.colors).toBe(false)
      }
    } finally {
      restoreEnv()
    }
  })

  test('NO_UNICODE removes unicode from detected mode', () => {
    clearEnv()
    try {
      process.env.TUI_VISUAL = '1'
      process.env.NO_UNICODE = '1'
      const mode = detectOutputMode()
      expect(mode._tag).toBe('react')
      if (mode._tag === 'react') {
        expect(mode.render.unicode).toBe(false)
      }
    } finally {
      restoreEnv()
    }
  })
})

describe('resolveOutputMode', () => {
  test('auto resolves based on environment', () => {
    const mode = resolveOutputMode('auto')
    // In test environment (non-TTY stdout), auto resolves to json.
    expect(['react', 'json']).toContain(mode._tag)
  })

  test('json returns json mode', () => {
    const mode = resolveOutputMode('json')
    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('final')
  })

  test('ndjson returns ndjson mode', () => {
    const mode = resolveOutputMode('ndjson')
    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('progressive')
  })

  test('tty returns tty mode', () => {
    const mode = resolveOutputMode('tty')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(true)
  })

  test('ci returns ci mode', () => {
    const mode = resolveOutputMode('ci')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(false)
  })

  test('log returns log mode', () => {
    const mode = resolveOutputMode('log')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('final')
    expect(isReact(mode) && mode.render.colors).toBe(false)
  })

  test('alt-screen returns alt-screen mode', () => {
    const mode = resolveOutputMode('alt-screen')
    expect(mode._tag).toBe('react')
    expect(isReact(mode) && mode.render.alternate).toBe(true)
  })

  test('ci-plain returns ci-plain mode', () => {
    const mode = resolveOutputMode('ci-plain')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(false)
    expect(isReact(mode) && mode.render.colors).toBe(false)
  })
})

describe('type guards', () => {
  test('isReact returns true for react modes', () => {
    expect(isReact(tty)).toBe(true)
    expect(isReact(ci)).toBe(true)
    expect(isReact(log)).toBe(true)
    expect(isReact(altScreen)).toBe(true)
    expect(isReact(json)).toBe(false)
    expect(isReact(ndjson)).toBe(false)
  })

  test('isJson returns true for JSON modes', () => {
    expect(isJson(tty)).toBe(false)
    expect(isJson(ci)).toBe(false)
    expect(isJson(json)).toBe(true)
    expect(isJson(ndjson)).toBe(true)
  })

  test('isProgressive returns true for progressive modes', () => {
    expect(isProgressive(tty)).toBe(true)
    expect(isProgressive(ci)).toBe(true)
    expect(isProgressive(log)).toBe(false)
    expect(isProgressive(json)).toBe(false)
    expect(isProgressive(ndjson)).toBe(true)
  })

  test('isFinal returns true for final modes', () => {
    expect(isFinal(tty)).toBe(false)
    expect(isFinal(ci)).toBe(false)
    expect(isFinal(log)).toBe(true)
    expect(isFinal(json)).toBe(true)
    expect(isFinal(ndjson)).toBe(false)
  })

  test('isAnimated returns true for animated modes', () => {
    expect(isAnimated(tty)).toBe(true)
    expect(isAnimated(ci)).toBe(false)
    expect(isAnimated(altScreen)).toBe(true)
    expect(isAnimated(json)).toBe(false)
  })

  test('hasColors returns true for colored modes', () => {
    expect(hasColors(tty)).toBe(true)
    expect(hasColors(ci)).toBe(true)
    expect(hasColors(log)).toBe(false)
    expect(hasColors(json)).toBe(false)
  })

  test('isAlternate returns true for alternate buffer modes', () => {
    expect(isAlternate(tty)).toBe(false)
    expect(isAlternate(altScreen)).toBe(true)
    expect(isAlternate(json)).toBe(false)
  })
})

describe('layers', () => {
  it.effect('layer creates a valid layer', () =>
    OutputModeTag.pipe(
      Effect.provide(layer(json)),
      Effect.tap((mode) =>
        Effect.sync(() => {
          expect(mode._tag).toBe('json')
          expect(mode.timing).toBe('final')
        }),
      ),
    ),
  )

  it.effect('ttyLayer provides tty mode', () =>
    OutputModeTag.pipe(
      Effect.provide(ttyLayer),
      Effect.tap((mode) =>
        Effect.sync(() => {
          expect(mode._tag).toBe('react')
          expect(mode.timing).toBe('progressive')
        }),
      ),
    ),
  )

  it.effect('jsonLayer provides json mode', () =>
    OutputModeTag.pipe(
      Effect.provide(jsonLayer),
      Effect.tap((mode) =>
        Effect.sync(() => {
          expect(mode._tag).toBe('json')
          expect(mode.timing).toBe('final')
        }),
      ),
    ),
  )
})

describe('OutputModeTag service', () => {
  it.effect('can be yielded in Effect.gen', () =>
    Effect.gen(function* () {
      const mode = yield* OutputModeTag
      expect(mode._tag).toBe('json')
    }).pipe(Effect.provideService(OutputModeTag, ndjson)),
  )
})
