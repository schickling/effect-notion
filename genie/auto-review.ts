/** Shared auto-review workflow: requests review from a human when an assistant opens a PR */

import { githubWorkflow } from '../packages/@overeng/genie/src/runtime/mod.ts'
import { defaultActionlintConfig, linuxX64Runner } from './ci-workflow.ts'

/** Generate the shared auto-review workflow used by assistant-authored PRs. */
export const autoReviewWorkflow = ({
  author = 'schickling-assistant',
  reviewer = 'schickling',
  runner = linuxX64Runner,
  timeoutMinutes = 30,
} = {}) =>
  githubWorkflow({
    actionlint: defaultActionlintConfig,
    name: 'Auto-request review',
    on: {
      pull_request: {
        types: ['opened', 'ready_for_review'],
      },
    },
    permissions: {
      'pull-requests': 'write',
    },
    jobs: {
      'request-review': {
        'runs-on': runner,
        'timeout-minutes': timeoutMinutes,
        steps: [
          {
            name: `Request review from ${reviewer}`,
            if: `github.event.pull_request.user.login == '${author}' && github.event.pull_request.draft == false`,
            env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
            run: [
              `curl --fail-with-body --silent --show-error --request POST \\`,
              `  --url "https://api.github.com/repos/\${{ github.repository }}/pulls/\${{ github.event.pull_request.number }}/requested_reviewers" \\`,
              `  --header "Accept: application/vnd.github+json" \\`,
              `  --header "Content-Type: application/json" \\`,
              `  --header "Authorization: Bearer \${GH_TOKEN}" \\`,
              `  --header "X-GitHub-Api-Version: 2022-11-28" \\`,
              `  --data '{"reviewers":["${reviewer}"]}'`,
            ].join('\n'),
          },
        ],
      },
    },
  })
