import { Schema } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { ClaudeSessionRecord } from './adapters/claude.ts'
import { CodexSessionRecord } from './adapters/codex.ts'
import type { OpenCodeRecord } from './adapters/opencode.ts'
import { collapseStreamingOpenCodeRecords } from './adapters/opencode.ts'
import { parseMcpToolName } from './normalized/mcp-tool-name.ts'
import { translateClaudeRecord } from './normalized/translate-claude.ts'
import { translateCodexRecord } from './normalized/translate-codex.ts'
import { translateOpenCodeRecord } from './normalized/translate-opencode.ts'

const ts = '2026-03-16T12:00:00Z'

Vitest.describe('parseMcpToolName', () => {
  Vitest.it('extracts server and tool from mcp__ format', () => {
    const result = parseMcpToolName('mcp__my-server__do_thing')
    expect(result).toEqual({ serverName: 'my-server', toolName: 'do_thing' })
  })

  Vitest.it('returns original name for non-MCP tools', () => {
    const result = parseMcpToolName('Bash')
    expect(result).toEqual({ serverName: '', toolName: 'Bash' })
  })

  Vitest.it('handles malformed mcp__ prefix without separator', () => {
    const result = parseMcpToolName('mcp__noseparator')
    expect(result).toEqual({ serverName: '', toolName: 'mcp__noseparator' })
  })

  Vitest.it('handles tool names with underscores after server', () => {
    const result = parseMcpToolName('mcp__srv__get__nested__tool')
    expect(result).toEqual({ serverName: 'srv', toolName: 'get__nested__tool' })
  })
})

Vitest.describe('translateClaudeRecord', () => {
  Vitest.it('translates assistant record with text, thinking, and tool_use blocks', () => {
    const record = Schema.decodeSync(ClaudeSessionRecord)({
      type: 'assistant',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/user',
      sessionId: 'ses-1',
      version: '1.0',
      uuid: 'msg-1',
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is the answer.' },
          { type: 'tool_use', id: 'tu-1', name: 'mcp__devtools__Bash', input: { command: 'ls' } },
        ],
      },
    })

    const normalized = translateClaudeRecord(record)
    expect(normalized).toHaveLength(3)

    expect(normalized[0]).toMatchObject({
      _tag: 'Thinking',
      content: 'Let me think...',
      sessionId: 'ses-1',
    })

    expect(normalized[1]).toMatchObject({
      _tag: 'AssistantText',
      content: 'Here is the answer.',
      model: 'claude-opus-4-6',
    })

    expect(normalized[2]).toMatchObject({
      _tag: 'ToolCallStart',
      toolCallId: 'tu-1',
      toolName: 'Bash',
      serverName: 'devtools',
      input: { command: 'ls' },
    })
  })

  Vitest.it('translates user record with string content', () => {
    const record = Schema.decodeSync(ClaudeSessionRecord)({
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/user',
      sessionId: 'ses-1',
      version: '1.0',
      uuid: 'msg-2',
      timestamp: ts,
      message: { role: 'user', content: 'Hello world' },
    })

    const normalized = translateClaudeRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'UserMessage',
      content: 'Hello world',
      messageId: 'msg-2',
    })
  })

  Vitest.it('translates user record with tool_result blocks', () => {
    const record = Schema.decodeSync(ClaudeSessionRecord)({
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/user',
      sessionId: 'ses-1',
      version: '1.0',
      uuid: 'msg-3',
      timestamp: ts,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents', is_error: false },
        ],
      },
    })

    const normalized = translateClaudeRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallEnd',
      toolCallId: 'tu-1',
      output: 'file contents',
      isError: false,
    })
  })

  Vitest.it('translates system record', () => {
    const record = Schema.decodeSync(ClaudeSessionRecord)({
      type: 'system',
      parentUuid: null,
      isSidechain: false,
      cwd: '/home/user',
      sessionId: 'ses-1',
      version: '1.0',
      uuid: 'msg-4',
      timestamp: ts,
      content: 'System prompt text',
    })

    const normalized = translateClaudeRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'SystemMessage',
      content: 'System prompt text',
    })
  })

  Vitest.it('translates progress record as GenericEvent', () => {
    const record = Schema.decodeSync(ClaudeSessionRecord)({
      type: 'progress',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/user',
      sessionId: 'ses-1',
      version: '1.0',
      uuid: 'msg-5',
      timestamp: ts,
      data: { type: 'hook', hookEvent: 'PostToolUse' },
    })

    const normalized = translateClaudeRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'GenericEvent',
      eventType: 'progress',
    })
  })
})

