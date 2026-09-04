import { pipe } from 'effect'

import type { PrettifyFlat } from '../types/mod.ts'

export * from './omit.ts'
export * from './pick.ts'

type ValueOfRecord<R extends Record<any, any>> = R extends Record<any, infer V> ? V : never

/** Maps over object values while preserving keys */
export const mapObjectValues = <O_In extends Record<string, any>, V_Out>({
  obj,
  mapValue,
}: {
  obj: O_In
  mapValue: (key: keyof O_In, val: ValueOfRecord<O_In>) => V_Out
}): { [K in keyof O_In]: V_Out } => {
  const mappedEntries = Object.entries(obj).map(
    ([key, val]) => [key, mapValue(key as keyof O_In, val)] as const,
  )
  return Object.fromEntries(mappedEntries) as any
}

/** Type-safe Object.entries return type */
export type Entries<T> = { [K in keyof T]: [K, T[K]] }[keyof T][]

/** Type-safe wrapper around Object.entries */
export const objectEntries = <T extends Record<string, any>>(obj: T): Entries<T> =>
  Object.entries(obj) as Entries<T>

/** Creates an object where each key maps to itself */
export const keyObjectFromObject = <TObj extends Record<string, any>>(
  obj: TObj,
): { [K in keyof TObj]: K } =>
  pipe(
    objectEntries(obj).map(([k]) => [k, k]),
    Object.fromEntries,
  ) as any

/** Convert undefined-able fields to nullable (undefined -> null) */
export type UndefinedFieldsToNull<T> = PrettifyFlat<{
  [K in keyof T]-?: undefined extends T[K] ? (T[K] & {}) | null : T[K]
}>

/** Converts undefined values in an object to null */
export const undefinedFieldsToNull = <T extends {}>(obj: T): UndefinedFieldsToNull<T> =>
  Object.fromEntries(Object.entries(obj).map(([key, val]) => [key, val ?? null])) as any

/** Creates a new object with all keys prefixed by the given string */
export const objectWithKeyPrefix = <TObj extends Record<string, any>, TPrefix extends string>({
  obj,
  prefix,
}: {
  obj: TObj
  prefix: TPrefix
}): {
  [K in keyof TObj as K extends string ? `${TPrefix}${K}` : never]: TObj[K]
} => {
  const newObj: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    newObj[`${prefix}${k}` as any] = v
  }
  return newObj as any
}

/**
 * Helper for `exactOptionalPropertyTypes` compatibility.
 *
 * When a type has `prop?: T` (optional), you cannot pass `{ prop: undefined }`.
 * This helper creates a spreadable object that only includes the key if the value is defined.
 *
 * @example
 * ```ts
 * interface Props { name: string; age?: number }
 *
 * // Without helper (TS error with exactOptionalPropertyTypes):
 * const props: Props = { name: 'John', age: undefined } // Error!
 *
 * // With helper:
 * const props: Props = { name: 'John', ...optionalProp({ key: 'age', value: maybeAge }) } // OK
 * ```
 */
export const optionalProp = <K extends string, V>({
  key,
  value,
}: {
  key: K
  value: V | undefined
}): V extends undefined ? {} : { [P in K]: V } =>
  (value !== undefined ? { [key]: value } : {}) as V extends undefined ? {} : { [P in K]: V }

/** Type that removes keys with undefined values from an object type */
type DefinedProps<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends undefined ? never : K]: Exclude<T[K], undefined>
}

/**
 * Helper for `exactOptionalPropertyTypes` compatibility with multiple props.
 *
 * Filters out undefined values from an object, returning only defined properties.
 * Useful when spreading multiple optional properties at once.
 *
 * @example
 * ```ts
 * interface Props { name: string; age?: number; email?: string }
 *
 * const props: Props = {
 *   name: 'John',
 *   ...optionalProps({ age: maybeAge, email: maybeEmail })
 * }
 * ```
 */
export const optionalProps = <T extends Record<string, unknown>>(obj: T): DefinedProps<T> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result as DefinedProps<T>
}
