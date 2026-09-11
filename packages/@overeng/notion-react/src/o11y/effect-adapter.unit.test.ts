import { Context, Effect, Exit, Fiber, Option, type Tracer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { SyncEventHandler } from '../renderer/sync-events.ts'
import { SyncEvent } from '../renderer/sync-events.ts'
import { emitSyncEndOnInterrupt, makeEffectSpanHandler } from './effect-adapter.ts'

interface RecordedSpan {
  readonly name: string
  readonly startTimeNs: bigint
  readonly kind: Tracer.SpanKind
  readonly parent: Option.Option<Tracer.AnySpan>
  attributes: Record<string, unknown>
  events: { name: string; time: bigint; attrs: Record<string, unknown> | undefined }[]
  endTimeNs: bigint | undefined
  endExitTag: string | undefined
  ended: boolean
}

const makeFakeTracer = (): { tracer: Tracer.Tracer; spans: RecordedSpan[] } => {
  const spans: RecordedSpan[] = []
  const tracer: Tracer.Tracer = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ['~effect/Tracer' as never]: undefined as never,
    span: (options: {
      readonly name: string
      readonly parent: Option.Option<Tracer.AnySpan>
      readonly startTime: bigint
      readonly kind: Tracer.SpanKind
    }): Tracer.Span => {
      const { name, parent, startTime, kind } = options
      const rec: RecordedSpan = {
        name,
        startTimeNs: startTime,
        kind,
        parent,
        attributes: {},
        events: [],
        endTimeNs: undefined,
        endExitTag: undefined,
        ended: false,
      }
      spans.push(rec)
      const span: Tracer.Span = {
        _tag: 'Span',
        name,
        spanId: String(spans.length),
        traceId: 'trace-1',
        parent,
        annotations: Context.empty(),
        status: { _tag: 'Started', startTime },
        attributes: new Map() as ReadonlyMap<string, unknown>,
        links: [],
        sampled: true,
        kind,
        end(endTime, exit) {
          rec.endTimeNs = endTime
          rec.endExitTag = exit._tag
          rec.ended = true
        },
        attribute(key, value) {
          rec.attributes[key] = value
        },
        event(eventName, time, attrs) {
          rec.events.push({ name: eventName, time, attrs })
        },
        addLinks() {},
      }
      return span
    },
  } as unknown as Tracer.Tracer
  return { tracer, spans }
}

const ROOT = '11111111-2222-4333-8444-555555555555'
const MS = 1_000_000n

