import { describe, expect, it, vi } from 'vitest';

import { createJobRunner } from './job-runner';

import type {
  JobRepositories,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  ModelInvocation,
  ModelInvocationRepositoryPort,
  NormalizedModelError,
  ScriptStageJob,
  TextGenerationResult,
  TextModelPort,
} from '../../index';

const NOW = '2026-08-12T00:00:00.000Z';
const valid = Object.freeze({ valid: true as const });

const queuedJob = (): ScriptStageJob => ({
  cancelRequestedAt: null,
  createdAt: NOW,
  deadlineAt: null,
  episodeId: null,
  errorCode: null,
  errorJson: null,
  finishedAt: null,
  id: 'job_1',
  idempotencyKey: 'idem_1',
  inputVersionSetHash: 'input_hash',
  inputVersionsJson: '[]',
  leaseExpiresAt: null,
  leaseToken: null,
  lockSnapshotHash: 'lock_hash',
  operationType: 'GENERATE',
  projectId: 'project_1',
  promptTemplateId: 'prompt_1',
  queuedAt: NOW,
  selectionJson: null,
  stage: 'CONCEPT',
  startedAt: null,
  status: 'QUEUED',
  structureRepairAttempts: 0,
  transportAttempts: 0,
  userOperationId: 'operation_1',
  writeSetJson: '[]',
});

const result = (rawText = '{"data":{"title":"candidate"}}'): TextGenerationResult => ({
  finishReason: 'stop',
  modelReported: 'mock',
  providerRequestId: 'provider_request_1',
  rawText,
  usage: { inputTokens: 10, outputTokens: 5 },
});

const modelError = (code: NormalizedModelError['code']): NormalizedModelError => ({
  code,
  detail: null,
  providerRequestId: null,
  retryable: ['MODEL_NETWORK_ERROR', 'MODEL_RATE_LIMITED', 'MODEL_PROVIDER_ERROR'].includes(code),
  userAction: null,
});

interface Store {
  invocations: ModelInvocation[];
  job: ScriptStageJob;
  versions: unknown[];
}

