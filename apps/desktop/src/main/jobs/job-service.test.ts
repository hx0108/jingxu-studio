import { ScriptJobSubmissionError } from '@jingxu/application';
import type { JobRepositoryPort, JobRunner } from '@jingxu/application';
import { describe, expect, it, vi } from 'vitest';

import { JobService, type JobSubmissionPort } from './job-service';

const jobs = {
  findById: vi.fn(() => Promise.resolve(null)),
  findByIdempotencyKey: vi.fn(() => Promise.resolve(null)),
} as unknown as JobRepositoryPort;

const runner = {
  cancel: vi.fn(() => Promise.resolve({ status: 'NOT_CANCELLED' as const })),
  run: vi.fn(() => Promise.resolve({ status: 'NOT_CLAIMED' as const })),
} satisfies JobRunner;

const createInput = {
  episodeId: null,
  expectedInputVersionId: 'source_12345678',
  idempotencyKey: 'idempotency_12345678',
  operationType: 'GENERATE' as const,
  projectId: 'project_12345678',
  requestId: 'request_12345678',
  stage: 'CONCEPT' as const,
};

describe('JobService script submission errors', () => {
  it('前置条件错误保留稳定业务码，而不是压扁为 unavailable', async () => {
    const submission: JobSubmissionPort = {
      requeue: vi.fn(() => Promise.reject(new Error('unused'))),
      submit: vi.fn(() =>
        Promise.reject(new ScriptJobSubmissionError('SCRIPT_STAGE_PREREQUISITE_MISSING')),
      ),
    };
    const service = new JobService({ jobs, runner, submission });

    const result = await service.create(createInput, 'trace_12345678');

    expect(result).toMatchObject({
      error: { code: 'SCRIPT_STAGE_PREREQUISITE_MISSING' },
      ok: false,
    });
  });

  it('未知装配错误仍安全归一化为 unavailable', async () => {
    const submission: JobSubmissionPort = {
      requeue: vi.fn(() => Promise.reject(new Error('unused'))),
      submit: vi.fn(() => Promise.reject(new Error('secret infrastructure detail'))),
    };
    const service = new JobService({ jobs, runner, submission });

    const result = await service.create(createInput, 'trace_12345678');

    expect(result).toMatchObject({ error: { code: 'JOB_SUBMISSION_UNAVAILABLE' }, ok: false });
    expect(JSON.stringify(result)).not.toContain('secret infrastructure detail');
  });
});
