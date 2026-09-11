/**
 * Build the two-surface inputs for the SM5c local-convergence engine from the
 * production push-path state: the drained SQLite data-file edits and the decoded
 * `pages/v1/<source>/*.nmd` desired facts.
 *
 * This is the observation channel that closes the SM5b gap (the datasource-sync
 * `.nmd` scan was body-only): it decodes `.nmd` FRONTMATTER properties per page,
 * resolves each visible property name to its stable `property_id` through the
 * tracked schema, and emits a per-property `NmdDesiredFact` ONLY when the
 * `.nmd`-derived canonical value differs from the observed base (a baseline diff —
 * the `.nmd` frontmatter is a full snapshot, not an edit set, so without the diff
 * every untouched property would false-conflict against a SQLite-only edit).
 *
 * Identity (R06): property = stable `property_id`; body = rendered body digest;
 * lifecycle is left to a later pass (see the scope note in the module that wires
 * this). All comparison hashes route through `convergenceFormHash` (the name-only
 * space the `.nmd` surface can reach) so the SQLite and `.nmd` surfaces compare
 * like-with-like.
 *
 * ACTIVE IN THE REAL FLOW (SM5d). A datasource pull now MATERIALIZES the writable
 * frontmatter properties into the pulled `.nmd`: the observation pass decodes each
 * observed cell to an `NmdWritablePropertyValue` (`canonicalValueToNmdWritable`,
 * filtered to `write_class === 'writable'`) and passes them to `materializeBody`.
 * So `scanNmdPageSurfaces` reads a real property surface and the convergence here
 * fires on production data, not just hand-authored `.nmd`. The materialized value
 * round-trips into the same name-only `convergence_hash` space, so an UNEDITED
 * pulled `.nmd` does not false-diverge (proven in
 * `property-materialization-production.e2e.test.ts`).
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Effect } from 'effect'
import { Schema } from 'effect'

import type { NmdWritablePropertyValue } from '@overeng/notion-effect-client'
import { parseNmdFile } from '@overeng/notion-md'

import type { Hash, PageId, PropertyId } from '../core/domain.ts'
import {
  Hash as HashSchema,
  PageId as PageIdSchema,
  PropertyId as PropertyIdSchema,
} from '../core/domain.ts'
import type {
  DataFileLocalEdit,
  LocalIdentity,
  NmdDesiredFact,
} from '../planner/local-convergence.ts'
import { convergenceFormHash, nmdPropertyCanonicalValue } from '../planner/nmd-property-facts.ts'
import type { ReplicaCellBase } from '../replica/replica.ts'
import type { ReplicaLocalChange } from '../replica/replica.ts'

const decodePageId = (value: string): PageId => Schema.decodeSync(PageIdSchema)(value)
const decodePropertyId = (value: string): PropertyId => Schema.decodeSync(PropertyIdSchema)(value)
const decodeHashLike = (value: string): Hash => Schema.decodeSync(HashSchema)(value)

/** A scanned `.nmd` file's relevant decoded surface. */
export type NmdPageSurface = {
  readonly pageId: PageId
  /** Visible-name → writable property value, from frontmatter. */
  readonly properties: Readonly<Record<string, NmdWritablePropertyValue>>
}

/**
 * Scan + decode every `.nmd` file under a source page directory. Files that fail
 * to parse, or that carry no bound `page_id`, are skipped (a malformed or unbound
 * `.nmd` is not a convergence surface). Pure read; no live handles.
 */
export const scanNmdPageSurfaces = ({
  workspaceRoot,
  pagesDir,
}: {
  readonly workspaceRoot: string
  readonly pagesDir: string
}): ReadonlyArray<NmdPageSurface> => {
  const absoluteDir = join(workspaceRoot, pagesDir)
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(absoluteDir).filter((name) => name.endsWith('.nmd'))
  } catch {
    // Missing page directory: nothing to converge from the `.nmd` side.
    return []
  }

  const surfaces: NmdPageSurface[] = []
  for (const name of entries) {
    const path = join(absoluteDir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const parsed = Effect.runSync(parseNmdFile({ content, path }).pipe(Effect.result))
    if (parsed._tag === 'Failure') continue
    const body = parsed.success.frontmatter.notion_md
    if (body.page_id === null) continue
    surfaces.push({
      pageId: decodePageId(body.page_id),
      properties: body.properties,
    })
  }
  return surfaces
}

/**
 * Project the drained SQLite `cell_patch` changes into property
 * `DataFileLocalEdit`s. The convergence `desiredHash` is `convergenceFormHash` of
 * the edit's `value_json`; the `baseHash` is the cell's pristine `convergence_hash`
 * (the name-only base computed at pull time), NOT a hash re-derived from
 * `base.valueJson` — a local `pages` edit overwrites `value_json` with the desired
 * value, so re-deriving the base from it would compare the edit against itself.
 * Both surfaces thus diff in one consistent space.
 */