const createHarness = (
  steps: readonly (NormalizedModelError | TextGenerationResult)[],
  options?: Readonly<{ commitFails?: boolean; finalInvalid?: boolean }>,
) => {
  const events: string[] = [];
  const store: Store = { invocations: [], job: queuedJob(), versions: [] };
  let transactionActive = false;
  let cursor = 0;

  const jobs: JobRepositoryPort = {
    cancel: (command) => {
      events.push('cancel:persisted');
      if (store.job.status !== command.expectedStatus) return Promise.resolve(false);
      store.job = {
        ...store.job,
        cancelRequestedAt: command.cancelRequestedAt,
        finishedAt: command.finishedAt,
        status: 'CANCELLED',
      };
      return Promise.resolve(true);
    },
    claimQueued: (command) => {
      events.push('claim');
      if (store.job.status !== 'QUEUED') return Promise.resolve(false);
      store.job = {
        ...store.job,
        deadlineAt: command.deadlineAt,
        leaseExpiresAt: command.leaseExpiresAt,
        leaseToken: command.leaseToken,
        startedAt: command.startedAt,
        status: 'RUNNING',
      };
      return Promise.resolve(true);
    },
    findById: () => Promise.resolve(store.job),
    findByIdempotencyKey: () => Promise.resolve(null),
    insert: () => Promise.resolve(),
    listByStatuses: () => Promise.resolve([]),
    releaseUnsentForRecovery: () =>
      Promise.reject(new Error('JobRunner must not use the recovery-only release path')),
    transition: (command) => {
      events.push(`transition:${command.nextStatus}`);
      if (store.job.status !== command.expectedStatus) return Promise.resolve(false);
      store.job = {
        ...store.job,
        errorCode: command.errorCode,
        errorJson: command.errorJson,
        finishedAt: command.finishedAt,
        status: command.nextStatus,
        structureRepairAttempts: command.structureRepairAttempts,
        transportAttempts: command.transportAttempts,
      };
      return Promise.resolve(true);
    },
  };

  const invocations: ModelInvocationRepositoryPort = {
    findById: (id) =>
      Promise.resolve(store.invocations.find((invocation) => invocation.id === id) ?? null),
    finish: (id, status, finishedAt, errorCode) => {
      events.push(`finish:${status}`);
      const found = store.invocations.some((item) => item.id === id);
      store.invocations = store.invocations.map((item) =>
        item.id === id ? { ...item, errorCode, finishedAt, status } : item,
      );
      return Promise.resolve(found);
    },
    insert: (invocation) => {
      events.push(`insert:${invocation.attemptKind}`);
      store.invocations.push(invocation);
      return Promise.resolve();
    },
    listByJobId: () => Promise.resolve(store.invocations),
    listRecoveryEvidence: () => Promise.resolve([]),
    markRequestSent: (id, requestSentAt, timeoutAt) => {
      events.push('mark-sent');
      const found = store.invocations.some((item) => item.id === id);
      store.invocations = store.invocations.map((item) =>
        item.id === id ? { ...item, requestSentAt, timeoutAt } : item,
      );
      return Promise.resolve(found);
    },
    recordLateResponse: (id, rawResponseSha256, lateResponseAt) => {
      events.push('late-evidence');
      const found = store.invocations.some((item) => item.id === id);
      store.invocations = store.invocations.map((item) =>
        item.id === id ? { ...item, lateResponseAt, rawResponseSha256 } : item,
      );
      return Promise.resolve(found);
    },
    recordResponse: (evidence) => {
      events.push('record-response');
      const found = store.invocations.some((item) => item.id === evidence.invocationId);
      store.invocations = store.invocations.map((item) =>
        item.id === evidence.invocationId
          ? {
              ...item,
              inputTokens: evidence.inputTokens,
              outputTokens: evidence.outputTokens,
              providerRequestId: evidence.providerRequestId,
              rawResponse: evidence.rawResponse,
              rawResponseSha256: evidence.rawResponseSha256,
              responseCompleteAt: evidence.responseCompleteAt,
            }
          : item,
      );
      return Promise.resolve(found);
    },
  };
  const repositories: JobRepositories = { invocations, jobs };
  const unitOfWork: JobUnitOfWorkPort = {
    run: async (work) => {
      const snapshot = structuredClone(store);
      transactionActive = true;
      events.push('tx:begin');
      try {
        const value = await work(repositories);
        events.push('tx:commit');
        return value;
      } catch (error) {
        store.invocations = snapshot.invocations;
        store.job = snapshot.job;
        store.versions = snapshot.versions;
        events.push('tx:rollback');
        throw error;
      } finally {
        transactionActive = false;
      }
    },
  };
  const textModel: TextModelPort = {
    generate: () => {
      events.push('generate');
      expect(transactionActive).toBe(false);
      const step = steps[cursor++];
      if (step === undefined) return Promise.reject(new Error('mock exhausted'));
      return 'rawText' in step
        ? Promise.resolve(step)
        : Promise.reject(Object.assign(new Error(step.code), { normalized: step }));
    },
    normalizeError: (error) =>
      (error as { normalized?: NormalizedModelError }).normalized ?? modelError('MODEL_UNKNOWN'),
    validateCredential: () => Promise.resolve({ ok: true }),
  };
  let sequence = 0;
  const runner = createJobRunner({
    buildContract: (_job, invocationId) => ({
      injectSystemFields: (candidate) => {
        events.push(`inject:${invocationId}`);
        return {
          ...(candidate as object),
          source_invocation_id: invocationId,
          version_id: 'fresh_id',
        };
      },
      validateCandidate: (candidate) =>
        typeof candidate === 'object' && candidate !== null && 'data' in candidate
          ? valid
          : { code: 'CANDIDATE_INVALID', valid: false },
      validateCollection: () => valid,
      validateFinal: () =>
        options?.finalInvalid === true ? { code: 'FINAL_SCHEMA_INVALID', valid: false } : valid,
    }),
    buildRequest: (job, invocationId, repair) => {
      if (repair !== undefined) events.push(`repair-input:${repair.rawText}`);
      return {
        candidateSchemaId: 'candidate/1',
        finalSchemaId: 'final/1',
        invocationId,
        parameters: repair === undefined ? {} : { repair },
        promptTemplateVersion: job.promptTemplateId,
        stage: job.stage,
        systemPrompt: 'Return JSON.',
        userPayload: {},
      };
    },
    commitHandler: {
      commit: (_repositories, value) => {
        events.push('commit-handler');
        store.versions.push(value);
        if (options?.commitFails === true) throw new Error('commit failed');
        return Promise.resolve();
      },
    },
    createInvocationId: () => `invocation_${String(++sequence)}`,
    createLeaseToken: () => 'lease_1',
    hash: () => 'hash',
    model: { id: 'mock', providerProfileId: 'profile_1', version: '1' },
    now: () => NOW,
    onAbort: () => events.push('abort'),
    textModel,
    unitOfWork,
  });
  return { events, runner, store, textModel };
};

