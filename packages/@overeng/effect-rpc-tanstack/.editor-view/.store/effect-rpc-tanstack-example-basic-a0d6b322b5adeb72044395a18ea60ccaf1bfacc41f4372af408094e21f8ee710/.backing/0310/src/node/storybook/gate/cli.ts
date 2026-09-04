/**
 * Runnable entry point for the story gate.
 *
 * Without this the gate is a library function and every target has to write its
 * own driver, which is the same per-target duplication the shared layer exists
 * to remove — and a check nobody can run is not the "working visual check" R08
 * asks for.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { runStoryGate } from './run.ts'

const usage = `Usage: gate [--package <dir>] [--ref <git-ref>] [--refresh] [--single-scheme]

  --package        package directory holding .storybook (default: cwd)
  --ref            git ref supplying the baseline (default: HEAD)
  --refresh        re-derive the baseline even if one is cached
  --single-scheme  this target ships one colour scheme, so theme projects are
                   expected to render identically and that is not a failure
  --skip-third-capture
                   capture the baseline twice instead of three times, for a
                   fast local loop. The run then CANNOT observe a story that
                   reproduces across a pair and differs on a third capture —
                   a class with measured members — and reports it as unmeasured
                   rather than as zero. Default is three; this is an opt-out.
`

const readFlag = ({
  argv,
  flag,
}: {
  argv: readonly string[]
  flag: string
}): string | undefined => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/** Run the gate and print a report; resolves to the process exit code. */
export const runStoryGateCli = async (argv: readonly string[]): Promise<number> => {
  if (argv.includes('--help') === true) {
    process.stdout.write(usage)
    return 0
  }

  const report = await runStoryGate({
    packageDir: readFlag({ argv, flag: '--package' }) ?? process.cwd(),
    baselineRef: readFlag({ argv, flag: '--ref' }) ?? 'HEAD',
    refresh: argv.includes('--refresh'),
    themeVaries: argv.includes('--single-scheme') === false,
    // Opt-OUT, and the default is the thorough one. A flag whose default
    // silently did less work than the report claims would be the fifth way this
    // gate has been caught reporting success over work it did not do.
    baselineCaptures: argv.includes('--skip-third-capture') === true ? 2 : 3,
  })

  // Capture liveness comes FIRST, before any pass/fail number. The failure
  // signature this project keeps hitting is zero-work-plus-zero-errors: a
  // harness that never launched a browser emits no failures and reads as
  // perfect. A positive settled count, emitted per story by the browser itself,
  // is the only thing that distinguishes "everything settled" from "nothing
  // ran", so it is asserted before anything is interpreted.
  const liveness = [
    '=== capture liveness ===',
    `  settled ${report.settle.settledStories} · never settled ${report.settle.unsettledStories} · opted out ${report.excluded.length} · compared ${report.comparedStories}`,
    `  settle cost per story: min ${report.settle.minMs}ms · median ${report.settle.medianMs}ms · max ${report.settle.maxMs}ms (bound ${report.settle.boundMs}ms — a bound, not a target)`,
    `  total spent settling: ${report.settle.totalMs}ms`,
    ...(report.settle.settledStories === 0
      ? ['', '!! NOTHING SETTLED — every number below is meaningless.']
      : []),
  ]

  // Three-way, not two. A pair check has MEASURED false negatives — a story
  // that reproduced across two captures and then differed on a third of the
  // identical tree — so "differed on the second" and "differed only on the
  // third" are different populations with different causes, and one combined
  // self-inconsistent count hides the second entirely.
  //
  // The residual is printed WITH the result rather than left to the reader. A
  // story alternating between two frames at ~50/50 agrees across three captures
  // a quarter of the time, so this is a better detector and not a closed class.
  // A probe trusted as certain while being 75% reliable is worse than one known
  // to be partial.
  const marginalMs =
    report.stability.thirdCaptureMs === undefined || report.stability.reproduced === 0
      ? undefined
      : Math.round(report.stability.thirdCaptureMs / report.stability.reproduced)
  const stability = [
    `=== capture stability (baseline captured ${report.stability.captures}x) ===`,
    `  reproduced across all ${report.stability.captures}      ${report.stability.reproduced}`,
    `  differed on capture 2       ${report.stability.differedOnSecond.length}  (a two-capture probe catches these)`,
    // Reported unconditionally, including as a zero, because this class used to
    // be silently dropped: a story that captured on one probe of a tree and not
    // on another entered no list at all. `?? []` covers a cache entry written
    // before the field existed, not a probe that never ran.
    `  captured on some, not all  ${(report.stability.inconsistentPresence ?? []).length}  (present in one capture of the tree, absent from another)`,
    ...(report.stability.thirdCaptureMs === undefined
      ? [
          '  differed only on capture 3  NOT MEASURED — this run passed --skip-third-capture, so a story that reproduces across a pair and differs on a third was counted as stable. That is not a zero.',
        ]
      : [
          `  differed only on capture 3  ${report.stability.differedOnThird.length}  (invisible to a two-capture probe)`,
          `  third capture cost          ${report.stability.thirdCaptureMs}ms${marginalMs === undefined ? '' : ` · ${marginalMs}ms/story marginal`} · each capture ${report.stability.captureMs.join('/')}ms`,
          '  A third capture lowers the miss rate, it does not close the class: a story alternating between two frames at ~50/50 still agrees across three captures 25% of the time.',
        ]),
  ]

  // Which capture sets the verdict rests on, stated rather than implied. One
  // invocation captures the baseline tree `baselineCaptures` times and the
  // compare tree ONCE, so
  // this run cannot speak to the compare side's self-consistency — and saying
  // so beats reading as complete under a protocol that assumed pairs on both
  // sides.
  const provenance = [
    '=== capture provenance ===',
    `  baseline    ${report.baselineRef} (${report.baselineSha.slice(0, 9)}) captured ${report.captureSets.baselineCaptures}x · tree ${report.treeIdentity.baseline.digest.slice(0, 9)}`,
    `  compare     working tree (${report.treeIdentity.compare.head.slice(0, 9)}) captured ${report.captureSets.compareCaptures}x · tree ${report.treeIdentity.compare.digest.slice(0, 9)}`,
    `  captures in ${report.captureSets.baselineDir}`,
    '  The compare side was captured ONCE, so the stability figures above cover the baseline tree only. For an after-set, run the gate again with --ref <after-sha>.',
  ]

  // The baseline health goes in the headline, not the detail. The false green
  // this guards against turned on a summary that said "no regressions" while
  // the report said every story failed at the baseline; a summary that cannot
  // express "the baseline was unusable" is part of that defect.
  const verdict = report.ok === true ? 'PASS' : 'FAIL'
  const lines = [
    ...liveness,
    '',
    ...stability,
    '',
    ...provenance,
    '',
    `${verdict}  ${report.comparedStories} compared · ${report.baseline.passed}/${report.baseline.total} passed at baseline · ${report.changed.length} changed · ${report.added.length} added · ${report.removed.length} removed · ${report.uncovered.length} uncovered · ${report.preExisting.length} pre-existing · ${report.excluded.length} excluded · ${report.unsettled.length} never settled · ${report.nondeterministic.length} nondeterministic · ${report.selfInconsistent.length} self-inconsistent captures`,
    ...(report.baseline.passed === 0
      ? ['', 'Nothing passed at the baseline ref. That is an unusable baseline, not a clean run.']
      : []),
    ...(report.themeAxis.projects.length > 1
      ? [
          `theme axis  ${report.themeAxis.differing}/${report.themeAxis.comparable} comparable stories differ across ${report.themeAxis.projects.join(', ')}`,
        ]
      : []),
    ...(report.themeAxis.projects.length > 1 && report.themeAxis.differing === 0
      ? [
          '',
          'No story rendered differently across the theme projects. Either the theme global never reaches the styled element — in which case both projects captured the same palette and the coverage is imaginary — or this target ships one scheme and should pass --single-scheme.',
        ]
      : []),
    ...(report.uncovered.length > 0
      ? [
          '',
          `${report.uncovered.length} stories have no baseline image, so they were never compared.`,
        ]
      : []),
    ...(report.unsettled.length > 0
      ? [
          '',
          `${report.unsettled.length} stories never reached a quiet DOM within ${report.settle.boundMs}ms and were excluded from the visual comparison. Excluded BY OBSERVATION, not by declaration — nobody reviewed these. Either fix the story or declare parameters.storyGate.unstable so the decision is on the record.`,
        ]
      : []),
    ...(report.stability.differedOnThird.length > 0
      ? [
          '',
          `${report.stability.differedOnThird.length} captures reproduced across the first two captures of the identical baseline tree and then differed on a third. A two-capture probe reports these as stable, which is why they are named separately. They are NOT a readiness failure — the DOM was quiet and the settle signal was satisfied — so no better settle predicate reaches them; look downstream at compositing, image decode, or anything varying after layout is final.`,
        ]
      : []),
    ...(report.nondeterministic.length > 0
      ? [
          '',
          `${report.nondeterministic.length} stories rendered differently but were already known nondeterministic from the baseline probe, so their difference is not evidence either way. They are excluded from the changed list and named below; fix their nondeterminism and the gate can start speaking about them.`,
        ]
      : []),
    '',
    ...report.changed.map((change) => `  ${change.kind.padEnd(13)} ${change.story}`),
    ...report.added.map((story) => `  added         ${story}`),
    ...report.removed.map((story) => `  removed       ${story}`),
    ...report.uncovered.map((file) => `  uncovered     ${file}`),
    ...report.excluded.map((story) => `  excluded      ${story} (parameters.storyGate.unstable)`),
    ...report.unsettled.flatMap((record) => [
      `  never settled ${record.name} (${record.reason ?? 'unknown'}, gave up after ${record.elapsedMs}ms)`,
      `                shapes: ${record.shapes.join(' -> ')}`,
    ]),
    ...report.nondeterministic.map(
      (story) => `  nondeterministic ${story} (differs from itself at the baseline)`,
    ),
    ...report.stability.differedOnThird.map(
      (key) => `  third-capture only ${key} (reproduced on captures 1-2, differed on 3)`,
    ),
    ...(report.stability.inconsistentPresence ?? []).map(
      (key) =>
        `  presence varies ${key} (captured on some captures of the identical tree, absent from others)`,
    ),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)

  return report.ok === true ? 0 : 1
}

/**
 * Run only when invoked directly — compared through `realpath`, which is the
 * load-bearing detail.
 *
 * Measured: a megarepo materialises `repos/effect-utils` as a SYMLINK into the
 * store, so `process.argv[1]` is the symlinked path while `import.meta.url` is
 * the resolved one. A plain comparison fails, the module loads, nothing runs,
 * and the process exits 0 WITH NO OUTPUT — a gate that silently does nothing
 * and reports success, which is the exact failure signature this gate exists to
 * eliminate. Every megarepo consumer reaches this file through such a symlink.
 */
const entryPath = process.argv[1]
if (entryPath !== undefined) {
  const invokedDirectly =
    import.meta.url === pathToFileURL(entryPath).href ||
    import.meta.url === pathToFileURL(realpathSync(entryPath)).href
  if (invokedDirectly === true) process.exitCode = await runStoryGateCli(process.argv.slice(2))
}
