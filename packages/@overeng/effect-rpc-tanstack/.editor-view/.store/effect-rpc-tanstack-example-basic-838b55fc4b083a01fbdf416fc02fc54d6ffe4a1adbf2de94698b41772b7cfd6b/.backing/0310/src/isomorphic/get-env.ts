import { shouldNeverHappen } from './core.ts'

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>

const getImportMetaEnv = (): ImportMetaEnvRecord | undefined => {
  const env = (import.meta as ImportMeta & { readonly env?: unknown }).env
  if (typeof env === 'object' && env !== null) {
    return env as ImportMetaEnvRecord
  }

  return undefined
}

/** Retrieves an environment variable from import.meta.env or process.env */
export const getEnv = (varName: string): string | undefined => {
  const importMetaEnv = getImportMetaEnv()
  const fromImportMeta = importMetaEnv?.[varName]
  if (typeof fromImportMeta === 'string') {
    return fromImportMeta
  }

  const fromProcess = globalThis.process?.env?.[varName]
  if (fromProcess !== undefined) {
    return fromProcess
  }

  if (importMetaEnv !== undefined || globalThis.process?.env !== undefined) {
    return undefined
  }

  return shouldNeverHappen(
    'No environment variables found (neither import.meta.env nor process.env)',
  )
}
