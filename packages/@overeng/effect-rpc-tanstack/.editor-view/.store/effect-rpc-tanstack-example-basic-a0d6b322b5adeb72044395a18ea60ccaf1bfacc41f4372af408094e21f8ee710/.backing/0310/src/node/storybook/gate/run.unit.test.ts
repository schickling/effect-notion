import { describe, expect, it } from 'vitest'

import {
  assertionStoryKey,
  baselineCacheKey,
  classifyStability,
  isStoryGateOk,
  selfInconsistentStoryKeys,
  slugStoryName,
  storyKey,
} from './run.ts'

const clean = {
  added: [],
  removed: [],
  changed: [],
  uncovered: [],
  unsettled: [],
  baseline: { total: 39, passed: 28, failed: 11 },
  // A live harness: the browser emitted a settled marker per story. Every other
  // field here is a list, so this is the only one that says the run happened.
  settle: {
    settledStories: 39,
    unsettledStories: 0,
    boundMs: 2000,
    minMs: 30,
    medianMs: 45,
    maxMs: 120,
    totalMs: 1800,
  },
  themeAxis: { projects: ['story-gate-light', 'story-gate-dark'], comparable: 39, differing: 38 },
} as const

describe('isStoryGateOk', () => {
  it('passes a clean comparison over a partly-failing baseline', () => {
    // 11 of 39 already failing is debt, not breakage: there is still a majority
    // of working stories for a regression to show up against.
    expect(isStoryGateOk(clean)).toBe(true)
  })

  it('refuses to pass when nothing passed at the baseline', () => {
    // The defect this guards: with every story failing at the baseline they all
    // land in `preExisting`, the regression list is empty by construction, and
    // the gate reported success over a total loss of styling. Measured at
    // 212/212 failed on one app and 708/942 on another.
    expect(isStoryGateOk({ ...clean, baseline: { total: 212, passed: 0, failed: 212 } })).toBe(
      false,
    )
  })

  it('refuses to pass when nothing settled, even with every other term clean', () => {
    // The pass-as-absence defect: if the gate annotations stop firing while
    // ordinary Storybook assertions still pass, no story is captured, so
    // added/removed/changed/uncovered/unsettled are ALL empty and
    // `baseline.passed` stays positive. Every other term in the verdict is
    // satisfied by a run that compared nothing, and the CLI prints "NOTHING
    // SETTLED — every number below is meaningless" while exiting 0.
    //
    // `settledStories` is emitted per story by the browser, so a harness that
    // never launched cannot fake it. Note `baseline.passed` is deliberately
    // left positive here: that is exactly why it does not cover this case.
    expect(isStoryGateOk({ ...clean, settle: { ...clean.settle, settledStories: 0 } })).toBe(false)
  })

  it('refuses to pass when a story has no baseline image', () => {
    // An uncovered story was never compared, so an empty regression list says
    // nothing about it. It is never debt.
    expect(isStoryGateOk({ ...clean, uncovered: ['src/stories/Button.stories.tsx/x.png'] })).toBe(
      false,
    )
  })

  it('refuses to pass when a story never reached a quiet DOM', () => {
    // A story that never settled was excluded from the comparison by
    // OBSERVATION, so passing would report green over a story nobody compared —
    // the same shape as `uncovered`. The remedy is visible: fix the story, or
    // declare it unstable and put the decision on the record.
    expect(
      isStoryGateOk({
        ...clean,
        unsettled: [
          {
            id: 'components-select--with-error',
            name: 'Select > With Error',
            elapsedMs: 20_031,
            shapes: ['41:2180', '43:2320'],
            reason: 'shape-never-quiet',
          },
        ],
      }),
    ).toBe(false)
  })

  it('fails on added, removed and changed stories', () => {
    expect({
      added: isStoryGateOk({ ...clean, added: ['New'] }),
      removed: isStoryGateOk({ ...clean, removed: ['Gone'] }),
      changed: isStoryGateOk({
        ...clean,
        changed: [{ story: 'Default', kind: 'pixels', detail: '85 pixels (ratio 0.01) differ.' }],
      }),
    }).toEqual({ added: false, removed: false, changed: false })
  })

  it('refuses to pass when both theme projects rendered the same thing', () => {
    // The defect this guards: the theme toolbar global never reached the
    // element the overrides were keyed on, so both projects captured the light
    // palette and the gate reported green double-coverage over an axis that did
    // not vary. Two projects, 39 comparable stories, zero differing.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, differing: 0 },
      }),
    ).toBe(false)
  })

  it('accepts a target that declares a single colour scheme', () => {
    // Measured counterexample: a site pinning one scheme has 0 of 57 probes
    // differing, correctly. Failing it would punish a correct target for a
    // property of the target, and the guard would get switched off.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, comparable: 57, differing: 0 },
        themeVaries: false,
      }),
    ).toBe(true)
  })

  it('does not demand variation from a single-project run', () => {
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { projects: ['story-gate'], comparable: 39, differing: 0 },
      }),
    ).toBe(true)
  })

  it('does not report a healthy axis from stories that differ from themselves', () => {
    // `comparable` is the post-exclusion count. A suite where every story is
    // nondeterministic excludes everything, and zero comparable stories is not
    // evidence of a working axis — but it is also not evidence of a broken one,
    // so the verdict defers rather than inventing a failure the counts cannot
    // support. The empty set is visible in `selfInconsistent`.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, comparable: 0, differing: 0 },
      }),
    ).toBe(true)
  })
})