Vitest.describe('translateCodexRecord', () => {
  Vitest.it('translates session_meta to SessionMeta', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'session_meta',
      timestamp: ts,
      payload: { id: 'thread-1', timestamp: ts, cwd: '/project', cli_version: '0.25.0' },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'SessionMeta',
      sessionId: 'thread-1',
      cwd: '/project',
      version: '0.25.0',
      tool: 'codex',
    })
  })

  Vitest.it('translates response_item message to UserMessage/AssistantText', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Here is the result.' }],
      },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'AssistantText',
      content: 'Here is the result.',
    })
  })

  Vitest.it('translates function_call to ToolCallStart', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: '{"command":"ls"}',
        call_id: 'call-1',
      },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallStart',
      toolCallId: 'call-1',
      toolName: 'shell',
      input: { command: 'ls' },
    })
  })

  Vitest.it('translates function_call_output to ToolCallEnd', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'file1.ts\nfile2.ts',
      },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallEnd',
      toolCallId: 'call-1',
      output: 'file1.ts\nfile2.ts',
    })
  })

  Vitest.it('translates turn_context to SessionMeta with model', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'turn_context',
      timestamp: ts,
      payload: { cwd: '/project', model: 'o3', effort: 'high' },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'SessionMeta',
      cwd: '/project',
      model: 'o3',
    })
  })

  Vitest.it('translates reasoning to Thinking', () => {
    const record = Schema.decodeSync(CodexSessionRecord)({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Deep thought here.' }],
        content: null,
      },
    })

    const normalized = translateCodexRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'Thinking',
      content: 'Deep thought here.',
    })
  })
})

