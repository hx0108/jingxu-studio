import { describe, expect, it, vi } from 'vitest';

import {
  createJobRunner,
  injectShotSystemFields,
  validateShotSetCollection,
} from '@jingxu/application';

import type {
  JobRepositories,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  ModelInvocation,
  ModelInvocationRepositoryPort,
  ScriptStageJob,
} from '@jingxu/application';
import {
  MockTextModelAdapter,
  createMockModelError,
  type MockTextModelStep,
} from './mock-text-model-adapter';

/**
 * AC-V1-04 Provider 全矩阵集成证据（PRD v1.4 §9.4.2/§9.4.3、AGENTS.md §15.4）。
 *
 * 与 `mock-text-model-adapter.test.ts`（3.1，Mock 单元）和 `job-runner.test.ts`（4.x，runner +
 * 内联 stub model）的区别：这里把**真实 `MockTextModelAdapter`** 接到**真实 `createJobRunner`**，
 * 用声明式 step 序列依次跑通 401/429/5xx/120s 超时/非法 JSON/结构修复/STALE_INPUT/取消+迟到响应，
 * 并在每种终态上断言四条横切不变量：终态不回退、不重复版本、原始输入不丢失、保留 Provider 任务 ID。
 * 不访问真实网络（Mock 适配器零 fetch）。
 */

const NOW = '2026-08-12T00:00:00.000Z';
const valid = Object.freeze({ valid: true as const });

const queuedJob = (stage: ScriptStageJob['stage'] = 'CONCEPT'): ScriptStageJob => ({
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
  inputVersionsJson: '[{"v":"original"}]',
  leaseExpiresAt: null,
  leaseToken: null,
  lockSnapshotHash: 'lock_hash',
  operationType: 'GENERATE',
  projectId: 'project_1',
  promptTemplateId: 'prompt_1',
  queuedAt: NOW,
  selectionJson: null,
  stage,
  startedAt: null,
  status: 'QUEUED',
  structureRepairAttempts: 0,
  transportAttempts: 0,
  userOperationId: 'operation_1',
  writeSetJson: '[]',
});

interface Store {
  invocations: ModelInvocation[];
  job: ScriptStageJob;
  versions: unknown[];
}