describe('selfInconsistentStoryKeys', () => {
  it('keys a capture by its story file and story slug', () => {
    // The two sides of this join speak different namespaces: a capture key ends
    // in the story ID, a Vitest assertion carries the bare story NAME. Measured
    // shapes, from a real run:
    //   capture   story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png
    //   assertion fullName 'With Hint'
    expect(
      selfInconsistentStoryKeys([
        'story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png',
      ]).has(storyKey({ file: 'NumberField.stories.tsx', slug: slugStoryName('With Hint') })),
    ).toBe(true)
  })

  it('does not let one file\u2019s nondeterminism suppress another file\u2019s regression', () => {
    // The defect a name-only key would introduce, and it is a FALSE GREEN
    // rather than noise: `Default` exists in many story files, so keying on the
    // name alone would let a nondeterministic `Default` in one file silently
    // absorb a real change to `Default` in every other file.
    const keys = selfInconsistentStoryKeys([
      'story-gate/src/stories/Book.stories.tsx/components-book--default.png',
    ])
    expect({
      sameFile: keys.has(storyKey({ file: 'Book.stories.tsx', slug: slugStoryName('Default') })),
      otherFile: keys.has(storyKey({ file: 'Avatar.stories.tsx', slug: slugStoryName('Default') })),
    }).toEqual({ sameFile: true, otherFile: false })
  })

  it('slugs a story name the way Storybook derives the id suffix', () => {
    expect({
      spaces: slugStoryName('With Error'),
      punctuation: slugStoryName('Optional & Disabled'),
      collapsed: slugStoryName('All   Sizes'),
    }).toEqual({ spaces: 'with-error', punctuation: 'optional-disabled', collapsed: 'all-sizes' })
  })
})

