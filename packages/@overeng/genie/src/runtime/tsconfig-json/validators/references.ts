/**
 * Tsconfig reference validator.
 *
 * Validates that tsconfig.json references match workspace dependencies.
 * For each workspace dependency in package.json, there should be a corresponding
 * tsconfig reference to enable proper TypeScript project references.
 */

import type { GenieContext, GenieIO, GenieJsoncParser } from '../../mod.ts'
import type { ValidationIssue } from '../../package-json/validation.ts'
import { joinPath } from '../../utils/path.ts'
import type { TSConfigArgs } from '../mod.ts'

/**
 * Compute relative path from one repo-relative location to another.
 * @param from - Source location (e.g., 'packages/@overeng/genie')
 * @param to - Target location (e.g., 'packages/@overeng/utils')
 * @returns Relative path (e.g., '../utils')
 */
const computeRelativeRef = ({ from, to }: { from: string; to: string }): string => {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const result = '../'.repeat(upCount) + downPath
  return result.endsWith('/') === true ? result.slice(0, -1) : result
}

/**
 * Validate that tsconfig references match workspace dependencies.
 *
 * Checks that for each workspace dependency in package.json, there is a
 * corresponding tsconfig reference. This ensures proper TypeScript project
 * references for build ordering and type checking.
 */
export const validateTsconfigReferences = ({
  ctx,
  references,
}: {
  ctx: GenieContext
  references: TSConfigArgs['references']
}): ValidationIssue[] => {
  // Need workspace context and the filesystem + JSONC-parse capabilities to validate
  if (ctx.workspace === undefined || ctx.io === undefined || ctx.parseJsonc === undefined) return []
  const io = ctx.io
  const parseJsonc = ctx.parseJsonc

  const issues: ValidationIssue[] = []
  const currentRefs = new Set((references ?? []).map((r) => r.path))

  // Find current package from location
  const currentPkg = [...ctx.workspace.byName.values()].find((p) => p.path === ctx.location)
  if (currentPkg === undefined) return []

  // Get workspace dependencies (both deps and devDeps)
  const allDeps = {
    ...currentPkg.dependencies,
    ...currentPkg.devDependencies,
  }

  const workspaceDeps = Object.entries(allDeps).filter(
    ([_depName, version]) => version === 'workspace:*' || version.startsWith('workspace:'),
  )

  // Check each workspace dep has a corresponding tsconfig reference
  for (const [depName] of workspaceDeps) {
    const depPkg = ctx.workspace.byName.get(depName)
    if (depPkg === undefined) continue

    // Skip deps that can't be valid project reference targets:
    // - No tsconfig.json (e.g. meta-packages like peer-deps)
    // - composite: false (e.g. Astro sites, CLI tools)
    // - noEmit: true (TypeScript rejects referenced projects that disable emit)
    const depTsconfigPath = joinPath(ctx.cwd, depPkg.path, 'tsconfig.json')
    if (io.fileExists(depTsconfigPath) === false) continue
    if (isReferenceTargetProject({ tsconfigPath: depTsconfigPath, io, parseJsonc }) === false) {
      continue
    }

    const expectedRef = computeRelativeRef({ from: ctx.location, to: depPkg.path })
    if (currentRefs.has(expectedRef) === false) {
      issues.push({
        severity: 'error',
        packageName: currentPkg.name,
        dependency: depName,
        message: `Missing tsconfig reference "${expectedRef}" for workspace dependency "${depName}"`,
        rule: 'tsconfig-references',
      })
    }
  }

  // Optionally check for extra references (references to packages not in deps)
  // This is less strict - extra references are often intentional for build ordering
  // So we don't report them as issues

  return issues
}

/**
 * Check if a tsconfig.json can be used as a project reference target.
 *
 * Reads the file via the injected {@link GenieIO} and parses it with the injected {@link GenieJsoncParser}
 * (the engine backs it with the same TypeScript JSONC parser the previous `ts.readConfigFile` impl used, so
 * comment-headed/JSONC tsconfigs parse identically). An unreadable or unparseable file yields `false` —
 * matching the prior `catch → false` behavior, conservatively skipping the dep as a reference target.
 */
const isReferenceTargetProject = ({
  tsconfigPath,
  io,
  parseJsonc,
}: {
  tsconfigPath: string
  io: GenieIO
  parseJsonc: GenieJsoncParser
}): boolean => {
  const text = io.readText(tsconfigPath)
  if (text === undefined) return false
  const config = parseJsonc({ path: tsconfigPath, text })
  if (config === undefined) return false
  const compilerOptions = (
    config as { compilerOptions?: { composite?: boolean; noEmit?: boolean } }
  ).compilerOptions
  return compilerOptions?.composite !== false && compilerOptions?.noEmit !== true
}
