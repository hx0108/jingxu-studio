import { describe, expect, it, vi } from 'vitest';

import { claimNextEligibleJob } from './job-concurrency-gate';

import type {
  ClaimQueuedJobCommand,
  JobRepositories,
  JobUnitOfWorkPort,
  ScriptStageJob,
} from '../../ports/persistence/job/index';

const job = (id: string, projectId: string, status: ScriptStageJob['status']): ScriptStageJob => ({
  id,
  projectId,
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status,
  idempotencyKey: `key-${id}`,
  userOperationId: `operation-${id}`,
  inputVersionsJson: '[]',
  inputVersionSetHash: 'hash',
  selectionJson: null,
  writeSetJson: '[]',
  lockSnapshotHash: 'lock',
  promptTemplateId: 'prompt',
  transportAttempts: 0,
  structureRepairAttempts: 0,
  leaseToken: null,
  leaseExpiresAt: null,
  deadlineAt: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorJson: null,
  queuedAt: '2026-08-12T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  createdAt: `2026-08-12T00:00:0${id.slice(-1)}.000Z`,
});

const setup = (
  running: readonly ScriptStageJob[],
  validating: readonly ScriptStageJob[],
  queued: readonly ScriptStageJob[],
) => {
  const claimQueued = vi.fn<(command: ClaimQueuedJobCommand) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const repositories = {
    jobs: {
      claimQueued,
      listByStatuses: vi.fn(
        (statuses: readonly ScriptStageJob['status'][]): Promise<readonly ScriptStageJob[]> => {
          if (statuses.includes('QUEUED')) return Promise.resolve(queued);
          if (statuses.includes('RUNNING')) return Promise.resolve(running);
          return Promise.resolve(validating);
        },
      ),
    },
  } as unknown as JobRepositories;
  const unitOfWork: JobUnitOfWorkPort = { run: (work) => work(repositories) };
  return { claimQueued, unitOfWork };
};

const command = (runnerKind: 'mock' | 'real') => ({
  deadlineAt: '2026-08-12T00:05:00.000Z',
  leaseExpiresAt: '2026-08-12T00:00:30.000Z',
  leaseToken: 'lease',
  runnerKind,
  startedAt: '2026-08-12T00:00:00.000Z',
});

describe('claimNextEligibleJob', () => {
  it.each(['real', 'mock'] as const)('全局已有 RUNNING 时 %s Job 同样不得领取', async (kind) => {
    const { claimQueued, unitOfWork } = setup(
      [job('running1', 'project_a', 'RUNNING')],
      [],
      [job('queued1', 'project_b', 'QUEUED')],
    );

    await expect(claimNextEligibleJob(unitOfWork, command(kind))).resolves.toBeNull();
    expect(claimQueued).not.toHaveBeenCalled();
  });

  it('同项目存在 VALIDATING 时跳过该项目并领取另一项目的最早 Job', async () => {
    const { claimQueued, unitOfWork } = setup(
      [],
      [job('validating1', 'project_a', 'VALIDATING')],
      [job('queued1', 'project_a', 'QUEUED'), job('queued2', 'project_b', 'QUEUED')],
    );

    await expect(claimNextEligibleJob(unitOfWork, command('mock'))).resolves.toMatchObject({
      id: 'queued2',
    });
    expect(claimQueued).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'queued2' }));
  });

  it('条件领取失败时不返回 Job，只有领取成功方可继续 Provider', async () => {
    const { claimQueued, unitOfWork } = setup([], [], [job('queued1', 'project_a', 'QUEUED')]);
    claimQueued.mockResolvedValue(false);

    await expect(claimNextEligibleJob(unitOfWork, command('real'))).resolves.toBeNull();
  });
});
