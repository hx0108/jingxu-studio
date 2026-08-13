import path from 'node:path';

import {
  claimNextEligibleJob,
  recoverPendingJobs,
  type ModelInvocation,
  type ScriptStageJob,
} from '@jingxu/application';
import { describe, expect, it, vi } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteJobUnitOfWork } from './sqlite-job-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const START = '2026-08-12T00:00:00.000Z';
const RECOVERY_NOW = '2026-08-12T00:01:00.000Z';
const NORMAL_DEADLINE = '2026-08-12T00:05:00.000Z';

const seedReferences = (database: SqliteDatabase): void => {
  for (const projectId of ['p1', 'p2']) {
    database
      .prepare(
        `INSERT INTO projects
         (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        projectId,
        projectId,
        'AI_ORIGINAL',
        'NARRATION_FIRST',
        'LOCAL_DEMO',
        `projects/${projectId}`,
        START,
        START,
      );
  }
  database
    .prepare(
      `INSERT INTO prompt_templates
       (id,stage,version,template_text,sha256,active,created_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run('prompt1', 'CONCEPT', 99, 'template', 'sha', 1, START);
  database
    .prepare(
      `INSERT INTO provider_profiles
       (id,provider,region,base_url,workspace_id,model_id,model_snapshot_date,config_json,credential_ref,enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'provider1',
      'QWEN',
      'cn-beijing',
      'https://example.invalid',
      'ws',
      'model',
      '2026-08-12',
      '{}',
      'ref',
      1,
    );
};

const withDatabase = async <T>(operation: (uow: SqliteJobUnitOfWork) => Promise<T>) =>
  withSqliteTestContext(async ({ root }) => {
    const database = new SqliteTestDatabase(path.join(root, 'job-concurrency-recovery.sqlite'));
    try {
      applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => START);
      seedReferences(database);
      return await operation(new SqliteJobUnitOfWork(database));
    } finally {
      database.close();
    }
  });

const job = (id: string, projectId = 'p1'): ScriptStageJob => ({
  id,
  projectId,
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status: 'QUEUED',
  idempotencyKey: `key-${id}`,
  userOperationId: `operation-${id}`,
  inputVersionsJson: '[]',
  inputVersionSetHash: 'hash',
  selectionJson: null,
  writeSetJson: '[]',
  lockSnapshotHash: 'lock',
  promptTemplateId: 'prompt1',
  transportAttempts: 0,
  structureRepairAttempts: 0,
  leaseToken: null,
  leaseExpiresAt: null,
  deadlineAt: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorJson: null,
  queuedAt: START,
  startedAt: null,
  finishedAt: null,
  createdAt: `${START.slice(0, -5)}${String(id.length)}.000Z`,
});

const invocation = (id: string, jobId: string): ModelInvocation => ({
  id,
  jobId,
  status: 'STARTED',
  attemptKind: 'INITIAL',
  transportAttempt: 1,
  providerProfileId: 'provider1',
  providerRequestId: null,
  modelId: 'model',
  modelVersion: 'snapshot',
  parametersJson: '{}',
  requestSnapshotJson: '{}',
  requestSha256: 'request-hash',
  requestSentAt: null,
  timeoutAt: null,
  rawResponse: null,
  rawResponseSha256: null,
  responseCompleteAt: null,
  lateResponseAt: null,
  parsedJson: null,
  validationErrorsJson: null,
  inputTokens: null,
  outputTokens: null,
  estimatedCostMicros: null,
  currency: null,
  startedAt: START,
  finishedAt: null,
  errorCode: null,
});

const claim = (uow: SqliteJobUnitOfWork, jobId: string, deadlineAt = NORMAL_DEADLINE) =>
  uow.run(({ jobs }) =>
    jobs.claimQueued({
      deadlineAt,
      jobId,
      leaseExpiresAt: '2026-08-12T00:00:30.000Z',
      leaseToken: `lease-${jobId}`,
      startedAt: START,
    }),
  );

describe('Job concurrency and crash recovery', () => {
  it.each(['real', 'mock'] as const)(
    '真实 SQLite—全局 RUNNING 门—%s runner 不领取第二个 Job',
    async (runnerKind) => {
      await withDatabase(async (uow) => {
        await uow.run(async ({ jobs }) => {
          await jobs.insert(job('running'));
          await jobs.insert(job('queued', 'p2'));
        });
        await claim(uow, 'running');
        await expect(
          claimNextEligibleJob(uow, {
            deadlineAt: NORMAL_DEADLINE,
            leaseExpiresAt: RECOVERY_NOW,
            leaseToken: 'next-lease',
            runnerKind,
            startedAt: START,
          }),
        ).resolves.toBeNull();
        await expect(uow.run(({ jobs }) => jobs.findById('queued'))).resolves.toMatchObject({
          status: 'QUEUED',
        });
      });
    },
  );

  it('真实 SQLite—同项目 VALIDATING—跳过同项目并领取另一项目', async () => {
    await withDatabase(async (uow) => {
      await uow.run(async ({ jobs }) => {
        await jobs.insert(job('validating'));
        await jobs.insert(job('same-project'));
        await jobs.insert(job('other-project', 'p2'));
      });
      await claim(uow, 'validating');
      await uow.run(({ jobs }) =>
        jobs.transition({
          errorCode: null,
          errorJson: null,
          expectedStatus: 'RUNNING',
          finishedAt: null,
          jobId: 'validating',
          nextStatus: 'VALIDATING',
          structureRepairAttempts: 0,
          transportAttempts: 0,
        }),
      );
      await expect(
        claimNextEligibleJob(uow, {
          deadlineAt: NORMAL_DEADLINE,
          leaseExpiresAt: RECOVERY_NOW,
          leaseToken: 'next-lease',
          runnerKind: 'mock',
          startedAt: START,
        }),
      ).resolves.toMatchObject({ id: 'other-project' });
      await expect(uow.run(({ jobs }) => jobs.findById('same-project'))).resolves.toMatchObject({
        status: 'QUEUED',
      });
    });
  });

  it('真实 SQLite—恢复完整矩阵—终态、幂等重校验与原时间证据正确', async () => {
    await withDatabase(async (uow) => {
      for (const id of [
        'queued',
        'unsent',
        'unknown',
        'complete',
        'cancelled',
        'deadline',
        'timeout',
      ]) {
        await uow.run(({ jobs }) => jobs.insert(job(id)));
      }
      for (const id of ['unsent', 'unknown', 'complete', 'cancelled', 'timeout'])
        await claim(uow, id);
      await claim(uow, 'deadline', '2026-08-12T00:00:59.000Z');
      await uow.run(async ({ invocations }) => {
        for (const id of ['unsent', 'unknown', 'complete', 'cancelled', 'timeout']) {
          await invocations.insert(invocation(`inv-${id}`, id));
        }
        await invocations.markRequestSent('inv-unknown', START, NORMAL_DEADLINE);
        await invocations.markRequestSent('inv-complete', START, NORMAL_DEADLINE);
        await invocations.markRequestSent('inv-cancelled', START, NORMAL_DEADLINE);
        await invocations.markRequestSent('inv-timeout', START, '2026-08-12T00:00:59.000Z');
        await invocations.recordResponse({
          inputTokens: 1,
          invocationId: 'inv-complete',
          outputTokens: 1,
          providerRequestId: 'provider-complete',
          rawResponse: new Uint8Array([1]),
          rawResponseSha256: 'response-hash',
          responseCompleteAt: START,
        });
      });
      await uow.run(({ jobs }) =>
        jobs.transition({
          errorCode: null,
          errorJson: null,
          expectedStatus: 'RUNNING',
          finishedAt: null,
          jobId: 'complete',
          nextStatus: 'VALIDATING',
          structureRepairAttempts: 0,
          transportAttempts: 0,
        }),
      );
      await uow.run(({ jobs }) =>
        jobs.cancel({
          cancelRequestedAt: START,
          expectedStatus: 'RUNNING',
          finishedAt: START,
          jobId: 'cancelled',
        }),
      );
      const revalidatedJobIds: string[] = [];
      const revalidate = vi.fn((recoveredJob: ScriptStageJob) => {
        revalidatedJobIds.push(recoveredJob.id);
        return Promise.resolve();
      });

      await recoverPendingJobs(uow, {
        now: () => RECOVERY_NOW,
        responseHashMatches: (value) => value.rawResponseSha256 === 'response-hash',
        revalidate,
      });

      expect(revalidate).toHaveBeenCalledTimes(1);
      expect(revalidatedJobIds).toEqual(['complete']);
      await expect(uow.run(({ jobs }) => jobs.findById('queued'))).resolves.toMatchObject({
        status: 'QUEUED',
      });
      await expect(uow.run(({ jobs }) => jobs.findById('unsent'))).resolves.toMatchObject({
        deadlineAt: NORMAL_DEADLINE,
        leaseToken: null,
        status: 'QUEUED',
      });
      for (const [id, errorCode] of [
        ['unknown', 'INTERRUPTED_UNKNOWN_OUTCOME'],
        ['deadline', 'JOB_DEADLINE_EXCEEDED'],
        ['timeout', 'MODEL_TIMEOUT'],
      ] as const) {
        await expect(uow.run(({ jobs }) => jobs.findById(id))).resolves.toMatchObject({
          errorCode,
          status: 'FAILED',
        });
      }
      await expect(uow.run(({ jobs }) => jobs.findById('cancelled'))).resolves.toMatchObject({
        cancelRequestedAt: START,
        status: 'CANCELLED',
      });
      await expect(
        uow.run(({ invocations }) => invocations.findById('inv-timeout')),
      ).resolves.toMatchObject({
        timeoutAt: '2026-08-12T00:00:59.000Z',
      });
    });
  });
});