interface MatrixHarnessOptions {
  readonly commitStale?: boolean;
  /** shot-set：SHOT_CONTRACT 分镜契约（真实注入 + 真实集合校验；候选层为结构性检查）。 */
  readonly contractKind?: 'shot-set';
  /** 五阶段默认 CONCEPT；SHOT_CONTRACT 矩阵用 stage: 'SHOT_CONTRACT'。 */
  readonly stage?: ScriptStageJob['stage'];
  readonly steps: readonly MockTextModelStep[];
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface MatrixHarness {
  readonly events: string[];
  readonly runner: ReturnType<typeof createJobRunner>;
  readonly store: Store;
}

const createMatrixHarness = ({
  steps,
  commitStale = false,
  contractKind,
  stage = 'CONCEPT',
  wait,
}: MatrixHarnessOptions): MatrixHarness => {
  const events: string[] = [];
  const store: Store = { invocations: [], job: queuedJob(stage), versions: [] };
  let sequence = 0;

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
      }
    },
  };

  const textModel = new MockTextModelAdapter({
    now: () => 1_000,
    requestId: (sequenceNumber) => `provider_task_${String(sequenceNumber)}`,
    steps,
    wait: wait ?? (() => Promise.resolve()),
  });

  const runner = createJobRunner({
    buildContract: (_job, invocationId) =>
      Promise.resolve(
        contractKind === 'shot-set'
          ? {
              injectSystemFields: (candidate: unknown) =>
                injectShotSystemFields(candidate, {
                  formatProfileId: 'format_1',
                  invocationId,
                  newShotId: (index) => `shot_${String(index + 1)}`,
                  newVersionId: (index) => `scv_${String(index + 1)}_v1`,
                }),
              validateCandidate: (candidate: unknown) => {
                const data =
                  typeof candidate === 'object' && candidate !== null
                    ? (candidate as Readonly<{ data?: unknown }>).data
                    : null;
                const shots =
                  typeof data === 'object' && data !== null
                    ? (data as Readonly<{ shots?: unknown }>).shots
                    : null;
                return Array.isArray(shots) &&
                  shots.length > 0 &&
                  shots.every((shot) => typeof shot === 'object' && shot !== null)
                  ? valid
                  : { code: 'CANDIDATE_INVALID', valid: false };
              },
              validateCollection: (value: unknown) => {
                const result = validateShotSetCollection(value, {
                  characterIds: ['char_lead'],
                  sceneIds: ['scene_train'],
                });
                return result.valid
                  ? valid
                  : { code: result.code, details: result.details, valid: false };
              },
              validateFinal: () => valid,
            }
          : {
              injectSystemFields: (candidate: unknown) => ({
                ...(candidate as object),
                source_invocation_id: invocationId,
                version_id: 'fresh_id',
              }),
              validateCandidate: (candidate: unknown) =>
                typeof candidate === 'object' && candidate !== null && 'data' in candidate
                  ? valid
                  : { code: 'CANDIDATE_INVALID', valid: false },
              validateCollection: () => valid,
              validateFinal: () => valid,
            },
      ),
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
        if (commitStale) throw new Error('STALE_INPUT');
        store.versions.push(value);
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

  return { events, runner, store };
};

/** 横切不变量：每次 Invocation 都留存请求快照与 hash，Job 原始输入版本集不变。 */
const assertInputPreserved = (store: Store): void => {
  for (const invocation of store.invocations) {
    expect(invocation.requestSnapshotJson.length).toBeGreaterThan(0);
    expect(invocation.requestSha256).toBe('hash');
  }
  expect(store.job.inputVersionsJson).toBe('[{"v":"original"}]');
};

describe('AC-V1-04 Provider 全矩阵 — 真实 MockTextModelAdapter × createJobRunner', () => {
  it('401 MODEL_CREDENTIAL_INVALID — 不可重试，直接 FAILED，零版本，原始输入留存', async () => {
    const h = createMatrixHarness({
      steps: [{ kind: 'error', error: createMockModelError('MODEL_CREDENTIAL_INVALID') }],
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'MODEL_CREDENTIAL_INVALID',
      status: 'FAILED',
    });
    expect(h.store.job.status).toBe('FAILED');
    expect(h.store.invocations).toHaveLength(1);
    expect(h.store.versions).toHaveLength(0);
    assertInputPreserved(h.store);
  });

  it('429 MODEL_RATE_LIMITED — 两次重试内恢复 → SUCCEEDED，单版本且保留 Provider 任务 ID', async () => {
    const h = createMatrixHarness({
      steps: [
        { kind: 'error', error: createMockModelError('MODEL_RATE_LIMITED') },
        { kind: 'error', error: createMockModelError('MODEL_RATE_LIMITED') },
        { kind: 'success', rawText: '{"data":{"title":"candidate"}}' },
      ],
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
    expect(h.store.invocations.map((item) => item.attemptKind)).toEqual([
      'INITIAL',
      'TRANSPORT_RETRY',
      'TRANSPORT_RETRY',
    ]);
    expect(h.store.versions).toHaveLength(1);
    // Provider 任务 ID 在成功 Invocation 上留存，并与提交版本的来源 Invocation 对齐。
    const succeeded = h.store.invocations.find((item) => item.providerRequestId !== null);
    expect(succeeded?.providerRequestId).toBe('provider_task_3');
    expect(h.store.versions[0]).toMatchObject({ source_invocation_id: 'invocation_3' });
    assertInputPreserved(h.store);
  });

  it('5xx MODEL_PROVIDER_ERROR — 三次耗尽 → FAILED，终态不回退、不重复版本', async () => {
    const h = createMatrixHarness({
      steps: [
        { kind: 'error', error: createMockModelError('MODEL_PROVIDER_ERROR') },
        { kind: 'error', error: createMockModelError('MODEL_PROVIDER_ERROR') },
        { kind: 'error', error: createMockModelError('MODEL_PROVIDER_ERROR') },
      ],
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'MODEL_PROVIDER_ERROR',
      status: 'FAILED',
    });
    expect(h.store.invocations).toHaveLength(3);
    expect(h.store.versions).toHaveLength(0);
    expect(h.store.job.status).toBe('FAILED');
    // 终态不回退：再次 run 不重新领取、状态不变。
    await expect(h.runner.run('job_1')).resolves.toEqual({ status: 'NOT_CLAIMED' });
    expect(h.store.job.status).toBe('FAILED');
    assertInputPreserved(h.store);
  });

  it('120 秒超时 MODEL_TIMEOUT — 不可重试 → FAILED，注入等待器不真实等待', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const h = createMatrixHarness({
      steps: [{ kind: 'timeout', afterMs: 120_000 }],
      wait,
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'MODEL_TIMEOUT',
      status: 'FAILED',
    });
    expect(wait).toHaveBeenCalledWith(120_000, expect.any(AbortSignal));
    expect(h.store.invocations).toHaveLength(1);
    expect(h.store.versions).toHaveLength(0);
    assertInputPreserved(h.store);
  });

  it('非法 JSON → 结构修复成功 → SUCCEEDED，修复 Invocation 的新 Provider 任务 ID 入版本', async () => {
    const h = createMatrixHarness({
      steps: [
        { kind: 'invalid-json', rawText: '{' },
        { kind: 'success', rawText: '{"data":{"title":"fixed"}}' },
      ],
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
    expect(h.store.invocations.map((item) => item.attemptKind)).toEqual([
      'INITIAL',
      'STRUCTURE_REPAIR',
    ]);
    expect(h.events).toContain('repair-input:{');
    expect(h.store.versions).toHaveLength(1);
    // 不信任首次响应：提交版本来源于修复 Invocation（invocation_2 / provider_task_2）。
    expect(h.store.versions[0]).toMatchObject({ source_invocation_id: 'invocation_2' });
    const repaired = h.store.invocations[1];
    expect(repaired?.providerRequestId).toBe('provider_task_2');
    assertInputPreserved(h.store);
  });

  it('结构修复失败 → FAILED STRUCTURE_REPAIR_FAILED，零版本且原始输入不丢失', async () => {
    const h = createMatrixHarness({
      steps: [
        { kind: 'invalid-json', rawText: '{' },
        { kind: 'success', rawText: '{}' },
      ],
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'STRUCTURE_REPAIR_FAILED',
      status: 'FAILED',
    });
    expect(h.store.job.structureRepairAttempts).toBe(1);
    expect(h.store.versions).toHaveLength(0);
    assertInputPreserved(h.store);
  });

  it('STALE_INPUT（commit seam）— 提交被拒 → UoW 回滚，零版本、未 SUCCEEDED', async () => {
    const h = createMatrixHarness({
      steps: [{ kind: 'success', rawText: '{"data":{"title":"candidate"}}' }],
      commitStale: true,
    });
    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'STALE_INPUT',
      status: 'FAILED',
    });
    expect(h.store.versions).toHaveLength(0);
    expect(h.store.job).toMatchObject({ errorCode: 'STALE_INPUT', status: 'FAILED' });
    expect(h.events).toContain('tx:rollback');
    assertInputPreserved(h.store);
  });

  it('取消 + 迟到响应 — 保持 CANCELLED 终态，迟到响应只写 hash/late time，零版本', async () => {
    let generateEntered = false;
    let resolveBlock: (() => void) | undefined;
    const blockWait = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });
    const h = createMatrixHarness({
      steps: [{ kind: 'late-response', rawText: '{"data":{"late":true}}', afterMs: 10 }],
      wait: () => {
        generateEntered = true;
        return blockWait;
      },
    });
    const running = h.runner.run('job_1');
    await vi.waitFor(() => {
      expect(generateEntered).toBe(true);
    });
    await expect(h.runner.cancel('job_1')).resolves.toEqual({ status: 'CANCELLED' });
    resolveBlock?.();
    await expect(running).resolves.toEqual({ status: 'CANCELLED' });
    // 先持久化 CANCELLED 再 abort；迟到响应落迟到证据而非完整响应。
    expect(h.events.indexOf('cancel:persisted')).toBeLessThan(h.events.indexOf('abort'));
    expect(h.events).toContain('late-evidence');
    expect(h.store.versions).toHaveLength(0);
    expect(h.store.job.status).toBe('CANCELLED');
    expect(h.store.invocations[0]).toMatchObject({
      lateResponseAt: NOW,
      responseCompleteAt: null,
    });
    // 终态不回退：CANCELLED 后再 run 不重新领取。
    await expect(h.runner.run('job_1')).resolves.toEqual({ status: 'NOT_CLAIMED' });
    expect(h.store.job.status).toBe('CANCELLED');
  });
});

