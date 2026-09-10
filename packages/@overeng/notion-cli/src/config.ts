import { Effect, FileSystem, Schema } from 'effect'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'
import { CurrentWorkingDirectory } from '@overeng/utils/node'

import type {
  DatabaseConfig,
  DefaultsConfig,
  PropertyTransforms,
  SchemaGenConfig,
  Transform,
} from './config-def.ts'
import type { PropertyTransformConfig } from './introspect.ts'

// Re-export config definition types
export type { DatabaseConfig, DefaultsConfig, PropertyTransforms, SchemaGenConfig, Transform }

// Re-export path types used in resolved config
export type { AbsoluteFilePath }

// -----------------------------------------------------------------------------
// Internal Types (for backwards compat with codegen)
// -----------------------------------------------------------------------------

/** Resolved database config with all paths resolved and transforms normalized */
export interface ResolvedDatabaseConfig {
  /** Notion database ID */
  readonly id: string
  /** Resolved output file path (absolute) */
  readonly output: AbsoluteFilePath
  /** Custom schema name (defaults to database title) */
  readonly name?: string
  /** Include Write schemas */
  readonly includeWrite?: boolean
  /** Generate typed options for select/status/multi_select */
  readonly typedOptions?: boolean
  /** Include Notion property metadata annotations */
  readonly schemaMeta?: boolean
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean
  /** Property-specific transforms (normalized to string values) */
  readonly transforms?: PropertyTransformConfig
}

/** Resolved config with all paths resolved */
export interface ResolvedConfig {
  readonly databases: readonly ResolvedDatabaseConfig[]
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Error thrown when no config file is found in the search path */
export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
  'ConfigNotFoundError',
  {
    message: Schema.String,
    searchStartDir: Schema.String,
    fileNames: Schema.Array(Schema.String),
  },
) {}

