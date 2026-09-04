import type * as otel from '@opentelemetry/api'

import { shouldNeverHappen } from './core.ts'

/** Waits for the specified number of milliseconds before resolving */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Executes a function n times, passing the current index */
export const times = ({ n, fn }: { n: number; fn: (index: number) => {} }): void => {
  for (let i = 0; i < n; i++) {
    fn(i)
  }
}

/** Wraps a function to trigger debugger on error before rethrowing */
export const debugCatch = <T>(try_: () => T): T => {
  try {
    return try_()
  } catch (e: any) {
    // oxlint-disable-next-line no-debugger -- intentional for dev debugging
    debugger
    throw e
  }
}

/** Recursively removes undefined values from objects and arrays (mutates input) */
export const recRemoveUndefinedValues = (val: any): void => {
  if (Array.isArray(val) === true) {
    val.forEach(recRemoveUndefinedValues)
  } else if (typeof val === 'object') {
    Object.keys(val).forEach((key) => {
      if (val[key] === undefined) {
        delete val[key]
      } else {
        recRemoveUndefinedValues(val[key])
      }
    })
  }
}

/** Returns a function that extracts a property from an object */
export const prop =
  <T extends {}, K extends keyof T>(key: K) =>
  (obj: T): T[K] =>
    obj[key]

/** Converts an object to string, using JSON.stringify for plain objects */
export const objectToString = (error: any): string => {
  const str = error?.toString()
  if (str !== '[object Object]') return str

  try {
    return JSON.stringify(error, null, 2)
  } catch (e: any) {
    console.log(error)

    return `Error while printing error: ${e}`
  }
}

/** Converts an error to string including stack trace if available */
export const errorToString = (error: any): string => {
  const stack = error.stack
  const str = error.toString()
  const stackStr = stack !== undefined ? `\n${stack}` : ''
  if (str !== '[object Object]') return str + stackStr

  try {
    return JSON.stringify({ ...error, stack }, null, 2)
  } catch (e: any) {
    console.log(error)

    return `Error while printing error: ${e}`
  }
}

/** Capitalizes the first letter of a string */
export const capitalizeFirstLetter = (str: string): string =>
  str.charAt(0).toUpperCase() + str.slice(1)

/** Asserts exhaustive handling of union members at end of if-else chains */
// oxlint-disable-next-line func-style
export function casesHandled(unexpectedCase: never): never {
  // oxlint-disable-next-line no-debugger -- intentional for dev debugging
  debugger
  throw new Error(
    `A case was not handled for value: ${truncate({ str: objectToString(unexpectedCase), length: 1000 })}`,
  )
}

/** Throws an error with debugger breakpoint if condition is false */
export const assertNever = ({
  condition,
  msg,
}: {
  condition: boolean
  msg?: string | (() => string)
}): void => {
  if (condition === false) {
    const msg_ = typeof msg === 'function' ? msg() : msg
    // oxlint-disable-next-line no-debugger -- intentional for dev debugging
    debugger
    throw new Error(`This should never happen ${msg_}`)
  }
}

/** Identity function that triggers debugger breakpoint for pipeline debugging */
export const debuggerPipe = <T>(val: T): T => {
  // oxlint-disable-next-line no-debugger -- intentional for dev debugging
  debugger
  return val
}

/** Sometimes useful when type definitions say a type is non-null/non-undefined but in during runtime it might be null/undefined */
export const asNilish = <T>(val: T): T | null | undefined => val

/** Truncates a string to the specified length, adding ellipsis if truncated */
export const truncate = ({ str, length }: { str: string; length: number }): string => {
  if (str.length > length) {
    return `${str.slice(0, length)}...`
  } else {
    return str
  }
}

/** Throws a "not yet implemented" error with optional message and debugger breakpoint */
export const notYetImplemented = (msg?: string): never => {
  // oxlint-disable-next-line no-debugger -- intentional for dev debugging
  debugger
  throw new Error(`Not yet implemented ${msg}`)
}

/** Empty function that does nothing */
export const noop = () => {}

/** A lazy value - a function that returns T when called */
export type Thunk<T> = () => T

/** Unwraps a thunk by calling it if it's a function, otherwise returns the value */
export const unwrapThunk = <T>(_: T | (() => T)): T => {
  if (typeof _ === 'function') {
    return (_ as any)()
  } else {
    return _
  }
}

/** `end` is not included */
export const range = ({ start, end }: { start: number; end: number }): number[] => {
  const length = end - start
  return Array.from({ length }, (_, i) => start + i)
}

/** Creates a throttled function that only calls fn at most once per ms interval */
export const throttle = ({ fn, ms }: { fn: () => void; ms: number }) => {
  let shouldWait = false
  let shouldCallAgain = false

  const timeoutFunc = () => {
    if (shouldCallAgain === true) {
      fn()
      shouldCallAgain = false
      setTimeout(timeoutFunc, ms)
    } else {
      shouldWait = false
    }
  }

  return () => {
    if (shouldWait === true) {
      shouldCallAgain = true
      return
    }

    fn()
    shouldWait = true
    setTimeout(timeoutFunc, ms)
  }
}

/** Generates a W3C Trace Context traceparent header from an OpenTelemetry span */
export const getTraceParentHeader = (parentSpan: otel.Span) => {
  const spanContext = parentSpan.spanContext()
  // Format: {version}-{trace_id}-{span_id}-{trace_flags}
  // https://www.w3.org/TR/trace-context/#examples-of-http-traceparent-headers
  return `00-${spanContext.traceId}-${spanContext.spanId}-01`
}

/** Asserts that a tagged union value has the expected tag, returning the narrowed type */
export const assertTag = <TObj extends { _tag: string }, TTag extends TObj['_tag']>({
  obj,
  tag,
}: {
  obj: TObj
  tag: TTag
}): Extract<TObj, { _tag: TTag }> => {
  if (obj._tag !== tag) {
    return shouldNeverHappen(`Expected tag ${tag} but got ${obj._tag}`)
  }

  return obj as any
}

/** Caches function results by JSON-stringified arguments */
export const memoize = <T extends (...args: any[]) => any>(fn: T): T => {
  const cache = new Map<string, ReturnType<T>>()

  return ((...args: any[]) => {
    const key = JSON.stringify(args)
    if (cache.has(key) === true) {
      return cache.get(key)
    }

    const result = fn(...args)
    cache.set(key, result)
    return result
  }) as any
}

/** Type guard that checks if a value is a non-empty string */
export const isNonEmptyString = (str: string | undefined | null): str is string => {
  return typeof str === 'string' && str.length > 0
}

/** Debug utility that logs a value and returns it unchanged */
export const __debugPassthroughLog = <T>({ val, key = '' }: { val: T; key?: string }): T => {
  console.log(key, val)
  return val
}
