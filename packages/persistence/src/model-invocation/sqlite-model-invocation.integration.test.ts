import path from 'node:path';

import type { ModelInvocation, ScriptStageJob } from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteJobUnitOfWork } from '../job/sqlite-job-unit-of-work';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-12T00:00:00.000Z';
const LATER = '2026-08-12T00:00:01.000Z';

const withDatabase = async <T>(
  operation: (database: SqliteTestDatabase, uow: SqliteJobUnitOfWork) => Promise<T>,
) =>
  withSqliteTestContext(async ({ root }) => {
    const database = new SqliteTestDatabase(path.join(root, 'invocations.sqlite'));
    try {
      applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
      database
        .prepare(
          `INSERT INTO projects (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run('p1', '项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO', 'projects/p1', NOW, NOW);
      database
        .prepare(
          `INSERT INTO prompt_templates (id,stage,version,template_text,sha256,active,created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run('prompt1', 'CONCEPT', 99, 't', 'sha', 1, NOW);
      database
        .prepare(
          `INSERT INTO provider_profiles (id,provider,region,base_url,workspace_id,model_id,model_snapshot_date,config_json,credential_ref,enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
          'credential-ref',
          1,
        );
      const uow = new SqliteJobUnitOfWork(database);
      await uow.run(({ jobs }) => jobs.insert(job));
      return await operation(database, uow);
    } finally {
      database.close();
    }
  });

const job: ScriptStageJob = {
  id: 'j1',
  projectId: 'p1',
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status: 'QUEUED',
  idempotencyKey: 'idem',
  userOperationId: 'op',
  inputVersionsJson: '[]',
  inputVersionSetHash: 'inputs',
  selectionJson: null,
  writeSetJson: '[]',
  lockSnapshotHash: 'locks',
  promptTemplateId: 'prompt1',
  transportAttempts: 0,
  structureRepairAttempts: 0,
  leaseToken: null,
  leaseExpiresAt: null,
  deadlineAt: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorJson: null,
  queuedAt: NOW,
  startedAt: null,
  finishedAt: null,
  createdAt: NOW,
};
const invocation = (id = 'i1'): ModelInvocation => ({
  id,
  jobId: 'j1',
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
  startedAt: NOW,
  finishedAt: null,
  errorCode: null,
});

describe('model_invocations Repository', () => {
  it('发送、响应与迟到证据—分步写入—精确读取 blob/hash/时间戳', async () => {
    await withDatabase(async (_database, uow) => {
      await uow.run(({ invocations }) => invocations.insert(invocation()));
      await expect(
        uow.run(({ invocations }) => invocations.markRequestSent('i1', NOW, LATER)),
      ).resolves.toBe(true);
      const bytes = new TextEncoder().encode('{"ok":true}');
      await expect(
        uow.run(({ invocations }) =>
          invocations.recordResponse({
            invocationId: 'i1',
            providerRequestId: 'request-1',
            rawResponse: bytes,
            rawResponseSha256: 'response-hash',
            responseCompleteAt: LATER,
            inputTokens: 10,
            outputTokens: 4,
          }),
        ),
      ).resolves.toBe(true);
      await expect(
        uow.run(({ invocations }) => invocations.recordLateResponse('i1', 'late-hash', LATER)),
      ).resolves.toBe(false);
      const found = await uow.run(({ invocations }) => invocations.findById('i1'));
      expect(found).toMatchObject({
        requestSentAt: NOW,
        timeoutAt: LATER,
        providerRequestId: 'request-1',
        rawResponseSha256: 'response-hash',
        responseCompleteAt: LATER,
        lateResponseAt: null,
        inputTokens: 10,
        outputTokens: 4,
      });
      expect(found?.rawResponse).toEqual(bytes);

      await uow.run(({ invocations }) => invocations.insert(invocation('late')));
      await expect(
        uow.run(({ invocations }) => invocations.recordLateResponse('late', 'late-hash', LATER)),
      ).resolves.toBe(true);
      await expect(
        uow.run(({ invocations }) => invocations.findById('late')),
      ).resolves.toMatchObject({
        lateResponseAt: LATER,
        rawResponseSha256: 'late-hash',
        rawResponse: null,
      });
    });
  });

  it.each([
    ['BROKEN', 1],
    ['INITIAL', 0],
    ['INITIAL', 4],
  ] as const)(
    '非法 attempt_kind/transport_attempt (%s/%i)—DB CHECK 阻断',
    async (kind, attempt) => {
      await withDatabase(async (_database, uow) => {
        await expect(
          uow.run(({ invocations }) =>
            invocations.insert({
              ...invocation(),
              attemptKind: kind as 'INITIAL',
              transportAttempt: attempt,
            }),
          ),
        ).rejects.toBeTruthy();
      });
    },
  );

  it('恢复证据—跨 Job 查询—按 started_at/id 稳定排序且空输入不生成动态 SQL', async () => {
    await withDatabase(async (_database, uow) => {
      await uow.run(async ({ invocations }) => {
        await invocations.insert(invocation('i2'));
        await invocations.insert(invocation('i1'));
      });
      await expect(
        uow.run(({ invocations }) => invocations.listRecoveryEvidence([])),
      ).resolves.toEqual([]);
      const rows = await uow.run(({ invocations }) => invocations.listRecoveryEvidence(['j1']));
      expect(rows.map(({ id }) => id)).toEqual(['i1', 'i2']);
    });
  });
});
