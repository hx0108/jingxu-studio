import { describe, expect, it } from 'vitest';

import type { ScriptWorkspaceSnapshot } from '../ports/script/script-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type { NormalizedModelError } from '../ports/text-model/text-model-types';
import type {
  VoiceCandidateRecord,
  VoiceJobEvidenceEntry,
  VoiceJobRecord,
} from '../ports/voice/voice-generation-repository';
import { InMemoryVoiceGenerationRepository } from './in-memory-voice-generation-repository';
import {
  createVoiceGenerationScheduler,
  VOICE_INTERRUPTED_ERROR_CODE,
  type VoiceGenerationSchedulerDependencies,
} from './voice-generation-scheduler';

const NOW = '2026-08-27T00:00:00.000Z';
const PROJECT = 'project_00000001';
const NARRATOR_VOICE = 'Neil';
const MODEL_ID = 'qwen3-tts-instruct-flash';

/** 全量折叠假哈希（覆盖完整输入——截断读窗口会漏掉长 canonical 的尾部字段）。 */
const hashText = (text: string): string => {
  let low = 0;
  let high = 0;
  for (let index = 0; index < text.length; index += 1) {
    low = (low * 31 + text.charCodeAt(index)) % 1_000_000_007;
    high = (high * 37 + (text.charCodeAt(index) ^ index)) % 998_244_353;
  }
  return `${low.toString(16)}${high.toString(16)}`.padEnd(64, '0').slice(0, 64);
};
const hashPayload = (value: Readonly<Record<string, unknown>>): string => {
  const canonical = Object.keys(value)
    .sort()
    .map((key) => `${key}=${String(value[key])}`)
    .join('|');
  return hashText(canonical);
};

const shotDocument = (spokenText: string): string =>
  JSON.stringify({
    content: { spoken_text: spokenText },
    dialogue: {
      audio_required: spokenText.length > 0,
      dialogue_render_mode: 'NARRATION_FIRST',
      estimated_speech_duration_sec: 3,
      speaker_id: 'narrator',
    },
  });

const SHOT_A = { document: shotDocument('镜头A台词'), shotId: 'shot_a', versionId: 'shotv_a' };
const SHOT_B = { document: shotDocument('镜头B台词'), shotId: 'shot_b', versionId: 'shotv_b' };

const workspaceOf = (shots: readonly (typeof SHOT_A)[]): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: PROJECT,
  sourceInput: null,
  storyboard: {
    current: {
      createdAt: NOW,
      episodeId: 'episode_0001',
      formatProfileId: 'format_0001',
      id: 'epv_0000001',
      parentId: null,
      shotSetHash: hashText('shotset'),
      status: 'READY',
      storyBibleVersionId: 'sbv_0000001',
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: shots.map((shot, index) => ({
      sequence: index + 1,
      shotId: shot.shotId,
      version: {
        createdAt: NOW,
        dialogueRenderMode: 'NARRATION_FIRST',
        document: shot.document,
        documentSha256: hashText(shot.versionId),
        externalParentVersionId: null,
        formatProfileId: 'format_0001',
        id: shot.versionId,
        lineageResolutionStatus: 'ROOT',
        parentId: null,
        sequence: index + 1,
        shotId: shot.shotId,
        sourceInvocationId: null,
        targetDurationSec: 5,
        versionNo: 1,
        versionStatus: 'READY',
      },
    })),
    history: [],
    historyTruncated: false,
  },
  stages: [],
});

const queuedJob = (input: {
  id: string;
  shotIds: readonly string[];
  evidence?: readonly VoiceJobEvidenceEntry[];
  status?: VoiceJobRecord['status'];
}): VoiceJobRecord => ({
  createdAt: NOW,
  episodeId: 'episode_0001',
  evidence: input.evidence ?? [],
  id: input.id,
  projectId: PROJECT,
  requestId: `request_${input.id}`,
  skippedShots: [],
  status: input.status ?? 'QUEUED',
  targetShotIds: [...input.shotIds],
  updatedAt: NOW,
});

