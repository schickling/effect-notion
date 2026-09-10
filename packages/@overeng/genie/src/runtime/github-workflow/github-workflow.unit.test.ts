import { describe, expect, it } from 'vitest'

import {
  githubWorkflow,
  githubWorkflowEvent,
  type GenieContext,
  type GitHubWorkflowArgs,
} from '../mod.ts'
import { runActionlint } from './actionlint.ts'

// Inject the actionlint capability the engine normally provides, so the actionlint integration cases below
// actually exercise the spawn runner (rather than no-op'ing through the `ctx.actionlint === undefined` guard).
const mockGenieContext: GenieContext = {
  location: '.github/workflows/ci.yml',
  cwd: '/workspace',
  actionlint: runActionlint,
}

/** Helper that only checks the built-in TS validators (actionlint disabled) */
const getValidationIssues = (runsOn: unknown) =>
  githubWorkflow({
    actionlint: false,
    name: 'CI',
    on: {
      pull_request: { branches: ['main'] },
    },
    jobs: {
      test: {
        'runs-on': runsOn as any,
        steps: [{ run: 'echo ok' }],
      },
    },
  }).validate?.(mockGenieContext) ?? []

/** Helper that only checks the built-in TS validators (actionlint disabled) */
const getWorkflowValidationIssues = (args: GitHubWorkflowArgs) =>
  githubWorkflow({ actionlint: false, ...args }).validate?.(mockGenieContext) ?? []

/** Helper that includes actionlint validation */
const getFullValidationIssues = (args: GitHubWorkflowArgs) =>
  githubWorkflow(args).validate?.(mockGenieContext) ?? []

const hasActionlint = (() => {
  try {
    const bin = process.env.GENIE_ACTIONLINT_BIN
    return bin !== undefined && bin !== ''
  } catch {
    return false
  }
})()