export const dataFilePropertyEdits = ({
  changes,
  baseByCell,
}: {
  readonly changes: ReadonlyArray<ReplicaLocalChange>
  readonly baseByCell: ReadonlyMap<string, ReplicaCellBase>
}): ReadonlyArray<DataFileLocalEdit> => {
  const edits: DataFileLocalEdit[] = []
  for (const change of changes) {
    if (change.kind !== 'cell_patch') continue
    if (change.pageId === undefined || change.propertyId === undefined) continue
    if (change.valueJson === undefined) continue
    const identity: LocalIdentity = {
      kind: 'property',
      pageId: decodePageId(change.pageId),
      propertyId: decodePropertyId(change.propertyId),
    }
    const base = baseByCell.get(`${change.pageId} ${change.propertyId}`)
    edits.push({
      identity,
      desiredHash: convergenceFormHash(change.valueJson),
      ...(base?.convergenceHash === undefined
        ? {}
        : { baseHash: decodeHashLike(base.convergenceHash) }),
    })
  }
  return edits
}

/**
 * Project decoded `.nmd` frontmatter properties into per-property
 * `NmdDesiredFact`s, with the baseline diff. A fact is emitted for property P on
 * page G only when:
 *
 * - P's visible name resolves to exactly one stable `property_id` on G's tracked
 *   schema (fail closed on 0 or >1 — never key identity on an ambiguous name), and
 * - P is a convergence-comparable scalar type (`nmdPropertyCanonicalValue`
 *   returns a value), and
 * - the `.nmd` canonical value differs from the cell's pristine `convergence_hash`
 *   base (`convergenceFormHash` mismatch) — i.e. the user actually changed it in `.nmd`.
 */
export const nmdPropertyFacts = ({
  surfaces,
  bases,
}: {
  readonly surfaces: ReadonlyArray<NmdPageSurface>
  readonly bases: ReadonlyArray<ReplicaCellBase>
}): ReadonlyArray<NmdDesiredFact> => {
  // name → cell bases, scoped per page (Notion property names are unique per DB).
  const basesByPageName = new Map<string, ReplicaCellBase[]>()
  for (const base of bases) {
    const nameKey = `${base.pageId} ${base.propertyName}`
    const list = basesByPageName.get(nameKey) ?? []
    list.push(base)
    basesByPageName.set(nameKey, list)
  }

  const facts: NmdDesiredFact[] = []
  for (const surface of surfaces) {
    for (const [name, value] of Object.entries(surface.properties)) {
      const candidates = basesByPageName.get(`${surface.pageId} ${name}`) ?? []
      // Fail closed: a name must resolve to exactly one tracked property id.
      if (candidates.length !== 1) continue
      const base = candidates[0]!
      const canonical = nmdPropertyCanonicalValue(value)
      if (canonical === undefined) continue // non-scalar / non-comparable
      const desiredHash = convergenceFormHash(JSON.stringify(canonical))
      /*
       * Baseline diff against the cell's pristine `convergence_hash`, the NAME-ONLY
       * base computed at pull time (option id/color stripped, cleared scalars
       * folded). Critically NOT `remote_hash`: that is the FULL canonical (keeps
       * option id+color), so a real Notion select would diff unequal against the
       * name-only `.nmd` value even when UNTOUCHED — a spurious fact that would
       * block a legitimate SQLite-side edit. And NOT the cell's `value_json` either:
       * a local `pages` edit overwrites it, so diffing against it would suppress a
       * real `.nmd` edit. `convergence_hash` is untouched by local edits and lives
       * in the exact `.nmd` comparison space.
       */
      if (base.convergenceHash === undefined) continue // never convergence-comparable
      const baseHash = decodeHashLike(base.convergenceHash)
      // Only an actual `.nmd` edit (differs from the pristine convergence base) is a fact.
      if (desiredHash === baseHash) continue
      facts.push({
        identity: {
          kind: 'property',
          pageId: surface.pageId,
          propertyId: decodePropertyId(base.propertyId),
        },
        desiredHash,
        baseHash,
      })
    }
  }
  return facts
}

/**
 * Build the full property-surface convergence inputs for the shared-mode push
 * path. Body and lifecycle convergence are layered by the caller (their channels
 * already exist); this function owns the property surface, which is the SM5c crux.
 */
export const buildPropertyConvergenceInputs = ({
  workspaceRoot,
  pagesDir,
  changes,
  bases,
}: {
  readonly workspaceRoot: string
  readonly pagesDir: string
  readonly changes: ReadonlyArray<ReplicaLocalChange>
  readonly bases: ReadonlyArray<ReplicaCellBase>
}): {
  readonly dataFileEdits: ReadonlyArray<DataFileLocalEdit>
  readonly nmdFacts: ReadonlyArray<NmdDesiredFact>
} => {
  const baseByCell = new Map<string, ReplicaCellBase>()
  for (const base of bases) {
    baseByCell.set(`${base.pageId} ${base.propertyId}`, base)
  }
  const surfaces = scanNmdPageSurfaces({ workspaceRoot, pagesDir })
  return {
    dataFileEdits: dataFilePropertyEdits({ changes, baseByCell }),
    nmdFacts: nmdPropertyFacts({ surfaces, bases }),
  }
}