const pendingCandidate = (input: {
  id: string;
  jobId: string;
  shotId: string;
}): VoiceCandidateRecord => ({
  byteSize: null,
  createdAt: NOW,
  durationMs: null,
  errorCode: null,
  fileSha256: null,
  generationInputHash: hashText(`${input.shotId}:hash`),
  id: input.id,
  indexInRound: 0,
  jobId: input.jobId,
  mimeType: null,
  modelId: MODEL_ID,
  projectId: PROJECT,
  roundNo: 1,
  selectedAt: null,
  shotId: input.shotId,
  shotVersionId: `shotv_${input.shotId.slice(5)}`,
  speakerId: 'narrator',
  spokenTextSha256: hashText('spoken'),
  status: 'PENDING',
  storageRelPath: null,
  updatedAt: NOW,
  voiceId: NARRATOR_VOICE,
});

interface SynthesizeCall {
  readonly request: { modelId: string; spokenText: string; voiceId: string };
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  statusAtAbort: string | null;
}

const normalizeError = (error: unknown): NormalizedModelError => {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'MODEL_CANCELLED',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    };
  }
  if (error instanceof Error && error.message === 'INJECTED_PROVIDER_FAILURE') {
    return {
      code: 'MODEL_UNKNOWN',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    };
  }
  return {
    code: 'MODEL_UNKNOWN',
    detail: null,
    providerRequestId: null,
    retryable: false,
    userAction: null,
  };
};

const createHarness = (
  options: {
    registerAudioError?: boolean;
    shots?: readonly (typeof SHOT_A)[];
  } = {},
) => {
  const repositories = new InMemoryVoiceGenerationRepository();
  const calls: SynthesizeCall[] = [];
  const workspaceQuery: ScriptWorkspaceQueryPort = {
    getWorkspace: () => Promise.resolve(workspaceOf(options.shots ?? [SHOT_A, SHOT_B])),
    getVersionDocument: () => Promise.resolve(null),
  };
  const dependencies: VoiceGenerationSchedulerDependencies = {
    clock: () => NOW,
    hashPayload,
    hashText,
    mappings: {
      resolveEffectiveMappings: () => Promise.resolve(new Map([['narrator', NARRATOR_VOICE]])),
    },
    model: { resolveModel: () => Promise.resolve({ modelId: MODEL_ID }) },
    newId: (() => {
      let counter = 0;
      return () => `vcan_${String((counter += 1)).padStart(4, '0')}`;
    })(),
    registerAudio: (payload) =>
      options.registerAudioError === true
        ? Promise.reject(new Error('registration failed'))
        : Promise.resolve({
            byteSize: payload.bytes.length,
            durationMs: 1_500,
            fileSha256: hashText('audio-bytes'),
            mimeType: payload.mimeType === 'audio/wav' ? 'audio/wav' : 'audio/mpeg',
            storageRelPath: 'projects/p/audio/aa/hash.mp3',
          }),
    repositories,
    synthesize: (request, signal) =>
      new Promise((resolve, reject) => {
        const call: SynthesizeCall = {
          reject,
          request,
          resolve: (bytes) => {
            resolve({
              audio: { bytes, mimeType: 'audio/mpeg' },
              httpStatus: 200,
              providerRequestId: null,
              usage: null,
            });
          },
          signal,
          statusAtAbort: null,
        };
        signal.addEventListener('abort', () => {
          call.statusAtAbort = repositories.jobs[0]?.status ?? null;
        });
        calls.push(call);
      }),
    normalizeError,
    workspaceQuery,
  };
  return { calls, repositories, scheduler: createVoiceGenerationScheduler(dependencies) };
};

