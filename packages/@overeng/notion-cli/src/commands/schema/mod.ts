/**
 * Schema subcommand - generate Effect schemas from Notion databases
 */

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { Argument as Args, Command, Flag as Options } from 'effect/unstable/cli'
import { FetchHttpClient } from 'effect/unstable/http'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { NotionConfig, NotionDatabases, NotionDataSources } from '@overeng/notion-effect-client'
import { run } from '@overeng/tui-react'
import {
  OUTPUT_MODE_VALUES,
  outputOption as tuiOutputOption,
  outputModeLayer,
} from '@overeng/tui-react/node'

import { getDiffApp } from '../../renderers/DiffOutput/app.ts'
import { DiffView } from '../../renderers/DiffOutput/view.tsx'
import { getGenerateConfigApp } from '../../renderers/GenerateConfigOutput/app.ts'
import { GenerateConfigView } from '../../renderers/GenerateConfigOutput/view.tsx'
import { getGenerateApp } from '../../renderers/GenerateOutput/app.ts'
import { GenerateView } from '../../renderers/GenerateOutput/view.tsx'
import { getIntrospectApp } from '../../renderers/IntrospectOutput/app.ts'
import { IntrospectView } from '../../renderers/IntrospectOutput/view.tsx'
import { resolveNotionToken, tokenOption } from '../shared.ts'

/** Re-export internal types for TypeScript declaration emit */
export type { PlatformError } from 'effect/PlatformError'

import { type GenerateOptions, generateApiCode, generateSchemaCode } from '../../codegen.ts'
import { loadConfig } from '../../config.ts'
import { computeDiff, hasDifferences, parseGeneratedFile } from '../../diff.ts'
import { introspectDatabase, type PropertyTransformConfig } from '../../introspect.ts'
import { formatCode, writeSchemaToFile } from '../../output.ts'

export { resolveNotionToken, tokenOption } from '../shared.ts'

// -----------------------------------------------------------------------------
// Exported Errors
// -----------------------------------------------------------------------------

/** Error thrown when a generated schema file cannot be parsed for drift detection */
export class GeneratedSchemaFileParseError extends Schema.TaggedError<GeneratedSchemaFileParseError>()(
  'GeneratedSchemaFileParseError',
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

/** Error thrown when generated schema differs from existing file during check mode */
export class SchemaDriftDetectedError extends Schema.TaggedError<SchemaDriftDetectedError>()(
  'SchemaDriftDetectedError',
  {
    databaseId: Schema.String,
    file: Schema.String,
    message: Schema.String,
  },
) {}

// -----------------------------------------------------------------------------
// Common Options
// -----------------------------------------------------------------------------

const GeneratorPackageJsonSchema = Schema.Struct({ version: Schema.String })

const getGeneratorVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pkgJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url))
  const content = yield* fs.readFileString(pkgJsonPath)
  const pkg = yield* Schema.decodeEffect(Schema.fromJsonString(GeneratorPackageJsonSchema))(content)
  return pkg.version
}).pipe(Effect.orElseSucceed(() => 'unknown'))

// -----------------------------------------------------------------------------
// Generate Command
// -----------------------------------------------------------------------------

const generateDatabaseIdArg = Args.string('database-id').pipe(
  Args.withDescription('The Notion database ID to generate schema from'),
)

const outputOption = Options.file('output').pipe(
  Options.withAlias('o'),
  Options.withDescription(
    'Output file path for generated schema (recommend using .gen.ts suffix, e.g., schema.gen.ts)',
  ),
)

/**
 * TUI render-mode option for commands that also take a file `--output`/`-o`.
 * Uses a distinct `--output-mode` flag (no `-o` alias) so the file-output option
 * keeps `--output`/`-o`; the shared tui `outputOption` claims those and would
 * otherwise shadow the file path, making `generate <id> -o file.ts` fail.
 */
const tuiOutputModeOption = Options.choice('output-mode', OUTPUT_MODE_VALUES).pipe(
  Options.withDescription('TUI render mode (auto, pretty, ci-plain, json, ...)'),
  Options.withDefault('auto' as (typeof OUTPUT_MODE_VALUES)[number]),
)

const nameOption = Options.string('name').pipe(
  Options.withAlias('n'),
  Options.withDescription('Name for the generated schema (defaults to database title)'),
  Options.optional,
)

const transformOption = Options.keyValuePair('transform').pipe(
  Options.withDescription(
    'Property transform config: property=transform (e.g., Status=asName, Title=asString)',
  ),
  Options.optional,
)

const dryRunOption = Options.boolean('dry-run').pipe(
  Options.withAlias('d'),
  Options.withDescription('Preview generated code without writing to file'),
  Options.withDefault(false),
)

const includeWriteOption = Options.boolean('include-write').pipe(
  Options.withAlias('w'),
  Options.withDescription('Include Write schemas for creating/updating pages'),
  Options.withDefault(false),
)