describe('githubWorkflow', () => {
  it('accepts valid string runner labels', () => {
    expect(getValidationIssues(['ubuntu-latest', 'nix'])).toEqual([])
  })

  it('rejects empty runs-on arrays', () => {
    expect(getValidationIssues([])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on',
      message: 'jobs.test.runs-on must include at least one runner label.',
      rule: 'github-workflow-runs-on-empty',
    })
  })

  it('rejects non-string runner labels', () => {
    expect(getValidationIssues([null])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message: 'jobs.test.runs-on must serialize to string labels, got null.',
      rule: 'github-workflow-runs-on-non-string',
    })
  })

  it('rejects empty runner labels', () => {
    expect(getValidationIssues(['  '])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message: 'jobs.test.runs-on labels must not be empty.',
      rule: 'github-workflow-runs-on-empty-label',
    })
  })

  it('rejects placeholder runner labels', () => {
    expect(getValidationIssues(['namespace-features:github.run-id=undefined'])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message:
        'jobs.test.runs-on contains a stale placeholder label (namespace-features:github.run-id=undefined). This usually means a CI helper API drifted and serialized undefined/null into the workflow.',
      rule: 'github-workflow-runs-on-placeholder',
    })
  })

  it('rejects static matrix expansion above GitHub Actions documented matrix job limit', () => {
    expect(
      getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          test: {
            'runs-on': 'ubuntu-latest',
            strategy: {
              matrix: {
                shard: Array.from({ length: 257 }, (_, index) => index),
              },
            },
            steps: [{ run: 'echo ok' }],
          },
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        packageName: '.github/workflows/ci.yml',
        dependency: 'jobs.test.strategy.matrix',
        rule: 'github-workflow-matrix-job-limit',
      }),
    )
  })

  it('rejects static check-run expansion above GitHub Actions documented check-suite limit', () => {
    expect(
      getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          test: {
            'runs-on': 'ubuntu-latest',
            strategy: {
              matrix: {
                include: Array.from({ length: 50_001 }, (_, index) => ({ shard: index })),
              },
            },
            steps: [{ run: 'echo ok' }],
          },
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        packageName: '.github/workflows/ci.yml',
        dependency: 'jobs',
        rule: 'github-workflow-check-runs-per-suite-limit',
      }),
    )
  })

  it('warns when explicit job timeout exceeds documented runner execution limits', () => {
    expect(
      getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          hosted: {
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 361,
            steps: [{ run: 'echo ok' }],
          },
          selfHosted: {
            'runs-on': 'namespace-profile-linux-x86-64',
            'timeout-minutes': 7_201,
            steps: [{ run: 'echo ok' }],
          },
        },
      }).filter((issue) => issue.rule === 'github-workflow-job-timeout-limit'),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        dependency: 'jobs.hosted.timeout-minutes',
      }),
      expect.objectContaining({
        severity: 'warning',
        dependency: 'jobs.selfHosted.timeout-minutes',
      }),
    ])
  })

  it('does not warn for explicit timeouts within documented runner execution limits', () => {
    expect(
      getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          hosted: {
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 360,
            steps: [{ run: 'echo ok' }],
          },
          selfHosted: {
            'runs-on': 'namespace-profile-linux-x86-64',
            'timeout-minutes': 7_200,
            steps: [{ run: 'echo ok' }],
          },
        },
      }).filter((issue) => issue.rule === 'github-workflow-job-timeout-limit'),
    ).toEqual([])
  })

  it('rejects generated workflow YAML above the observed GitHub Actions admission size limit', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        large: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: `echo ${'x'.repeat(500_000)}` }],
        },
      },
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        packageName: '.github/workflows/ci.yml',
        dependency: 'workflow',
        rule: 'github-workflow-admission-size-limit',
      }),
    )
  })

  it('warns when generated workflow YAML is close to the observed admission size limit', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        large: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: `echo ${'x'.repeat(460_000)}` }],
        },
      },
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        packageName: '.github/workflows/ci.yml',
        dependency: 'workflow',
        rule: 'github-workflow-admission-size-margin',
      }),
    )
    expect(issues.filter((issue) => issue.rule === 'github-workflow-admission-size-limit')).toEqual(
      [],
    )
  })

  it('rejects prepared CI runtime script use without the preparation step', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        test: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v6' },
            {
              run: [
                "__genie_ci_retry_script='${{ github.workspace }}/.genie-ci-runtime/run-with-nix-gc-race-retry.sh'",
                'bash "$__genie_ci_retry_script" test true',
              ].join('\n'),
            },
          ],
        },
      },
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        packageName: '.github/workflows/ci.yml',
        dependency: 'jobs.test.steps[1]',
        rule: 'github-workflow-prepared-ci-runtime-script-setup',
      }),
    )
  })

  it('accepts prepared CI runtime script use after the preparation step', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        test: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v6' },
            {
              name: 'Prepare CI helper scripts',
              run: 'echo prepared',
            },
            {
              run: [
                "__genie_ci_retry_script='${{ github.workspace }}/.genie-ci-runtime/run-with-nix-gc-race-retry.sh'",
                'bash "$__genie_ci_retry_script" test true',
              ].join('\n'),
            },
          ],
        },
      },
    })

    expect(
      issues.filter((issue) => issue.rule === 'github-workflow-prepared-ci-runtime-script-setup'),
    ).toEqual([])
  })

  it('rejects every prepared CI runtime helper after a measurement-baseline checkout', () => {
    for (const helperPath of [
      'run-with-nix-gc-race-retry.sh',
      'resolve-devenv.sh',
      'prepare-job-local-rust-state.sh',
    ]) {
      const issues = getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          test: {
            'runs-on': 'ubuntu-latest',
            steps: [
              { uses: 'actions/checkout@v6' },
              {
                name: 'Prepare CI helper scripts',
                run: 'echo prepared',
              },
              {
                name: 'Checkout CI measurement baseline ref',
                uses: 'actions/checkout@v6',
              },
              {
                run: ". '${{ github.workspace }}/.genie-ci-runtime/" + helperPath + "'",
              },
            ],
          },
        },
      })

      expect(issues).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          packageName: '.github/workflows/ci.yml',
          dependency: 'jobs.test.steps[3]',
          rule: 'github-workflow-prepared-ci-runtime-script-setup',
        }),
      )
    }
  })

  it('rejects prepared CI runtime helper use when Nix installation follows preparation', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        test: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v6' },
            { name: 'Prepare CI helper scripts', run: 'echo prepared' },
            { uses: 'DeterminateSystems/determinate-nix-action@v3' },
            { run: ". '${{ github.workspace }}/.genie-ci-runtime/resolve-devenv.sh'" },
          ],
        },
      },
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        dependency: 'jobs.test.steps[3]',
        rule: 'github-workflow-prepared-ci-runtime-script-setup',
      }),
    )
  })

  it('rejects every prepared CI retry script use after a destructive checkout', () => {
    const retryStep = {
      run: "bash '${{ github.workspace }}/.genie-ci-runtime/run-with-nix-gc-race-retry.sh' test true",
    }
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        test: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v6' },
            { name: 'Prepare CI helper scripts', run: 'echo prepared' },
            retryStep,
            { uses: 'actions/checkout@v6' },
            retryStep,
          ],
        },
      },
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        dependency: 'jobs.test.steps[4]',
        rule: 'github-workflow-prepared-ci-runtime-script-setup',
      }),
    )
  })

  it('accepts prepared CI retry script use after non-destructive checkouts', () => {
    for (const checkout of [
      { uses: 'actions/checkout@v6', with: { path: 'vendor/tool' } },
      { uses: 'actions/checkout@v6', with: { clean: false } },
    ]) {
      const issues = getWorkflowValidationIssues({
        name: 'CI',
        on: { pull_request: githubWorkflowEvent.all },
        jobs: {
          test: {
            'runs-on': 'ubuntu-latest',
            steps: [
              { uses: 'actions/checkout@v6' },
              { name: 'Prepare CI helper scripts', run: 'echo prepared' },
              checkout,
              {
                run: "bash '${{ github.workspace }}/.genie-ci-runtime/run-with-nix-gc-race-retry.sh' test true",
              },
            ],
          },
        },
      })

      expect(
        issues.filter((issue) => issue.rule === 'github-workflow-prepared-ci-runtime-script-setup'),
      ).toEqual([])
    }
  })
})