Vitest.describe('translateOpenCodeRecord', () => {
  const makeSession = (): OpenCodeRecord => ({
    _tag: 'OpenCodeSession',
    session: {
      id: 'ses-oc-1',
      slug: 'my-session',
      directory: '/project',
      title: 'Test Session',
      version: '1.2.0',
      time_created: 1710590400000 as any,
      time_updated: 1710590500000 as any,
    },
  })

  const makePart = (type: string, extra: Record<string, unknown> = {}): OpenCodeRecord => ({
    _tag: 'OpenCodePart',
    id: `part-${type}`,
    sessionId: 'ses-oc-1',
    timeCreated: 1710590400000 as any,
    timeUpdated: 1710590500000 as any,
    data: { type, ...extra } as any,
  })

  Vitest.it('translates OpenCodeSession to SessionMeta', () => {
    const normalized = translateOpenCodeRecord(makeSession())
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'SessionMeta',
      sessionId: 'ses-oc-1',
      cwd: '/project',
      version: '1.2.0',
      tool: 'opencode',
    })
  })

  Vitest.it('translates text part to AssistantText', () => {
    const normalized = translateOpenCodeRecord(makePart('text', { text: 'Hello from assistant' }))
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'AssistantText',
      content: 'Hello from assistant',
      sessionId: 'ses-oc-1',
    })
  })

  Vitest.it('translates reasoning part to Thinking', () => {
    const normalized = translateOpenCodeRecord(makePart('reasoning', { text: 'Hmm let me think' }))
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'Thinking',
      content: 'Hmm let me think',
    })
  })

  Vitest.it('translates pending tool part to ToolCallStart', () => {
    const normalized = translateOpenCodeRecord(
      makePart('tool', {
        tool: 'mcp__devtools__Bash',
        callID: 'call-oc-1',
        state: { status: 'running', input: { command: 'ls' } },
      }),
    )
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallStart',
      toolCallId: 'call-oc-1',
      toolName: 'Bash',
      serverName: 'devtools',
      input: { command: 'ls' },
    })
  })

  Vitest.it('translates completed tool part to ToolCallEnd', () => {
    const normalized = translateOpenCodeRecord(
      makePart('tool', {
        tool: 'Read',
        callID: 'call-oc-2',
        state: { status: 'completed', input: {}, output: 'file contents' },
      }),
    )
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallEnd',
      toolCallId: 'call-oc-2',
      toolName: 'Read',
      output: 'file contents',
    })
  })

  Vitest.it('translates error tool part with isError flag', () => {
    const normalized = translateOpenCodeRecord(
      makePart('tool', {
        tool: 'Write',
        callID: 'call-oc-3',
        state: { status: 'error', input: {}, output: 'Permission denied' },
      }),
    )
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'ToolCallEnd',
      toolCallId: 'call-oc-3',
      isError: true,
      output: 'Permission denied',
    })
  })

  Vitest.it('translates step-start/step-finish to StepBoundary', () => {
    const start = translateOpenCodeRecord(makePart('step-start', { text: 'Starting' }))
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ _tag: 'StepBoundary', kind: 'start' })

    const finish = translateOpenCodeRecord(
      makePart('step-finish', {
        cost: 0.05,
        tokens: { input: 100, output: 50 },
        reason: 'end_turn',
      }),
    )
    expect(finish).toHaveLength(1)
    expect(finish[0]).toMatchObject({
      _tag: 'StepBoundary',
      kind: 'finish',
      cost: 0.05,
      reason: 'end_turn',
    })
  })

  Vitest.it('translates OpenCodeMessage with user role to UserMessage', () => {
    const record: OpenCodeRecord = {
      _tag: 'OpenCodeMessage',
      id: 'msg-oc-1',
      sessionId: 'ses-oc-1',
      timeCreated: 1710590400000 as any,
      timeUpdated: 1710590500000 as any,
      data: { role: 'user' } as any,
    }
    const normalized = translateOpenCodeRecord(record)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      _tag: 'UserMessage',
      messageId: 'msg-oc-1',
    })
  })
})

Vitest.describe('collapseStreamingOpenCodeRecords', () => {
  const makePart = (id: string, text: string): OpenCodeRecord => ({
    _tag: 'OpenCodePart',
    id,
    sessionId: 'ses-1',
    timeCreated: 1710590400000 as any,
    timeUpdated: 1710590500000 as any,
    data: { type: 'text', text } as any,
  })

  const makeMessage = (id: string): OpenCodeRecord => ({
    _tag: 'OpenCodeMessage',
    id,
    sessionId: 'ses-1',
    timeCreated: 1710590400000 as any,
    timeUpdated: 1710590500000 as any,
    data: { role: 'assistant' } as any,
  })

  Vitest.it('keeps only the last occurrence of each part ID', () => {
    const records: ReadonlyArray<OpenCodeRecord> = [
      makePart('p1', 'H'),
      makePart('p1', 'He'),
      makePart('p1', 'Hel'),
      makePart('p1', 'Hello'),
      makePart('p2', 'W'),
      makePart('p2', 'World'),
    ]

    const collapsed = collapseStreamingOpenCodeRecords(records)
    expect(collapsed).toHaveLength(2)
    expect((collapsed[0] as any).data.text).toBe('Hello')
    expect((collapsed[1] as any).data.text).toBe('World')
  })

  Vitest.it('preserves non-part records unchanged', () => {
    const records: ReadonlyArray<OpenCodeRecord> = [
      makeMessage('m1'),
      makePart('p1', 'H'),
      makePart('p1', 'Hello'),
      makeMessage('m2'),
    ]

    const collapsed = collapseStreamingOpenCodeRecords(records)
    expect(collapsed).toHaveLength(3)
    expect(collapsed[0]!._tag).toBe('OpenCodeMessage')
    expect(collapsed[1]!._tag).toBe('OpenCodePart')
    expect(collapsed[2]!._tag).toBe('OpenCodeMessage')
  })

  Vitest.it('returns empty array for empty input', () => {
    expect(collapseStreamingOpenCodeRecords([])).toHaveLength(0)
  })
})