/** SHOT_CONTRACT 矩阵载荷：与 E2E 链上游对齐的镜头创意（char_lead / scene_train）。 */
const matrixShot = (targetDurationSec: number): Record<string, unknown> => ({
  acceptance: { must_include: ['夜行列车车厢'], must_not_include: [] },
  cinematography: {
    camera_angle: 'EYE_LEVEL',
    camera_motion: 'STATIC',
    composition: '中景，主体居左',
    focus: '人物面部清晰',
    frontal_face: true,
    mouth_visible: true,
    shot_size: 'MEDIUM',
  },
  content: {
    action: '主角在车厢内回望',
    character_ids: ['char_lead'],
    emotion: '警惕',
    prop_ids: [],
    scene_id: 'scene_train',
    spoken_text: '这趟列车要开往哪里？',
  },
  continuity: {
    continuity_mode: 'SCENE_CHANGE',
    first_frame_requirement: '车厢全景',
    last_frame_requirement: '人物回望',
  },
  dialogue: {
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    speaker_id: 'narrator',
  },
  generation_constraints: {
    capability_requirements: [{ capability: 'FIRST_FRAME', required: true }],
    image_prompt: '夜行列车车厢，冷色调，中景',
    negative_constraints: ['文字水印'],
    video_prompt: '镜头静止，人物轻微呼吸起伏',
  },
  narrative_purpose: '推进悬念',
  target_duration_sec: targetDurationSec,
});