/** Error thrown when specified config file path doesn't exist */
export class ConfigFileNotFoundError extends Schema.TaggedError<ConfigFileNotFoundError>()(
  'ConfigFileNotFoundError',
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

/** Error thrown when config file cannot be imported */
export class ConfigReadError extends Schema.TaggedError<ConfigReadError>()('ConfigReadError', {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Error thrown when config file has invalid structure */
export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()('ConfigParseError', {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Union of all configuration-related errors. */
export type ConfigError =
  | ConfigNotFoundError
  | ConfigFileNotFoundError
  | ConfigReadError
  | ConfigParseError

// -----------------------------------------------------------------------------
// Config Loading
// -----------------------------------------------------------------------------

/** Config file names to search for (TS config only) */
const CONFIG_FILE_NAMES = ['notion-schema-gen.config.ts', '.notion-schema-gen.config.ts']

const formatUnknownErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Check if a path string is absolute (Unix or Windows) */
const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)

/** Find config file in directory or parent directories */
const findConfigFile = Effect.fnUntraced(function* (startDir: AbsoluteDirPath) {
  const fs = yield* FileSystem.FileSystem

  let currentDir: AbsoluteDirPath | undefined = startDir

  while (currentDir !== undefined) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = EffectPath.ops.join(currentDir, EffectPath.unsafe.relativeFile(fileName))
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
      if (exists === true) {
        return filePath
      }
    }
    currentDir = EffectPath.ops.parent(currentDir)
  }

  return undefined as AbsoluteFilePath | undefined
})

/** Check if a value is a Transform object */
const isTransform = (value: unknown): value is Transform =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  (value as Transform)._tag === 'Transform'

/** Normalize transform value to string */
const normalizeTransform = (value: Transform | string): string =>
  isTransform(value) === true ? value.name : value

/** Normalize PropertyTransforms to PropertyTransformConfig (string values) */
const normalizeTransforms = (
  transforms: PropertyTransforms | undefined,
): PropertyTransformConfig | undefined => {
  if (transforms === undefined) return undefined

  const result: PropertyTransformConfig = {}
  for (const [key, value] of Object.entries(transforms)) {
    result[key] = normalizeTransform(value)
  }
  return result
}

/** Load TypeScript config file using dynamic import */
const loadTsConfig = Effect.fnUntraced(function* (configPath: string) {
  const module = yield* Effect.tryPromise({
    // oxlint-disable-next-line import/no-dynamic-require -- runtime config file loading requires dynamic import
    try: () => import(configPath),
    catch: (cause) =>
      new ConfigReadError({
        message: `Failed to import config: ${formatUnknownErrorMessage(cause)}`,
        path: configPath,
        cause,
      }),
  })

  const config = module.default as unknown
  if (config == null || typeof config !== 'object') {
    return yield* new ConfigParseError({
      message: 'Config file must export a default config object',
      path: configPath,
      cause: new Error('Invalid export'),
    })
  }

  // Validate required fields
  if (!('databases' in config) || typeof config.databases !== 'object') {
    return yield* new ConfigParseError({
      message: 'Config must have a "databases" object',
      path: configPath,
      cause: new Error('Missing databases'),
    })
  }

  return config as SchemaGenConfig
})

interface ResolveConfigOptions {
  config: SchemaGenConfig
  configDir: AbsoluteDirPath
}

/** Build resolved database config with optional fields */
const buildResolvedDatabaseConfig = (opts: {
  id: string
  output: AbsoluteFilePath
  merged: DatabaseConfig
  normalizedTransforms: PropertyTransformConfig | undefined
}): ResolvedDatabaseConfig => ({
  id: opts.id,
  output: opts.output,
  ...(opts.merged.name !== undefined && { name: opts.merged.name }),
  ...(opts.merged.includeWrite !== undefined && {
    includeWrite: opts.merged.includeWrite,
  }),
  ...(opts.merged.typedOptions !== undefined && {
    typedOptions: opts.merged.typedOptions,
  }),
  ...(opts.merged.schemaMeta !== undefined && {
    schemaMeta: opts.merged.schemaMeta,
  }),
  ...(opts.merged.includeApi !== undefined && {
    includeApi: opts.merged.includeApi,
  }),
  ...(opts.normalizedTransforms !== undefined && {
    transforms: opts.normalizedTransforms,
  }),
})

/** Resolve database configs with outputDir and defaults applied */
const resolveConfig = ({ config, configDir }: ResolveConfigOptions): ResolvedConfig => {
  const baseDir: AbsoluteDirPath =
    config.outputDir !== undefined ? EffectPath.ops.join(configDir, config.outputDir) : configDir

  const databases = Object.entries(config.databases).map(([id, db]): ResolvedDatabaseConfig => {
    const merged = mergeWithDefaults({
      database: db,
      ...(config.defaults !== undefined && { defaults: config.defaults }),
    })
    const normalizedTransforms = normalizeTransforms(merged.transforms)

    return buildResolvedDatabaseConfig({
      id,
      output: EffectPath.ops.join(baseDir, db.output),
      merged,
      normalizedTransforms,
    })
  })

  return { databases }
}

/**
 * Load configuration from file.
 * Searches for config files in the current directory and parent directories.
 */
export const loadConfig = Effect.fnUntraced(function* (configPath?: string) {
  const fs = yield* FileSystem.FileSystem

  const searchStartDir: AbsoluteDirPath = EffectPath.unsafe.absoluteDir(
    yield* CurrentWorkingDirectory,
  )
  const resolvedPath: AbsoluteFilePath | undefined =
    configPath !== undefined
      ? isAbsolutePath(configPath) === true
        ? EffectPath.unsafe.absoluteFile(configPath)
        : EffectPath.ops.join(searchStartDir, EffectPath.unsafe.relativeFile(configPath))
      : yield* findConfigFile(searchStartDir)

  if (resolvedPath === undefined) {
    return yield* new ConfigNotFoundError({
      message: `No config file found. Create one of: ${CONFIG_FILE_NAMES.join(', ')}`,
      searchStartDir,
      fileNames: CONFIG_FILE_NAMES,
    })
  }

  const exists = yield* fs.exists(resolvedPath).pipe(Effect.orElseSucceed(() => false))
  if (exists === false) {
    return yield* new ConfigFileNotFoundError({
      message: `Config file not found: ${resolvedPath}`,
      path: resolvedPath,
    })
  }

  const rawConfig = yield* loadTsConfig(resolvedPath)
  const configDir = EffectPath.ops.parent(resolvedPath)
  const config = resolveConfig({ config: rawConfig, configDir })

  return { config, path: resolvedPath }
})

/** Merges database config with defaults */
export const mergeWithDefaults = ({
  database,
  defaults,
}: {
  database: DatabaseConfig
  defaults?: DefaultsConfig
}): DatabaseConfig => {
  if (defaults === undefined) return database

  const includeWrite = database.includeWrite ?? defaults.includeWrite
  const typedOptions = database.typedOptions ?? defaults.typedOptions
  const schemaMeta = database.schemaMeta ?? defaults.schemaMeta
  const includeApi = database.includeApi ?? defaults.includeApi
  const transforms: PropertyTransforms = {
    ...defaults.transforms,
    ...database.transforms,
  }

  return {
    output: database.output,
    ...(database.name !== undefined ? { name: database.name } : {}),
    ...(includeWrite !== undefined ? { includeWrite } : {}),
    ...(typedOptions !== undefined ? { typedOptions } : {}),
    ...(schemaMeta !== undefined ? { schemaMeta } : {}),
    ...(includeApi !== undefined ? { includeApi } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
  }
}
