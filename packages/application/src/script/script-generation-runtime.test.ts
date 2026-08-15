import { describe, expect, it, vi } from 'vitest';

import type { ScriptJobRepositories } from '../ports/script/index';
import type { TextModelPort } from '../ports/text-model/index';
import { createScriptGenerationRuntime } from './script-generation-runtime';

const createRuntime = (recoveryGate?: Promise<void>) => {
  const scans: string[] = [];
  const generate = vi.fn(() => Promise.reject(new Error('no queued job expected')));
  const repositories = {
    formatProfiles: {
      findCurrent: () => Promise.resolve({ id: 'format-0001', projectId: 'project-0001' }),
    },
    invocations: {
      listRecoveryEvidence: () => {
        scans.push('recovery:evidence');
        return Promise.resolve([]);
      },
    },
    jobs: {
      findByIdempotencyKey: () => Promise.resolve(null),
      insert: () => Promise.resolve(),
      listByStatuses: (statuses: readonly string[]) => {
        scans.push(statuses.length === 1 ? 'scheduler:queued' : 'recovery:pending');
        return statuses.length === 1
          ? Promise.resolve([])
          : (recoveryGate ?? Promise.resolve()).then(() => []);
      },
    },
    sourceInputs: {
      findCreativeByProjectId: () =>
        Promise.resolve({
          id: 'source-0001',
          projectId: 'project-0001',
          sha256: 's'.repeat(64),
        }),
    },
  } as unknown as ScriptJobRepositories;
  const textModel: TextModelPort = {
    generate,
    normalizeError: () => ({
      code: 'MODEL_UNKNOWN',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    }),
    validateCredential: () => Promise.resolve({ ok: true }),
  };
  const runtime = createScriptGenerationRuntime({
    createInvocationId: (sequence) => `invocation-${String(sequence)}`,
    createLeaseToken: () => 'lease-0001',
    finalSchemaId: () => 'script-stage-output/1.0.0',
    hashPayload: () => 'p'.repeat(64),
    hashText: () => 't'.repeat(64),
    loadPromptSnapshot: () =>
      Promise.resolve({
        candidateSchemaId: 'model-script-stage-candidate/1.0.0',
        promptTemplateId: 'concept/v1',
        systemPrompt: 'Return JSON.',
        userPayload: {},
      }),
    model: { id: 'qwen', providerProfileId: 'profile-0001', version: 'snapshot-1' },
    newId: () => 'id-0001',
    now: () => '2026-08-13T00:00:00.000Z',
    parameters: {},
    promptTemplateId: (stage) => `${stage.toLowerCase()}/v1`,
    textModel,
    unitOfWork: { run: (work) => work(repositories) },
    validateCandidate: () => ({ valid: true }),
    validateFinal: () => ({ valid: true }),
  });
  return { generate, runtime, scans };
};

describe('ScriptGenerationRuntime', () => {
  it('条件—启动生产运行时—先恢复持久化证据再 kick QUEUED 且无 pending 时不调用模型', async () => {
    const { generate, runtime, scans } = createRuntime();

    await runtime.start();
    await runtime.whenIdle();

    expect(scans).toEqual(['recovery:pending', 'recovery:evidence', 'scheduler:queued']);
    expect(generate).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('条件—恢复扫描尚未完成时提交新 Job—只记录 pending kick 且恢复后才允许领取', async () => {
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const { runtime, scans } = createRuntime(recoveryGate);

    const starting = runtime.start();
    await vi.waitFor(() => {
      expect(scans).toContain('recovery:pending');
    });
    await runtime.submission.submit(
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
    expect(scans).not.toContain('scheduler:queued');

    releaseRecovery?.();
    await starting;
    await runtime.whenIdle();
    expect(scans.indexOf('recovery:evidence')).toBeLessThan(scans.indexOf('scheduler:queued'));
    await runtime.stop();
  });

  it('条件—重复 start 与完成 stop—恢复仅执行一次且 stop 后拒绝重新激活', async () => {
    const { runtime, scans } = createRuntime();

    await Promise.all([runtime.start(), runtime.start()]);
    await runtime.whenIdle();
    await runtime.stop();

    expect(scans.filter((value) => value === 'recovery:pending')).toHaveLength(1);
    await expect(runtime.start()).rejects.toThrow('SCRIPT_RUNTIME_STOPPED');
  });
});