const shotSetRawText = (shots: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ data: { shots: [...shots] } });

describe('AC-V1-04 Provider 矩阵 — SHOT_CONTRACT 分镜载荷（shot-contract-generation §4.2）', () => {
  it('集合级失败样本 — 候选结构合法但 Σ时长越界 → COLLECTION 层终态 FAILED，零版本且不可修复', async () => {
    // 10 镜 × 20s = 200s > 180s 上限；每镜 20s 仍在 ShotContract 1.1.0 的 1..20 内。
    const h = createMatrixHarness({
      contractKind: 'shot-set',
      stage: 'SHOT_CONTRACT',
      steps: [
        {
          kind: 'success',
          rawText: shotSetRawText(Array.from({ length: 10 }, () => matrixShot(20))),
        },
      ],
    });

    await expect(h.runner.run('job_1')).resolves.toEqual({
      errorCode: 'CONTRACT_VALIDATION_FAILED',
      status: 'FAILED',
    });
    // 集合层失败不属于可修复层（D3）：无 STRUCTURE_REPAIR Invocation，零版本。
    expect(h.store.invocations).toHaveLength(1);
    expect(h.store.invocations[0]).toMatchObject({ attemptKind: 'INITIAL' });
    expect(h.store.job.structureRepairAttempts).toBe(0);
    expect(h.store.versions).toHaveLength(0);
    // error_json 携带集合层错误码与层标识，供 Renderer 展示有界明细。
    const failure = JSON.parse(String(h.store.job.errorJson)) as {
      code?: unknown;
      layer?: unknown;
    };
    expect(failure).toMatchObject({ code: 'SHOT_SET_DURATION_OUT_OF_RANGE', layer: 'COLLECTION' });
    assertInputPreserved(h.store);
  });

  it('非法 JSON → 结构修复（数组信封载荷）→ SUCCEEDED，整集写入来源于修复 Invocation', async () => {
    const h = createMatrixHarness({
      contractKind: 'shot-set',
      stage: 'SHOT_CONTRACT',
      steps: [
        { kind: 'invalid-json', rawText: '{' },
        { kind: 'success', rawText: shotSetRawText([matrixShot(20), matrixShot(20)]) },
      ],
    });

    await expect(h.runner.run('job_1')).resolves.toEqual({ status: 'SUCCEEDED' });
    expect(h.store.invocations.map((item) => item.attemptKind)).toEqual([
      'INITIAL',
      'STRUCTURE_REPAIR',
    ]);
    expect(h.store.versions).toHaveLength(1);
    // 不信任首次响应：注入产物的 provenance 指向修复 Invocation。
    const committed = h.store.versions[0] as readonly {
      provenance: { source_invocation_id: string };
    }[];
    expect(committed).toHaveLength(2);
    expect(committed.map((shot) => shot.provenance.source_invocation_id)).toEqual([
      'invocation_2',
      'invocation_2',
    ]);
    assertInputPreserved(h.store);
  });
});