describe('classifyStability', () => {
  it('separates a capture the pair check catches from one only a third capture sees', () => {
    // The measured false negative this exists for: `Avatar > All Sizes` passed
    // the two-capture probe and then differed on a third capture of the
    // IDENTICAL tree. Collapsed into one self-inconsistent count that story is
    // indistinguishable from one the pair caught, and the two have different
    // causes — the pair catches a DOM that was still moving, the third catches
    // a render that was quiet and still did not reproduce.
    const outcome = classifyStability({
      captures: [
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'a'],
          ['light/third-only.png', 'a'],
        ]),
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'MOVED'],
          ['light/third-only.png', 'a'],
        ]),
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'MOVED'],
          ['light/third-only.png', 'MOVED'],
        ]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnSecond: outcome.differedOnSecond,
      differedOnThird: outcome.differedOnThird,
      thirdCaptureMs: outcome.thirdCaptureMs,
    }).toEqual({
      reproduced: 1,
      differedOnSecond: ['light/pair-catches.png'],
      differedOnThird: ['light/third-only.png'],
      thirdCaptureMs: 1200,
    })
  })

  it('reports the third-capture class as unmeasured rather than zero when two captures were taken', () => {
    // `differedOnThird: []` from a two-capture run and from a three-capture run
    // are the same value meaning opposite things: "nothing looked there" versus
    // "something looked and found nothing". `thirdCaptureMs` is the only thing
    // separating them, so a reader trusting the empty list on its own repeats
    // the original false negative with more confidence than before.
    const outcome = classifyStability({
      captures: [new Map([['light/a.png', 'a']]), new Map([['light/a.png', 'a']])],
      captureMs: [1000, 1100],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnThird: outcome.differedOnThird,
      thirdCaptureMs: outcome.thirdCaptureMs,
    }).toEqual({ reproduced: 1, differedOnThird: [], thirdCaptureMs: undefined })
  })

  it('names a capture missing from some of the set as non-reproducible', () => {
    // This test previously asserted the OPPOSITE — that such a key is left
    // unclassified — on the grounds that `added`/`removed`/`uncovered` already
    // carry it. That reasoning holds only for the KEPT capture: those three
    // compare the retained baseline directory against the compare run, and the
    // intermediate probes are deleted before that comparison ever happens.
    //
    // So a story that captured in probe 1 but not in probes 2 and 3 was watched
    // failing to reproduce ON THE SAME TREE and then reported by nothing. It is
    // an instability, not a coverage gap, and it is the one kind no comparison
    // of hashes can express because the disagreement is about the capture
    // existing at all.
    const outcome = classifyStability({
      captures: [
        new Map([
          ['light/present.png', 'a'],
          ['light/vanishes.png', 'a'],
        ]),
        new Map([['light/present.png', 'a']]),
        new Map([['light/present.png', 'a']]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnSecond: outcome.differedOnSecond,
      differedOnThird: outcome.differedOnThird,
      inconsistentPresence: outcome.inconsistentPresence,
    }).toEqual({
      reproduced: 1,
      // Kept empty on purpose: a presence disagreement must not be reported as
      // a byte disagreement, or whoever reads it goes looking for a race in the
      // render when the capture never happened.
      differedOnSecond: [],
      differedOnThird: [],
      inconsistentPresence: ['light/vanishes.png'],
    })
  })

  it('sees a capture that appears only after the first probe', () => {
    // The same blind spot in the other direction: iteration used to be over
    // capture 1's keys, so a story that rendered nothing on the first capture
    // and then appeared on the second and third was never even examined.
    const outcome = classifyStability({
      captures: [
        new Map([['light/present.png', 'a']]),
        new Map([
          ['light/present.png', 'a'],
          ['light/appears-late.png', 'a'],
        ]),
        new Map([
          ['light/present.png', 'a'],
          ['light/appears-late.png', 'a'],
        ]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      inconsistentPresence: outcome.inconsistentPresence,
    }).toEqual({ reproduced: 1, inconsistentPresence: ['light/appears-late.png'] })
  })
})

describe('assertionStoryKey', () => {
  it('does not let one file\u2019s baseline debt subtract another file\u2019s regression', () => {
    // The false green this removes. `preExisting` was built from the bare
    // `fullName`, so a baseline failure called `Default` in Book.stories.tsx
    // matched a NEWLY failing `Default` in Avatar.stories.tsx and the real
    // regression was skipped as somebody else's debt.
    const baselineDebt = new Set(
      [{ file: 'Book.stories.tsx', fullName: 'Default', status: 'failed' }].map(assertionStoryKey),
    )
    expect({
      sameFile: baselineDebt.has(
        assertionStoryKey({ file: 'Book.stories.tsx', fullName: 'Default' }),
      ),
      otherFile: baselineDebt.has(
        assertionStoryKey({ file: 'Avatar.stories.tsx', fullName: 'Default' }),
      ),
    }).toEqual({ sameFile: true, otherFile: false })
  })

  it('joins against a capture key for the same story', () => {
    // Both sides of the subtraction must land on one identity: the capture key
    // ends in the story ID, the assertion carries the bare story NAME.
    const captures = selfInconsistentStoryKeys([
      'story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png',
    ])
    expect(
      captures.has(assertionStoryKey({ file: 'NumberField.stories.tsx', fullName: 'With Hint' })),
    ).toBe(true)
  })
})

describe('baselineCacheKey', () => {
  const base = {
    baselineSha: 'abc123',
    packagePath: 'packages/@overeng/effect-schema-form-aria',
    configFile: 'vitest.gate.config.ts',
    sourceRoots: ['src', 'stories', '.storybook'],
    baselineCaptures: 3,
  }

  it('gives two packages at the same commit different baselines', () => {
    // The defect: the cache root is shared by the whole repository and the entry
    // was keyed by commit alone, so the first package to write `<sha>/.complete`
    // handed its own screenshots, settle records and theme matrix to every other
    // package's gate at that ref. The completeness check cannot see it — the
    // entry IS complete, it is just a baseline of something else.
    expect(baselineCacheKey(base)).not.toBe(
      baselineCacheKey({ ...base, packagePath: 'packages/@overeng/tui-react' }),
    )
  })

  it('separates entries that captured different things at the same commit', () => {
    expect({
      config: baselineCacheKey({ ...base, configFile: 'vitest.other.config.ts' }),
      roots: baselineCacheKey({ ...base, sourceRoots: ['src'] }),
      captures: baselineCacheKey({ ...base, baselineCaptures: 2 }),
    }).toEqual({
      config: expect.not.stringMatching(baselineCacheKey(base)),
      roots: expect.not.stringMatching(baselineCacheKey(base)),
      captures: expect.not.stringMatching(baselineCacheKey(base)),
    })
  })

  it('keeps the commit readable and ignores sourceRoots order', () => {
    // The sha stays a prefix so a cache directory is still greppable by ref, and
    // argument ORDER must not invalidate an otherwise identical entry.
    expect({
      prefixed: baselineCacheKey(base).startsWith('abc123-'),
      orderStable:
        baselineCacheKey(base) ===
        baselineCacheKey({ ...base, sourceRoots: ['.storybook', 'stories', 'src'] }),
    }).toEqual({ prefixed: true, orderStable: true })
  })
})