/** 确定性等待第 index 次 synthesize 调用在飞（调度链异步推进）。 */
const waitForCall = async (
  harness: ReturnType<typeof createHarness>,
  index: number,
): Promise<SynthesizeCall> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const call = harness.calls[index];
    if (call !== undefined) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`synthesize call ${String(index)} never arrived`);
};

describe('VoiceGenerationScheduler（tasks 4.2，design D2）', () => {
  it('串行排空—两镜头两段式证据有序、候选带登记四元组、job COMPLETED', async () => {
    const harness = createHarness();
    await harness.repositories.insertJob(
      queuedJob({ id: 'job_1', shotIds: [SHOT_A.shotId, SHOT_B.shotId] }),
    );
    harness.scheduler.kick(PROJECT);
    // 手动依次放行两次同步调用（模拟 Provider 返回）。
    (await waitForCall(harness, 0)).resolve(new Uint8Array([1, 2, 3]));
    (await waitForCall(harness, 1)).resolve(new Uint8Array([4, 5, 6]));
    await harness.scheduler.whenSettled(PROJECT);
    const job = harness.repositories.jobs[0];
    expect(job?.status).toBe('COMPLETED');
    expect(job?.evidence.map((entry) => `${entry.shotId}:${entry.outcome}`)).toEqual([
      `${SHOT_A.shotId}:STARTED`,
      `${SHOT_A.shotId}:SUCCEEDED`,
      `${SHOT_B.shotId}:STARTED`,
      `${SHOT_B.shotId}:SUCCEEDED`,
    ]);
    expect(harness.repositories.candidates).toHaveLength(2);
    const first = harness.repositories.candidates[0];
    expect(first?.status).toBe('SUCCEEDED');
    expect(first?.durationMs).toBe(1_500);
    expect(first?.fileSha256).toBe(hashText('audio-bytes'));
    expect(first?.voiceId).toBe(NARRATOR_VOICE);
    expect(first?.roundNo).toBe(1);
    expect(harness.repositories.candidates[1]?.roundNo).toBe(1);
    expect(harness.calls.map((call) => call.request.spokenText)).toEqual([
      '镜头A台词',
      '镜头B台词',
    ]);
  });

  it('单镜头失败不阻断—失败候选稳定错误码、job PARTIAL_COMPLETED', async () => {
    const harness = createHarness();
    await harness.repositories.insertJob(
      queuedJob({ id: 'job_1', shotIds: [SHOT_A.shotId, SHOT_B.shotId] }),
    );
    harness.scheduler.kick(PROJECT);
    (await waitForCall(harness, 0)).reject(new Error('INJECTED_PROVIDER_FAILURE'));
    (await waitForCall(harness, 1)).resolve(new Uint8Array([9]));
    await harness.scheduler.whenSettled(PROJECT);
    const job = harness.repositories.jobs[0];
    expect(job?.status).toBe('PARTIAL_COMPLETED');
    const failed = harness.repositories.candidates.find((row) => row.shotId === SHOT_A.shotId);
    const succeeded = harness.repositories.candidates.find((row) => row.shotId === SHOT_B.shotId);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.errorCode).toBe('MODEL_UNKNOWN');
    expect(succeeded?.status).toBe('SUCCEEDED');
  });

  it('取消先落库—CANCELLED 状态先于 abort 到达、在飞归一 MODEL_CANCELLED、剩余镜头不执行', async () => {
    const harness = createHarness();
    await harness.repositories.insertJob(
      queuedJob({ id: 'job_1', shotIds: [SHOT_A.shotId, SHOT_B.shotId] }),
    );
    harness.scheduler.kick(PROJECT);
    // 等待首个调用在飞（STARTED 证据已落库）。
    await waitForCall(harness, 0);
    await harness.scheduler.cancel(PROJECT);
    expect(harness.repositories.jobs[0]?.status).toBe('CANCELLED');
    // abort 触发时状态已为 CANCELLED（先落库再中止在飞）。
    expect(harness.calls[0]?.statusAtAbort).toBe('CANCELLED');
    // 在飞请求以 AbortError 收尾 → 候选 FAILED/MODEL_CANCELLED；shot_b 不再执行。
    const abortError = new Error('已取消');
    abortError.name = 'AbortError';
    harness.calls[0]?.reject(abortError);
    await harness.scheduler.whenSettled(PROJECT);
    expect(harness.calls).toHaveLength(1);
    expect(harness.repositories.candidates[0]?.status).toBe('FAILED');
    expect(harness.repositories.candidates[0]?.errorCode).toBe('MODEL_CANCELLED');
  });

  it('恢复只信证据—无终态证据候选标中断失败不重发；未开始镜头续跑', async () => {
    const harness = createHarness();
    // 模拟崩溃现场：RUNNING job，shot_a 有 STARTED 证据 + PENDING 候选，shot_b 未开始。
    await harness.repositories.insertJob(
      queuedJob({
        evidence: [
          { at: NOW, candidateId: 'vcan_crash', outcome: 'STARTED', shotId: SHOT_A.shotId },
        ],
        id: 'job_crash',
        shotIds: [SHOT_A.shotId, SHOT_B.shotId],
        status: 'RUNNING',
      }),
    );
    await harness.repositories.insertCandidate(
      pendingCandidate({ id: 'vcan_crash', jobId: 'job_crash', shotId: SHOT_A.shotId }),
    );
    await harness.scheduler.recover(PROJECT);
    const interrupted = harness.repositories.candidates.find((row) => row.id === 'vcan_crash');
    expect(interrupted?.status).toBe('FAILED');
    expect(interrupted?.errorCode).toBe(VOICE_INTERRUPTED_ERROR_CODE);
    const jobAfterRecover = harness.repositories.jobs[0];
    expect(
      jobAfterRecover?.evidence.some(
        (entry) => entry.outcome === 'INTERRUPTED' && entry.shotId === SHOT_A.shotId,
      ),
    ).toBe(true);
    // 续跑：仅 shot_b 发起 Provider 请求（shot_a 不自动重发）。
    harness.scheduler.kick(PROJECT);
    (await waitForCall(harness, 0)).resolve(new Uint8Array([1]));
    await harness.scheduler.whenSettled(PROJECT);
    expect(harness.calls.map((call) => call.request.spokenText)).toEqual(['镜头B台词']);
    expect(harness.repositories.jobs[0]?.status).toBe('PARTIAL_COMPLETED');
  });

  it('登记失败（ffprobe/CAS 异常）—候选 FAILED 且不阻断后续镜头', async () => {
    const harness = createHarness({ registerAudioError: true });
    await harness.repositories.insertJob(queuedJob({ id: 'job_1', shotIds: [SHOT_A.shotId] }));
    harness.scheduler.kick(PROJECT);
    (await waitForCall(harness, 0)).resolve(new Uint8Array([1]));
    await harness.scheduler.whenSettled(PROJECT);
    const candidate = harness.repositories.candidates[0];
    expect(candidate?.status).toBe('FAILED');
    expect(candidate?.errorCode).toBe('MODEL_UNKNOWN');
    expect(harness.repositories.jobs[0]?.status).toBe('PARTIAL_COMPLETED');
  });

  it('kick 幂等—链已在跑不重复排空', async () => {
    const harness = createHarness();
    await harness.repositories.insertJob(queuedJob({ id: 'job_1', shotIds: [SHOT_A.shotId] }));
    harness.scheduler.kick(PROJECT);
    harness.scheduler.kick(PROJECT);
    (await waitForCall(harness, 0)).resolve(new Uint8Array([1]));
    await harness.scheduler.whenSettled(PROJECT);
    expect(harness.calls).toHaveLength(1);
    expect(harness.repositories.jobs).toHaveLength(1);
    expect(harness.repositories.jobs[0]?.status).toBe('COMPLETED');
  });
});
