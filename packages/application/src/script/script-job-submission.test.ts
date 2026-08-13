import { describe, expect, it, vi } from 'vitest';

import type { ScriptJobRepositories } from '../ports/script/index';
import { createScriptJobSubmission } from './script-job-submission';

const FAILED_JOB = {
  cancelRequestedAt: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  deadlineAt: null,
  episodeId: null,
  errorCode: 'MODEL_TIMEOUT',
  errorJson: '{"code":"MODEL_TIMEOUT"}',
  finishedAt: '2026-08-13T00:01:00.000Z',
  id: 'job-failed-0001',
  idempotencyKey: 'idem-0001',
  inputVersionSetHash: 'old-hash',
  inputVersionsJson: JSON.stringify({
    references: [
      { id: 'source-0001', kind: 'SOURCE_INPUT', sha256: 'a'.repeat(64) },
      { id: 'format-0001', kind: 'FORMAT_PROFILE' },
    ],
  }),
  leaseExpiresAt: null,
  leaseToken: null,
  lockSnapshotHash: 'old-lock-hash',
  operationType: 'GENERATE',
  projectId: 'project-0001',
  promptTemplateId: 'concept/v1',
  queuedAt: '2026-08-13T00:00:00.000Z',
  selectionJson: null,
  stage: 'CONCEPT',
  startedAt: '2026-08-13T00:00:01.000Z',
  status: 'FAILED',
  structureRepairAttempts: 0,
  transportAttempts: 0,
  userOperationId: 'trace-old',
  writeSetJson: JSON.stringify(['/data']),
} as const;

const baseRepositories = (overrides?: Readonly<{ sourceId?: string }>) => {
  const insert = vi.fn(() => Promise.resolve());
  const repositories = {
    formatProfiles: {
      findCurrent: () => Promise.resolve({ id: 'format-0001', projectId: 'project-0001' }),
    },
    jobs: {
      findById: () => Promise.resolve(FAILED_JOB),
      findByIdempotencyKey: () => Promise.resolve(null),
      insert,
    },
    sourceInputs: {
      findCreativeByProjectId: () =>
        Promise.resolve({
          id: overrides?.sourceId ?? 'source-0001',
          projectId: 'project-0001',
          sha256: 'a'.repeat(64),
        }),
    },
  } as unknown as ScriptJobRepositories;
  return { insert, repositories };
};

const createSubmission = (
  repositories: ScriptJobRepositories,
  overrides?: Readonly<{
    hashPayload?: (value: Readonly<Record<string, unknown>>) => string;
    run?: {
      run<T>(work: (value: ScriptJobRepositories) => Promise<T>): Promise<T>;
    }['run'];
  }>,
) =>
  createScriptJobSubmission({
    hashPayload: overrides?.hashPayload ?? (() => 'f'.repeat(64)),
    newId: () => 'job-retry-0001',
    now: () => '2026-08-13T00:02:00.000Z',
    promptTemplateId: () => 'concept/v1',
    unitOfWork: { run: overrides?.run ?? ((work) => work(repositories)) },
  });

describe('ScriptJobSubmission', () => {
  it('条件—CONCEPT 前置匹配—同事务冻结输入并写 QUEUED，提交后 kick', async () => {
    const { insert, repositories } = baseRepositories();
    const kick = vi.fn();
    const submission = createScriptJobSubmission({
      hashPayload: () => 'f'.repeat(64),
      newId: () => 'job-00000001',
      now: () => '2026-08-13T00:00:00.000Z',
      onQueued: kick,
      promptTemplateId: () => 'concept/v1',
      unitOfWork: { run: (work) => work(repositories) },
    });
    const job = await submission.submit(
      {
        episodeId: null,
        expectedInputVersionId: 'source-0001',
        idempotencyKey: 'idem-0001',
        operationType: 'GENERATE',
        projectId: 'project-0001',
        requestId: 'request-0001',
        stage: 'CONCEPT',
      },
      'trace-0001',
    );
    expect(job.status).toBe('QUEUED');
    expect(insert).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledWith(job.id);
  });

  it('条件—expectedInputVersionId 过期—零 Job', async () => {
    const { insert, repositories } = baseRepositories();
    const submission = createSubmission(repositories);
    await expect(
      submission.submit(
        {
          episodeId: null,
          expectedInputVersionId: 'old-source',
          idempotencyKey: 'idem-0001',
          operationType: 'GENERATE',
          projectId: 'project-0001',
          requestId: 'request-0001',
          stage: 'CONCEPT',
        },
        'trace-0001',
      ),
    ).rejects.toMatchObject({ code: 'STALE_INPUT' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('条件—FAILED 人工重试—在当前 UoW 重新复检并冻结而非复制旧 hash', async () => {
    const { insert, repositories } = baseRepositories();
    const submission = createSubmission(repositories, {
      hashPayload: (value) => ('references' in value ? 'new-input-hash' : 'new-lock-hash'),
    });

    const retry = await submission.requeue(FAILED_JOB.id, 'trace-retry');

    expect(retry).toMatchObject({
      id: 'job-retry-0001',
      inputVersionSetHash: 'new-input-hash',
      lockSnapshotHash: 'new-lock-hash',
      status: 'QUEUED',
    });
    expect(insert).toHaveBeenCalledWith(retry);
  });

  it('条件—FAILED 的主前置已变化—重试返回 STALE_INPUT 且零新 Job', async () => {
    const { insert, repositories } = baseRepositories({ sourceId: 'source-new-0001' });
    const submission = createSubmission(repositories);

    await expect(submission.requeue(FAILED_JOB.id, 'trace-retry')).rejects.toMatchObject({
      code: 'STALE_INPUT',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('条件—运行时伪造延期 operation 或 SHOT_CONTRACT—进入 UoW 前拒绝且零 Job', async () => {
    const { insert, repositories } = baseRepositories();
    let runCalled = false;
    const run = async <T>(work: (value: ScriptJobRepositories) => Promise<T>): Promise<T> => {
      runCalled = true;
      return work(repositories);
    };
    const submission = createSubmission(repositories, { run });
    const deferred = {
      episodeId: null,
      expectedInputVersionId: 'source-0001',
      idempotencyKey: 'idem-deferred',
      operationType: 'REWRITE',
      projectId: 'project-0001',
      requestId: 'request-0001',
      stage: 'SHOT_CONTRACT',
    } as never;

    await expect(submission.submit(deferred, 'trace-0001')).rejects.toMatchObject({
      code: 'SCRIPT_STAGE_UNSUPPORTED',
    });
    expect(runCalled).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