const typedOptionsOption = Options.boolean('typed-options').pipe(
  Options.withDescription(
    'Generate typed literal unions for select/status/multi_select options and use typed property transforms by default',
  ),
  Options.withDefault(false),
)

const schemaMetaOption = Options.boolean('schema-meta').pipe(
  Options.withDescription('Include Notion property metadata annotations in the generated schema'),
  Options.withDefault(true),
)

const noSchemaMetaOption = Options.boolean('no-schema-meta').pipe(
  Options.withDescription('Disable Notion property metadata annotations'),
  Options.withDefault(false),
)

const includeApiOption = Options.boolean('include-api').pipe(
  Options.withAlias('a'),
  Options.withDescription('Generate a typed database API wrapper alongside the schema'),
  Options.withDefault(false),
)

const writableOption = Options.boolean('writable').pipe(
  Options.withDescription(
    'Keep generated files writable (default: false, files are made read-only to discourage manual edits)',
  ),
  Options.withDefault(false),
)

/** Exported for parse-level testing of option resolution (see mod.unit.test.ts). */
export const generateCommand = Command.make(
  'generate',
  {
    databaseId: generateDatabaseIdArg,
    output: outputOption,
    name: nameOption,
    token: tokenOption,
    transform: transformOption,
    dryRun: dryRunOption,
    includeWrite: includeWriteOption,
    typedOptions: typedOptionsOption,
    schemaMeta: schemaMetaOption,
    noSchemaMeta: noSchemaMetaOption,
    includeApi: includeApiOption,
    writable: writableOption,
    tuiOutput: tuiOutputModeOption,
  },
  ({
    databaseId,
    output,
    name,
    token,
    transform,
    dryRun,
    includeWrite,
    typedOptions,
    schemaMeta,
    noSchemaMeta,
    includeApi,
    writable,
    tuiOutput,
  }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const generatorVersion = yield* getGeneratorVersion

      const transformConfig: PropertyTransformConfig = {}
      if (Option.isSome(transform) === true) {
        for (const [key, value] of Object.entries(transform.value)) {
          transformConfig[key] = value
        }
      }

      const generateOptions: GenerateOptions = {
        transforms: transformConfig,
        includeWrite,
        typedOptions,
        schemaMeta: noSchemaMeta === true ? false : schemaMeta,
        includeApi,
        generatorVersion,
        ...(Option.isSome(name) === true ? { schemaNameOverride: name.value } : {}),
      }

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: resolvedToken,
      })

      const generateApp = getGenerateApp()

      yield* run(
        generateApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              tui.dispatch({ _tag: 'SetIntrospecting', databaseId })
              const dbInfo = yield* introspectDatabase(databaseId)

              const schemaName = name._tag === 'Some' ? name.value : dbInfo.name
              tui.dispatch({ _tag: 'SetGenerating', schemaName })

              const rawCode = generateSchemaCode({
                dbInfo,
                schemaName,
                options: generateOptions,
              })
              const code = yield* formatCode(rawCode)

              if (dryRun === true) {
                if (includeApi === true) {
                  const schemaFileName = basename(output)
                  const rawApiCode = generateApiCode({
                    dbInfo,
                    schemaName,
                    schemaFileName,
                    options: generateOptions,
                  })
                  const apiCode = yield* formatCode(rawApiCode)
                  const apiOutput = output.replace(/\.ts$/, '.api.ts')

                  tui.dispatch({
                    _tag: 'SetDryRun',
                    code,
                    apiCode,
                    outputPath: output,
                    apiOutputPath: apiOutput,
                  })
                } else {
                  tui.dispatch({
                    _tag: 'SetDryRun',
                    code,
                    outputPath: output,
                  })
                }
              } else {
                tui.dispatch({ _tag: 'SetWriting', outputPath: output })
                yield* writeSchemaToFile({
                  code,
                  outputPath: EffectPath.unsafe.absoluteFile(output),
                  writable,
                })

                if (includeApi === true) {
                  const schemaFileName = basename(output)
                  const rawApiCode = generateApiCode({
                    dbInfo,
                    schemaName,
                    schemaFileName,
                    options: generateOptions,
                  })
                  const apiCode = yield* formatCode(rawApiCode)
                  const apiOutput = output.replace(/\.ts$/, '.api.ts')

                  yield* writeSchemaToFile({
                    code: apiCode,
                    outputPath: EffectPath.unsafe.absoluteFile(apiOutput),
                    writable,
                  })

                  tui.dispatch({
                    _tag: 'SetDone',
                    outputPath: output,
                    writable,
                    apiOutputPath: apiOutput,
                  })
                } else {
                  tui.dispatch({ _tag: 'SetDone', outputPath: output, writable })
                }
              }
            })

            yield* program.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        { view: React.createElement(GenerateView, { stateAtom: generateApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(tuiOutput)))
    }),
).pipe(Command.withDescription('Generate Effect schema from a Notion database'))

