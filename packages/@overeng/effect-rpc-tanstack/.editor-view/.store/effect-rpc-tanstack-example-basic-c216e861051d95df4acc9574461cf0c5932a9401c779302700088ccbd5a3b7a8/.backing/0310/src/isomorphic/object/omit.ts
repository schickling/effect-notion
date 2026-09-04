/** Returns a shallowly cloned object with the provided keys omitted */
export const omit = <Obj extends Record<string, any>, Keys extends keyof Obj>({
  from,
  keys,
}: {
  from: Obj
  keys: Keys[]
}): Omit<Obj, Keys> => {
  return Object.keys(from).reduce((acc, key: any) => {
    if (keys.includes(key) === false) {
      acc[key] = (from as any)[key]
    }
    return acc
  }, {} as any)
}