describe('determinate-nix-action extra-conf validation', () => {
  it('no warning when determinate-nix-action has experimental-features in extra-conf', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              uses: 'DeterminateSystems/determinate-nix-action@v3',
              with: { 'extra-conf': 'experimental-features = nix-command flakes' },
            },
            { run: 'nix build' },
          ],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-determinate-nix-extra-conf')).toEqual(
      [],
    )
  })

  it('warns when determinate-nix-action is missing experimental-features in extra-conf', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              uses: 'DeterminateSystems/determinate-nix-action@v3',
              with: { 'extra-conf': 'some-other-setting = true' },
            },
            { run: 'nix build' },
          ],
        },
      },
    })

    expect(issues).toContainEqual({
      severity: 'warning',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.build.steps[0]',
      message: expect.stringContaining(
        'uses DeterminateSystems/determinate-nix-action without "experimental-features" in extra-conf',
      ),
      rule: 'github-workflow-determinate-nix-extra-conf',
    })
  })

  it('no warning when workflow does not use determinate-nix-action', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm test' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-determinate-nix-extra-conf')).toEqual(
      [],
    )
  })
})

describe('GitHub expression validation', () => {
  it('rejects nested GitHub expressions inside a single expression string', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Save pnpm state',
              uses: 'actions/cache/save@v4',
              with: {
                key: "${{ steps.restore.outputs.cache-primary-key || 'pnpm-state-v1-${{ runner.os }}' }}",
                path: '/tmp/pnpm-state',
              },
            },
          ],
        },
      },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.build.steps[0].with.key',
      message: expect.stringContaining('contains a nested GitHub Actions expression'),
      rule: 'github-workflow-expression-nesting',
    })
  })

  it('allows plain strings that concatenate multiple top-level GitHub expressions', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Restore pnpm state',
              uses: 'actions/cache/restore@v4',
              with: {
                key: "pnpm-state-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/pnpm-lock.yaml') }}",
                path: '/tmp/pnpm-state',
              },
            },
          ],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-expression-nesting')).toEqual([])
  })

  it('emits pure expressions unquoted in block context', () => {
    const workflow = githubWorkflow({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      concurrency: {
        group: '${{ github.workflow }}-${{ github.ref }}',
        'cancel-in-progress': "${{ github.event_name != 'pull_request' }}",
      },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          if: "${{ github.event_name != 'schedule' }}",
          'continue-on-error': '${{ matrix.experimental }}',
          steps: [{ run: 'echo ok' }],
          strategy: {
            'fail-fast': '${{ !contains(github.ref, "main") }}',
            'max-parallel': '${{ github.event_name == "push" && 2 || 4 }}',
          },
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)

    expect(yaml).toContain("cancel-in-progress: ${{ github.event_name != 'pull_request' }}")
    expect(yaml).toContain("if: ${{ github.event_name != 'schedule' }}")
    expect(yaml).toContain('continue-on-error: ${{ matrix.experimental }}')
    expect(yaml).toContain('fail-fast: ${{ !contains(github.ref, "main") }}')
    expect(yaml).toContain('max-parallel: ${{ github.event_name == "push" && 2 || 4 }}')
    // Embedded expressions (multiple ${{ in one string) stay quoted
    expect(yaml).toContain("group: '${{ github.workflow }}-${{ github.ref }}'")
  })

  it('keeps expressions quoted in inline arrays', () => {
    const workflow = githubWorkflow({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': ['${{ matrix.runner }}', 'nix'],
          steps: [{ run: 'echo ok' }],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)
    expect(yaml).toContain("runs-on: ['${{ matrix.runner }}', nix]")
  })

  it('stringifies valid cache keys with multiple top-level expressions unchanged', () => {
    const workflow = githubWorkflow({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Restore pnpm state',
              uses: 'actions/cache/restore@v4',
              with: {
                key: "pnpm-state-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/pnpm-lock.yaml') }}",
                path: '${{ runner.temp }}/pnpm-store/${{ github.job }}',
              },
            },
          ],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)

    expect(yaml).toContain(
      `key: "pnpm-state-v1-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('**/pnpm-lock.yaml') }}"`,
    )
    expect(yaml).toContain(`path: '\${{ runner.temp }}/pnpm-store/\${{ github.job }}'`)
  })
})