// -----------------------------------------------------------------------------
// Introspect Command
// -----------------------------------------------------------------------------

const introspectDatabaseIdArg = Args.string('database-id').pipe(
  Args.withDescription('The Notion database ID to introspect'),
)

const introspectCommand = Command.make(
  'introspect',
  { databaseId: introspectDatabaseIdArg, token: tokenOption, output: tuiOutputOption },
  ({ databaseId, token, output }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: resolvedToken,
      })

      const introspectApp = getIntrospectApp()

      yield* run(
        introspectApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              const db = yield* NotionDatabases.retrieve({ databaseId })

              // In API 2026-03-11, properties live on the data source
              const firstDataSourceId = db.data_sources?.[0]?.id
              const properties =
                firstDataSourceId !== undefined
                  ? (yield* NotionDataSources.retrieve({ dataSourceId: firstDataSourceId }))
                      .properties
                  : (db.properties ?? {})
              const propertyList = Object.entries(properties).map(([propName, propValue]) => {
                const prop = propValue as { type: string; [key: string]: unknown }
                const result: {
                  name: string
                  type: string
                  options?: string[]
                  groups?: string[]
                  relationDatabase?: string
                } = { name: propName, type: prop.type }

                if (prop.type === 'select' || prop.type === 'multi_select') {
                  const options = (prop[prop.type] as { options?: Array<{ name: string }> })
                    ?.options
                  if (options !== undefined && options.length > 0) {
                    result.options = options.map((o) => o.name)
                  }
                }
                if (prop.type === 'status') {
                  const statusConfig = prop.status as {
                    options?: Array<{ name: string }>
                    groups?: Array<{ name: string }>
                  }
                  if (statusConfig?.options !== undefined && statusConfig.options.length > 0) {
                    result.options = statusConfig.options.map((o) => o.name)
                  }
                  if (statusConfig?.groups !== undefined && statusConfig.groups.length > 0) {
                    result.groups = statusConfig.groups.map((g) => g.name)
                  }
                }
                if (prop.type === 'relation') {
                  const relationConfig = prop.relation as { database_id?: string }
                  if (relationConfig?.database_id !== undefined) {
                    result.relationDatabase = relationConfig.database_id
                  }
                }

                return result
              })

              tui.dispatch({
                _tag: 'SetResult',
                dbName: db.title.map((t) => t.plain_text).join(''),
                dbId: db.id,
                dbUrl: db.url,
                properties: propertyList,
              })
            })

            yield* program.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        { view: React.createElement(IntrospectView, { stateAtom: introspectApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Command.withDescription('Introspect a Notion database and display its schema'))

// -----------------------------------------------------------------------------
// Generate From Config Command
// -----------------------------------------------------------------------------

const configOption = Options.file('config').pipe(
  Options.withAlias('c'),
  Options.withDescription(
    'Path to config file (defaults to searching for notion-schema-gen.config.ts in current/parent dirs)',
  ),
  Options.optional,
)

const generateFromConfigCommand = Command.make(
  'generate-config',
  {
    config: configOption,
    token: tokenOption,
    dryRun: dryRunOption,
    writable: writableOption,
    output: tuiOutputOption,
  },
  ({ config, token, dryRun, writable, output }) =>
    Effect.gen(function* () {
      const { config: resolvedConfig, path: resolvedConfigPath } = yield* loadConfig(
        Option.isSome(config) === true ? config.value : undefined,
      )

      const resolvedToken = yield* resolveNotionToken(token)
      const generatorVersion = yield* getGeneratorVersion

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: resolvedToken,
      })

      const generateConfigApp = getGenerateConfigApp()

      yield* run(
        generateConfigApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetConfig',
                configPath: resolvedConfigPath,
                databases: resolvedConfig.databases.map((db) => ({
                  id: db.id,
                  name: db.name ?? db.id,
                  outputPath: db.output,
                })),
              })

              for (const dbConfig of resolvedConfig.databases) {
                tui.dispatch({ _tag: 'UpdateDatabase', id: dbConfig.id, status: 'introspecting' })
                const dbInfo = yield* introspectDatabase(dbConfig.id)

                const schemaName = dbConfig.name ?? dbInfo.name
                tui.dispatch({
                  _tag: 'UpdateDatabase',
                  id: dbConfig.id,
                  status: 'generating',
                  name: schemaName,
                })

                const generateOptions: GenerateOptions = {
                  transforms: dbConfig.transforms ?? {},
                  includeWrite: dbConfig.includeWrite ?? false,
                  typedOptions: dbConfig.typedOptions ?? false,
                  schemaMeta: dbConfig.schemaMeta ?? true,
                  includeApi: dbConfig.includeApi ?? false,
                  generatorVersion,
                  ...(dbConfig.name !== undefined ? { schemaNameOverride: dbConfig.name } : {}),
                }

                const rawCode = generateSchemaCode({
                  dbInfo,
                  schemaName,
                  options: generateOptions,
                })
                const code = yield* formatCode(rawCode)

                if (dryRun === true) {
                  // In dry-run mode, still show progress but don't write files
                  tui.dispatch({ _tag: 'UpdateDatabase', id: dbConfig.id, status: 'done' })
                } else {
                  tui.dispatch({ _tag: 'UpdateDatabase', id: dbConfig.id, status: 'writing' })
                  yield* writeSchemaToFile({
                    code,
                    outputPath: EffectPath.unsafe.absoluteFile(dbConfig.output),
                    writable,
                  })

                  if (generateOptions.includeApi === true) {
                    const schemaFileName = basename(dbConfig.output)
                    const rawApiCode = generateApiCode({
                      dbInfo,
                      schemaName,
                      schemaFileName,
                      options: generateOptions,
                    })
                    const apiCode = yield* formatCode(rawApiCode)
                    const apiOutput = dbConfig.output.replace(/\.ts$/, '.api.ts')

                    yield* writeSchemaToFile({
                      code: apiCode,
                      outputPath: EffectPath.unsafe.absoluteFile(apiOutput),
                      writable,
                    })
                  }

                  tui.dispatch({ _tag: 'UpdateDatabase', id: dbConfig.id, status: 'done' })
                }
              }

              tui.dispatch({ _tag: 'SetDone', count: resolvedConfig.databases.length })
            })

            yield* program.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        {
          view: React.createElement(GenerateConfigView, { stateAtom: generateConfigApp.stateAtom }),
        },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Command.withDescription('Generate schemas for all databases in a config file'))

