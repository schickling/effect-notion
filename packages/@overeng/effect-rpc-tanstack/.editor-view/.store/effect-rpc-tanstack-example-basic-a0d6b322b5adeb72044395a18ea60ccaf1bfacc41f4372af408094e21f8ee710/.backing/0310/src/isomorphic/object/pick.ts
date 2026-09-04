type ConvertUndefined<T> = OrUndefined<{
  [K in keyof T as undefined extends T[K] ? K : never]-?: T[K]
}>
type OrUndefined<T> = { [K in keyof T]: T[K] | undefined }
type PickRequired<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
}
type ConvertPick<T> = ConvertUndefined<T> & PickRequired<T>

/** Picks specified keys from an object */
export const pick = <Obj, Keys extends keyof Obj>({
  from,
  keys,
}: {
  from: Obj
  keys: Keys[]
}): ConvertPick<{ [K in Keys]: Obj[K] }> => {
  return keys.reduce((acc, key) => {
    acc[key] = from[key]
    return acc
  }, {} as any)
}

/** Picks keys from object, returning fallback if any key is undefined */
export const pickAllOrElse = <Obj, Keys extends keyof Obj, TElse>({
  from,
  keys,
  fallback,
}: {
  from: Obj
  keys: Keys[]
  fallback: TElse
}): ConvertPick<{ [K in Keys]: NonNullable<Obj[K]> }> | TElse => {
  const ret = {} as any
  for (const key of keys) {
    if ((from as any)[key] === undefined) {
      return fallback
    }
    ret[key] = from[key]
  }

  return ret
}