describe.runIf(hasActionlint)('actionlint integration', () => {
  it('passes a clean workflow', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule.startsWith('actionlint-'))).toEqual([])
  })

  it('catches script injection via untrusted input in run step', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo ${{ github.event.pull_request.title }}' }],
        },
      },
    })

    const actionlintErrors = issues.filter(
      (i) => i.rule.startsWith('actionlint-') && i.severity === 'error',
    )
    expect(actionlintErrors.length).toBeGreaterThan(0)
    expect(actionlintErrors[0]!.message).toContain('untrusted')
  })

  it('accepts custom self-hosted runner labels via config', () => {
    const issues = getFullValidationIssues({
      actionlint: { selfHostedRunnerLabels: ['my-custom-runner', 'nix'] },
      name: 'CI',
      on: { push: githubWorkflowEvent.all },
      jobs: {
        build: {
          'runs-on': ['my-custom-runner', 'nix'],
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'actionlint-runner-label')).toEqual([])
  })

  it('reports unknown runner labels without config', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { push: githubWorkflowEvent.all },
      jobs: {
        build: {
          'runs-on': ['my-unknown-runner'],
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'actionlint-runner-label').length).toBeGreaterThan(0)
  })

  it('can be disabled with actionlint: false', () => {
    const issues = getFullValidationIssues({
      actionlint: false,
      name: 'CI',
      on: { pull_request: githubWorkflowEvent.all },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo ${{ github.event.pull_request.title }}' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule.startsWith('actionlint-'))).toEqual([])
  })

  it('strips actionlint config from generated YAML', () => {
    const workflow = githubWorkflow({
      actionlint: { selfHostedRunnerLabels: ['my-runner'] },
      name: 'CI',
      on: { push: githubWorkflowEvent.all },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)
    expect(yaml).not.toContain('actionlint')
    expect(yaml).not.toContain('selfHostedRunnerLabels')
  })
})

describe('reusable workflow call jobs', () => {
  it('accepts a job that delegates via `uses:` without `runs-on`/`steps`', () => {
    const workflow = githubWorkflow({
      actionlint: false,
      name: 'caller',
      on: { workflow_dispatch: null },
      jobs: {
        validate: {
          uses: './.github/workflows/reusable.yml',
          with: { 'target-scope': 'stable' },
        },
        downstream: {
          'runs-on': 'ubuntu-latest',
          needs: 'validate',
          steps: [{ run: 'echo "${{ needs.validate.outputs.release-version }}"' }],
        },
      },
    })

    const issues = workflow.validate?.(mockGenieContext) ?? []
    expect(issues.filter((i) => i.rule.startsWith('github-workflow-runs-on'))).toEqual([])

    const yaml = workflow.stringify(mockGenieContext)
    expect(yaml).toContain('uses: ./.github/workflows/reusable.yml')
    expect(yaml).toContain('target-scope: stable')
  })

  it('accepts a reusable workflow definition with workflow_call inputs/outputs', () => {
    const workflow = githubWorkflow({
      actionlint: false,
      name: 'reusable',
      on: {
        workflow_call: {
          inputs: {
            'target-scope': { type: 'string', required: true },
          },
          outputs: {
            'release-version': {
              value: '${{ jobs.derive.outputs.release-version }}',
            },
          },
        },
      },
      jobs: {
        derive: {
          'runs-on': 'ubuntu-latest',
          outputs: {
            'release-version': '${{ steps.read.outputs.version }}',
          },
          steps: [
            {
              id: 'read',
              run: 'echo "version=1.2.3" >> "$GITHUB_OUTPUT"',
            },
          ],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)
    expect(yaml).toContain('workflow_call:')
    expect(yaml).toContain('release-version:')
  })
})