describe('JobRunner', () => {
  it('竞争领取—仅一个 runner 胜出—Provider 只调用一次', async () => {
    const harness = createHarness([result()]);
    const generate = vi.spyOn(harness.textModel, 'generate');
    const outcomes = await Promise.all([harness.runner.run('job_1'), harness.runner.run('job_1')]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['NOT_CLAIMED', 'SUCCEEDED']);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('发送证据先于事务外 generate—响应证据与 VALIDATING 同事务—最终提交与 SUCCEEDED 同事务', async () => {
    const harness = createHarness([result()]);
    await expect(harness.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
    expect(harness.events.indexOf('mark-sent')).toBeLessThan(harness.events.indexOf('generate'));
    const response = harness.events.indexOf('record-response');
    expect(harness.events.slice(response - 1, response + 4)).toEqual([
      'tx:begin',
      'record-response',
      'finish:SUCCEEDED',
      'transition:VALIDATING',
      'tx:commit',
    ]);
    const commit = harness.events.indexOf('commit-handler');
    expect(harness.events.slice(commit - 1, commit + 3)).toEqual([
      'tx:begin',
      'commit-handler',
      'transition:SUCCEEDED',
      'tx:commit',
    ]);
    expect(harness.store.versions).toHaveLength(1);
  });

  it('最终业务提交失败—整个 UnitOfWork 回滚—不留半个版本或 SUCCEEDED', async () => {
    const harness = createHarness([result()], { commitFails: true });
    await expect(harness.runner.run('job_1')).rejects.toThrow('commit failed');
    expect(harness.store.versions).toHaveLength(0);
    expect(harness.store.job.status).toBe('VALIDATING');
    expect(harness.events).toContain('tx:rollback');
  });

  it.each(['MODEL_NETWORK_ERROR', 'MODEL_RATE_LIMITED', 'MODEL_PROVIDER_ERROR'] as const)(
    '%s—最多重试两次—每次独立 TRANSPORT_RETRY Invocation',
    async (code) => {
      const harness = createHarness([modelError(code), modelError(code), result()]);
      await expect(harness.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
      expect(harness.store.invocations.map((item) => item.attemptKind)).toEqual([
        'INITIAL',
        'TRANSPORT_RETRY',
        'TRANSPORT_RETRY',
      ]);
      expect(harness.store.job.transportAttempts).toBe(2);
    },
  );

  it('可重试错误连续三次—只自动重试两次—第三次 FAILED 且终态不回退', async () => {
    const error = modelError('MODEL_RATE_LIMITED');
    const harness = createHarness([error, error, error]);
    await expect(harness.runner.run('job_1')).resolves.toEqual({
      errorCode: 'MODEL_RATE_LIMITED',
      status: 'FAILED',
    });
    expect(harness.store.invocations).toHaveLength(3);
    expect(harness.store.job.transportAttempts).toBe(2);
    await expect(harness.runner.run('job_1')).resolves.toEqual({ status: 'NOT_CLAIMED' });
    expect(harness.store.job.status).toBe('FAILED');
  });

  it.each([
    'MODEL_CREDENTIAL_INVALID',
    'MODEL_CONTENT_REJECTED',
    'MODEL_CONTEXT_LIMIT',
    'MODEL_TIMEOUT',
  ] as const)('%s—不可重试—直接 FAILED', async (code) => {
    const harness = createHarness([modelError(code)]);
    await expect(harness.runner.run('job_1')).resolves.toEqual({
      errorCode: code,
      status: 'FAILED',
    });
    expect(harness.store.invocations).toHaveLength(1);
    expect(harness.store.job.status).toBe('FAILED');
    const finish = harness.events.indexOf('finish:FAILED');
    expect(harness.events.slice(finish - 1, finish + 3)).toEqual([
      'tx:begin',
      'finish:FAILED',
      'transition:FAILED',
      'tx:commit',
    ]);
  });

  it('候选结构失败—只修一次并重新注入系统字段—第二次仍失败不写版本', async () => {
    const harness = createHarness([result('{'), result('{}')]);
    await expect(harness.runner.run('job_1')).resolves.toEqual({
      errorCode: 'STRUCTURE_REPAIR_FAILED',
      status: 'FAILED',
    });
    expect(harness.store.invocations.map((item) => item.attemptKind)).toEqual([
      'INITIAL',
      'STRUCTURE_REPAIR',
    ]);
    expect(harness.events).toContain('repair-input:{');
    expect(harness.store.job.structureRepairAttempts).toBe(1);
    expect(harness.store.versions).toHaveLength(0);
  });

  it('候选修复成功—系统字段使用修复 Invocation 的新 ID—不信任首次响应', async () => {
    const harness = createHarness([result('{'), result('{"data":{"title":"fixed"}}')]);
    await expect(harness.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
    expect(harness.events).toContain('inject:invocation_2');
    expect(harness.store.versions[0]).toMatchObject({ source_invocation_id: 'invocation_2' });
    expect(harness.store.job.structureRepairAttempts).toBe(1);
  });

  it('正式 Schema 层失败—Job 持久化 FAILED—不触发修复且零版本写入', async () => {
    const harness = createHarness([result()], { finalInvalid: true });
    await expect(harness.runner.run('job_1')).resolves.toEqual({
      errorCode: 'CONTRACT_VALIDATION_FAILED',
      status: 'FAILED',
    });
    expect(harness.store.invocations).toHaveLength(1);
    expect(harness.store.job.structureRepairAttempts).toBe(0);
    expect(harness.store.versions).toHaveLength(0);
  });

  it('取消—先持久化 CANCELLED 再 abort—迟到响应只写 hash/late time', async () => {
    let resolveLate: ((value: TextGenerationResult) => void) | undefined;
    const harness = createHarness([result()]);
    vi.spyOn(harness.textModel, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          harness.events.push('generate');
          resolveLate = resolve;
        }),
    );
    const running = harness.runner.run('job_1');
    await vi.waitFor(() => {
      expect(harness.events).toContain('generate');
    });
    await expect(harness.runner.cancel('job_1')).resolves.toEqual({ status: 'CANCELLED' });
    expect(harness.events.indexOf('cancel:persisted')).toBeLessThan(
      harness.events.indexOf('abort'),
    );
    expect(harness.events[harness.events.indexOf('abort') - 1]).toBe('tx:commit');
    resolveLate?.(result('{"late":true}'));
    await expect(running).resolves.toEqual({ status: 'CANCELLED' });
    expect(harness.events).toContain('late-evidence');
    expect(harness.store.versions).toHaveLength(0);
    expect(harness.store.invocations[0]).toMatchObject({
      lateResponseAt: NOW,
      parsedJson: null,
      responseCompleteAt: null,
    });
  });

  it('取消触发 Provider MODEL_CANCELLED—保持 CANCELLED 终态—不重试不回退', async () => {
    let rejectCancelled: ((reason: unknown) => void) | undefined;
    const harness = createHarness([]);
    vi.spyOn(harness.textModel, 'generate').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          harness.events.push('generate');
          rejectCancelled = reject;
        }),
    );
    const running = harness.runner.run('job_1');
    await vi.waitFor(() => {
      expect(harness.events).toContain('generate');
    });
    await harness.runner.cancel('job_1');
    rejectCancelled?.({ normalized: modelError('MODEL_CANCELLED') });
    await expect(running).resolves.toEqual({ status: 'CANCELLED' });
    expect(harness.store.job.status).toBe('CANCELLED');
    expect(harness.store.invocations).toHaveLength(1);
  });
});