// -----------------------------------------------------------------------------
// Diff Command
// -----------------------------------------------------------------------------

const diffDatabaseIdArg = Args.string('database-id').pipe(
  Args.withDescription('The Notion database ID to compare against'),
)

const diffFileOption = Options.file('file').pipe(
  Options.withAlias('f'),
  Options.withDescription('Path to the existing generated schema file'),
)

const exitCodeOption = Options.boolean('exit-code').pipe(
  Options.withDescription('Exit with code 1 if differences are found (for CI)'),
  Options.withDefault(false),
)

const diffCommand = Command.make(
  'diff',
  {
    databaseId: diffDatabaseIdArg,
    file: diffFileOption,
    token: tokenOption,
    exitCode: exitCodeOption,
    output: tuiOutputOption,
  },
  ({ databaseId, file, token, exitCode, output }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const fs = yield* FileSystem.FileSystem

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: resolvedToken,
      })

      const diffApp = getDiffApp()

      yield* run(
        diffApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              const fileContent = yield* fs.readFileString(file)
              const parsedSchema = parseGeneratedFile(fileContent)
              if (parsedSchema.readSchemaFound === false) {
                return yield* new GeneratedSchemaFileParseError({
                  file,
                  message:
                    'Could not find a "*PageProperties = Schema.Struct({ ... })" read schema in file',
                })
              }

              const dbInfo = yield* introspectDatabase(databaseId)
              const diff = computeDiff({ live: dbInfo, generated: parsedSchema })

              if (hasDifferences(diff) === true) {
                tui.dispatch({
                  _tag: 'SetResult',
                  databaseId,
                  filePath: file,
                  properties: diff.properties.map((p) => ({
                    name: p.name,
                    type: p.type,
                    liveType: p.live?.type,
                    liveTransform: p.live?.transform,
                    generatedTransformKey: p.generated?.transformKey,
                  })),
                  options: diff.options.map((o) => ({
                    name: o.name,
                    added: [...o.added],
                    removed: [...o.removed],
                  })),
                  hasDifferences: true,
                })

                if (exitCode === true) {
                  return yield* new SchemaDriftDetectedError({
                    databaseId,
                    file,
                    message: 'Schema drift detected',
                  })
                }
              } else {
                tui.dispatch({
                  _tag: 'SetNoDifferences',
                  databaseId,
                  filePath: file,
                })
              }
            })

            yield* program.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        { view: React.createElement(DiffView, { stateAtom: diffApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(
  Command.withDescription('Compare a Notion database schema with a generated file to detect drift'),
)

// -----------------------------------------------------------------------------
// Schema Subcommand
// -----------------------------------------------------------------------------

/** Schema command with subcommands for generation and drift detection. */
export const schemaCommand = Command.make('schema').pipe(
  Command.withSubcommands([
    generateCommand,
    introspectCommand,
    generateFromConfigCommand,
    diffCommand,
  ]),
  Command.withDescription('Schema generation commands'),
)
