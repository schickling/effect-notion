import * as FastCheck from 'effect/testing/FastCheck'

type FastCheckGlobalParameters = Parameters<typeof FastCheck.configureGlobal>[0]

const parseSeed = (raw: string): number => {
  if (/^-?\d+$/u.test(raw) === false) {
    throw new Error(`FAST_CHECK_SEED must be an integer, got ${JSON.stringify(raw)}`)
  }

  const seed = Number(raw)
  if (Number.isSafeInteger(seed) === false) {
    throw new Error(`FAST_CHECK_SEED must be a safe integer, got ${JSON.stringify(raw)}`)
  }

  return seed
}

const fromEnvironment = (): FastCheckGlobalParameters | undefined => {
  const seed = process.env.FAST_CHECK_SEED
  const path = process.env.FAST_CHECK_PATH

  if (seed === undefined && path === undefined) {
    return undefined
  }

  return {
    ...FastCheck.readConfigureGlobal(),
    ...(seed === undefined ? {} : { seed: parseSeed(seed) }),
    ...(path === undefined ? {} : { path }),
  }
}

const parameters = fromEnvironment()

if (parameters !== undefined) {
  FastCheck.configureGlobal(parameters)
}
