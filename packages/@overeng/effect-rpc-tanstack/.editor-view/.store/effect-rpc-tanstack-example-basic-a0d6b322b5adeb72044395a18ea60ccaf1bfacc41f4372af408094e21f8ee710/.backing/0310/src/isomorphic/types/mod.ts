export * from './json.ts'

/** Recursively expand all properties of a type for better IDE display */
export type Prettify<T> = T extends infer U ? { [K in keyof U]: Prettify<U[K]> } : never

/** Expand properties one level deep for better IDE display */
export type PrettifyFlat<T> = T extends infer U ? { [K in keyof U]: U[K] } : never

/** Check if two types are exactly equal */
export type TypeEq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** `A` is subtype of `B` */
export type IsSubtype<A, B> = A extends B ? true : false

/** Utility type that constrains T to true - useful for type-level assertions */
export type AssertTrue<T extends true> = T

/** Remove readonly modifier from all properties */
export type Writeable<T> = { -readonly [P in keyof T]: T[P] }

/** Recursively remove readonly modifier from all properties */
export type DeepWriteable<T> = {
  -readonly [P in keyof T]: DeepWriteable<T[P]>
}

/** JavaScript primitive types */
export type Primitive = null | undefined | string | number | boolean | symbol | bigint

/** Allow both literal types and their base type for autocomplete while accepting any value */
export type LiteralUnion<LiteralType, BaseType extends Primitive> =
  | LiteralType
  | (BaseType & Record<never, never>)

/** NOTE This type might alter the order of fields */
export type NullableFieldsToOptional<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>
  } & {
    [K in keyof T as null extends T[K] ? never : K]: T[K]
  }
>

/** Same as NullableFieldsToOptional but keeps `| null` in addition to making fields optional */
export type NullableFieldsToOptional_<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as null extends T[K] ? K : never]?: T[K]
  } & {
    [K in keyof T as null extends T[K] ? never : K]: T[K]
  }
>

/** NOTE This type might alter the order of fields */
export type UndefinedFieldsToOptional<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
  } & {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K]
  }
>

/** Make only specific keys K optional while keeping other keys required */
export type PartialPick<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