describe('makeEffectSpanHandler', () => {
  it('opens a notion-react.sync root span and a child op span', () => {
    const { tracer, spans } = makeFakeTracer()
    const handler = makeEffectSpanHandler({ tracer, serviceName: 'pixeltrail-sync' })

    handler(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 2, at: 1_000 }))
    handler(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1_005 }))
    handler(
      SyncEvent.OpSucceeded({ id: 1, kind: 'append', durationMs: 3, resultCount: 2, at: 1_010 }),
    )
    handler(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 20, ok: true, opCount: 1, at: 1_020 }))

    expect(spans).toHaveLength(2)
    const [root, op] = spans
    expect(root!.name).toBe('notion-react.sync')
    expect(root!.attributes['service.name']).toBe('pixeltrail-sync')
    expect(root!.attributes['span.label']).toBe('11111111')
    expect(root!.attributes['notion-react.op_count']).toBe(1)
    expect(root!.endTimeNs).toBe(1_020n * MS)
    expect(root!.endExitTag).toBe('Success')

    expect(op!.name).toBe('notion-react.op.append')
    expect(Option.isSome(op!.parent)).toBe(true)
    expect(op!.attributes['notion-react.op.result_count']).toBe(2)
    expect(op!.endExitTag).toBe('Success')
  })

  it('op-failed marks Exit as Failure', () => {
    const { tracer, spans } = makeFakeTracer()
    const handler = makeEffectSpanHandler({ tracer })
    handler(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 0, at: 0 }))
    handler(SyncEvent.OpIssued({ id: 3, kind: 'delete', at: 1 }))
    handler(SyncEvent.OpFailed({ id: 3, kind: 'delete', durationMs: 1, error: 'bad', at: 2 }))
    handler(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 3, ok: false, opCount: 0, at: 3 }))

    const op = spans.find((s) => s.name === 'notion-react.op.delete')!
    expect(op.endExitTag).toBe('Failure')
    expect(op.attributes['notion-react.op.error']).toBe('bad')
    expect(spans.find((s) => s.name === 'notion-react.sync')!.endExitTag).toBe('Failure')
  })

  it('CacheOutcome / BatchFlush / CheckpointWritten surface as span events on root', () => {
    const { tracer, spans } = makeFakeTracer()
    const handler = makeEffectSpanHandler({ tracer })
    handler(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 0, at: 0 }))
    handler(SyncEvent.CacheOutcome({ kind: 'hit', pageId: ROOT, at: 1 }))
    handler(SyncEvent.BatchFlush({ issued: 2, batched: 2, at: 2 }))
    handler(SyncEvent.CheckpointWritten({ pageId: ROOT, bytes: 123, at: 3 }))
    handler(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 4, ok: true, opCount: 0, at: 4 }))

    const root = spans[0]!
    expect(root.events.map((e) => e.name)).toEqual([
      'cache:hit',
      'batch-flush',
      'checkpoint-written',
    ])
    expect(root.events[1]!.attrs?.['notion-react.batch.batched']).toBe(2)
    expect(root.events[2]!.attrs?.['notion-react.checkpoint.bytes']).toBe(123)
  })

  it('is re-entrant safe across two independent handlers', () => {
    const a = makeFakeTracer()
    const b = makeFakeTracer()
    const handlerA = makeEffectSpanHandler({ tracer: a.tracer })
    const handlerB = makeEffectSpanHandler({ tracer: b.tracer })

    handlerA(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 1, at: 0 }))
    handlerB(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 1, at: 0 }))
    handlerA(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1 }))
    handlerB(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1 }))
    handlerA(SyncEvent.OpSucceeded({ id: 1, kind: 'append', durationMs: 1, resultCount: 1, at: 2 }))
    handlerB(SyncEvent.OpFailed({ id: 1, kind: 'append', durationMs: 1, error: 'x', at: 2 }))
    handlerA(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 3, ok: true, opCount: 1, at: 3 }))
    handlerB(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 3, ok: false, opCount: 0, at: 3 }))

    expect(a.spans.every((s) => s.ended)).toBe(true)
    expect(b.spans.every((s) => s.ended)).toBe(true)
    expect(a.spans.find((s) => s.name === 'notion-react.op.append')!.endExitTag).toBe('Success')
    expect(b.spans.find((s) => s.name === 'notion-react.op.append')!.endExitTag).toBe('Failure')
  })
})

describe('emitSyncEndOnInterrupt', () => {
  it('emits a synthetic SyncEnd when the inner Effect is interrupted', async () => {
    const events: SyncEvent[] = []
    const handler: SyncEventHandler = (e) => events.push(e)

    const program = Effect.never.pipe(emitSyncEndOnInterrupt({ pageId: ROOT, onEvent: handler }))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program)
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.join(fiber)
      }),
    )

    // v4 `Fiber.join` propagates the child's interruption to the parent.
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toHaveLength(1)
    const [ev] = events
    expect(ev!._tag).toBe('SyncEnd')
    if (ev!._tag === 'SyncEnd') {
      expect(ev.ok).toBe(false)
      expect(ev.pageId).toBe(ROOT)
    }
  })

  it('does not emit SyncEnd on successful completion', async () => {
    const events: SyncEvent[] = []
    const handler: SyncEventHandler = (e) => events.push(e)

    await Effect.runPromise(
      Effect.succeed(42).pipe(emitSyncEndOnInterrupt({ pageId: ROOT, onEvent: handler })),
    )

    expect(events).toEqual([])
  })

  it('does not emit SyncEnd on typed failure (sync() already handles that)', async () => {
    const events: SyncEvent[] = []
    const handler: SyncEventHandler = (e) => events.push(e)

    await Effect.runPromise(
      Effect.fail('boom').pipe(
        emitSyncEndOnInterrupt({ pageId: ROOT, onEvent: handler }),
        Effect.ignore,
      ),
    )

    expect(events).toEqual([])
  })
})
