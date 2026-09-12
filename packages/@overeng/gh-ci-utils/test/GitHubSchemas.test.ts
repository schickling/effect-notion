import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import * as GH from '../src/isomorphic/GitHubSchemas.ts'

describe('GitHubSchemas', () => {
  describe('WorkflowRun', () => {
    it('decodes a minimal valid run', () => {
      const input = {
        id: 123,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        head_branch: 'main',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        workflow_id: 1,
        run_number: 42,
        run_attempt: 1,
        event: 'push',
        created_at: '2026-03-26T12:00:00Z',
        updated_at: '2026-03-26T12:05:00Z',
        run_started_at: '2026-03-26T12:00:01Z',
        html_url: 'https://github.com/owner/repo/actions/runs/123',
        jobs_url: 'https://api.github.com/repos/owner/repo/actions/runs/123/jobs',
      }

      const result = Schema.decodeUnknownSync(GH.WorkflowRun)(input)
      expect(result.id).toBe(123)
      expect(result.status).toBe('completed')
      expect(result.created_at).toBeInstanceOf(Date)
      expect(result.conclusion).toBe('success')
    })

    it('handles null fields', () => {
      const input = {
        id: 1,
        name: null,
        path: '.github/workflows/ci.yml',
        head_branch: null,
        head_sha: 'abc',
        status: 'queued',
        conclusion: null,
        workflow_id: 1,
        run_number: 1,
        run_attempt: 1,
        event: 'push',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        run_started_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/o/r/actions/runs/1',
        jobs_url: 'https://api.github.com/repos/o/r/actions/runs/1/jobs',
      }

      const result = Schema.decodeUnknownSync(GH.WorkflowRun)(input)
      expect(result.name).toBeNull()
      expect(result.head_branch).toBeNull()
      expect(result.conclusion).toBeNull()
    })
  })

  describe('WorkflowJob', () => {
    it('decodes a job with steps', () => {
      const input = {
        id: 456,
        run_id: 123,
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-03-26T12:00:00Z',
        completed_at: '2026-03-26T12:05:00Z',
        runner_name: 'linux-builder-a',
        labels: ['self-hosted'],
        steps: [
          {
            name: 'Checkout',
            status: 'completed',
            conclusion: 'success',
            number: 1,
            started_at: '2026-03-26T12:00:00Z',
            completed_at: '2026-03-26T12:00:01Z',
          },
        ],
      }

      const result = Schema.decodeUnknownSync(GH.WorkflowJob)(input)
      expect(result.name).toBe('lint')
      expect(result.conclusion).toBe('failure')
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]!.name).toBe('Checkout')
    })

    it('defaults steps to empty array when missing', () => {
      const input = {
        id: 456,
        run_id: 123,
        name: 'test',
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
        runner_name: null,
        labels: [],
      }

      const result = Schema.decodeUnknownSync(GH.WorkflowJob)(input)
      expect(result.steps).toEqual([])
    })

    it.each(['stale', 'startup_failure'] as const)(
      'decodes the documented %s conclusion for jobs and steps',
      (conclusion) => {
        const result = Schema.decodeUnknownSync(GH.WorkflowJob)({
          id: 456,
          run_id: 123,
          name: 'synthetic-conclusion',
          status: 'completed',
          conclusion,
          started_at: null,
          completed_at: null,
          runner_name: null,
          labels: [],
          steps: [
            {
              name: 'Synthetic step',
              status: 'completed',
              conclusion,
              number: 1,
              started_at: null,
              completed_at: null,
            },
          ],
        })

        expect(result.conclusion).toBe(conclusion)
        expect(result.steps[0]?.conclusion).toBe(conclusion)
      },
    )
  })

  describe('CheckAnnotation', () => {
    it('decodes an annotation', () => {
      const input = {
        path: 'src/mod.ts',
        start_line: 10,
        end_line: 10,
        annotation_level: 'failure',
        message: 'Type error',
        title: 'TS2345',
        raw_details: null,
      }

      const result = Schema.decodeUnknownSync(GH.CheckAnnotation)(input)
      expect(result.annotation_level).toBe('failure')
      expect(result.message).toBe('Type error')
    })
  })
})
