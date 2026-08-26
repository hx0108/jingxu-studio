import { describe, expect, it } from 'vitest';

import type { ScriptWorkspaceSnapshot } from '../ports/script/script-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type { VoiceCandidateRecord } from '../ports/voice/voice-generation-repository';
import { InMemoryVoiceGenerationRepository } from './in-memory-voice-generation-repository';
import { computeVoiceGenerationInputHash } from './voice-generation-input';
import {
  createVoiceGenerationService,
  type VoiceGenerationServiceDependencies,
} from './voice-generation-service';

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

const shotDocument = (input: {
  audioRequired: boolean;
  speakerId: string | null;
  spokenText: string;
}): string =>
  JSON.stringify({
    content: { spoken_text: input.spokenText },
    dialogue: {
      audio_required: input.audioRequired,
      dialogue_render_mode: input.audioRequired ? 'NARRATION_FIRST' : 'SUBTITLE_ONLY',
      estimated_speech_duration_sec: 3,
      speaker_id: input.speakerId,
    },
  });

interface ShotFixture {
  readonly document: string;
  readonly shotId: string;
  readonly versionId: string;
}

const NARRATION: ShotFixture = {
  document: shotDocument({ audioRequired: true, speakerId: 'narrator', spokenText: '雨巷开场' }),
  shotId: 'shot_narration',
  versionId: 'shotv_narration',
};
const CHARACTER: ShotFixture = {
  document: shotDocument({ audioRequired: true, speakerId: 'char_hero', spokenText: '主角台词' }),
  shotId: 'shot_character',
  versionId: 'shotv_character',
};
const SUBTITLE_ONLY: ShotFixture = {
  document: shotDocument({ audioRequired: false, speakerId: null, spokenText: '仅字幕' }),
  shotId: 'shot_subtitle',
  versionId: 'shotv_subtitle',
};
const EMPTY_SPOKEN: ShotFixture = {
  document: shotDocument({ audioRequired: true, speakerId: 'narrator', spokenText: '' }),
  shotId: 'shot_empty',
  versionId: 'shotv_empty',
};

const workspaceOf = (shots: readonly ShotFixture[]): ScriptWorkspaceSnapshot => ({
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

interface Harness {
  readonly kicks: string[];
  readonly repositories: InMemoryVoiceGenerationRepository;
  readonly service: ReturnType<typeof createVoiceGenerationService>;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

const createHarness = (
  shots: readonly ShotFixture[],
  options: {
    effective?: ReadonlyMap<string, string>;
    credentialReady?: boolean;
  } = {},
): Harness => {
  const repositories = new InMemoryVoiceGenerationRepository();
  const kicks: string[] = [];
  const workspaceQuery: ScriptWorkspaceQueryPort = {
    getWorkspace: () => Promise.resolve(workspaceOf(shots)),
    getVersionDocument: () => Promise.resolve(null),
  };
  const dependencies: VoiceGenerationServiceDependencies = {
    assertCredentialReady:
      options.credentialReady === false
        ? () => Promise.reject(new Error('credential unavailable'))
        : () => Promise.resolve(),
    clock: () => NOW,
    hashPayload,
    hashText,
    mappings: {
      resolveEffectiveMappings: () =>
        Promise.resolve(options.effective ?? new Map([['narrator', NARRATOR_VOICE]])),
    },
    model: { resolveModel: () => Promise.resolve({ modelId: MODEL_ID }) },
    newId: (() => {
      let counter = 0;
      return () => `voicejob_${String((counter += 1)).padStart(4, '0')}`;
    })(),
    repositories,
    scheduler: { kick: (projectId) => void kicks.push(projectId) },
    workspaceQuery,
  };
  return {
    kicks,
    repositories,
    service: createVoiceGenerationService(dependencies),
    workspaceQuery,
  };
};

const episodeInput = (shotIds: readonly string[], requestId = 'request_voice_0001') => ({
  episodeId: 'episode_0001',
  projectId: PROJECT,
  requestId,
  shotIds: [...shotIds],
});

const succeededCandidate = (input: {
  generationInputHash: string;
  shotId: string;
  shotVersionId: string;
  voiceId?: string;
}): VoiceCandidateRecord => ({
  byteSize: 2_048,
  createdAt: NOW,
  durationMs: 1_500,
  errorCode: null,
  fileSha256: 'f'.repeat(64),
  generationInputHash: input.generationInputHash,
  id: `vc_${input.shotId}`,
  indexInRound: 0,
  jobId: 'voicejob_prior',
  mimeType: 'audio/mpeg',
  modelId: MODEL_ID,
  projectId: PROJECT,
  roundNo: 1,
  selectedAt: NOW,
  shotId: input.shotId,
  shotVersionId: input.shotVersionId,
  speakerId: 'narrator',
  spokenTextSha256: hashText('spoken'),
  status: 'SUCCEEDED',
  storageRelPath: 'projects/p/audio/ff/xxx.mp3',
  updatedAt: NOW,
  voiceId: input.voiceId ?? NARRATOR_VOICE,
});

describe('VoiceGenerationService（tasks 4.2，spec R2/R3）', () => {
  it('整集批量建档—仅 audio_required 且有台词镜头入目标，跳过清单如实回告', async () => {
    const harness = createHarness([NARRATION, SUBTITLE_ONLY, EMPTY_SPOKEN]);
    const result = await harness.service.generateForEpisode(
      episodeInput([NARRATION.shotId, SUBTITLE_ONLY.shotId, EMPTY_SPOKEN.shotId]),
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.targetShotIds).toEqual([NARRATION.shotId]);
    expect(result.data.skippedShots).toEqual([
      { reason: 'NOT_VOICE_TARGET', shotId: SUBTITLE_ONLY.shotId },
      { reason: 'NOT_VOICE_TARGET', shotId: EMPTY_SPOKEN.shotId },
    ]);
    // 建档零失败记录（证据空），kick 已触发。
    expect(harness.repositories.jobs).toHaveLength(1);
    expect(harness.repositories.jobs[0]?.evidence).toEqual([]);
    expect(harness.kicks).toEqual([PROJECT]);
  });

  it('同 requestId 重试—一致回执且不重复建档；目标集合漂移 REQUEST_ID_REUSED', async () => {
    const harness = createHarness([NARRATION, CHARACTER], {
      effective: new Map([
        ['narrator', NARRATOR_VOICE],
        ['char_hero', 'Stella'],
      ]),
    });
    const first = await harness.service.generateForEpisode(
      episodeInput([NARRATION.shotId, CHARACTER.shotId]),
      'trace_1',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // kick 为 spy（无真实调度）——手动终态化第一个 job 以解除同项目单飞闸。
    await harness.repositories.markJobRunning(first.data.batchId, NOW);
    await harness.repositories.finalizeJob(first.data.batchId, 'COMPLETED', NOW);
    const replay = await harness.service.generateForEpisode(
      episodeInput([CHARACTER.shotId, NARRATION.shotId]),
      'trace_2',
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.batchId).toBe(first.data.batchId);
    expect(harness.repositories.jobs).toHaveLength(1);
    const drift = await harness.service.generateForEpisode(
      episodeInput([NARRATION.shotId], 'request_voice_0002'),
      'trace_3',
    );
    expect(drift.ok).toBe(true);
    const reused = await harness.service.generateForEpisode(
      episodeInput([CHARACTER.shotId]),
      'trace_4',
    );
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe('REQUEST_ID_REUSED');
    expect(harness.repositories.jobs).toHaveLength(2);
  });

  it('映射缺口—整批阻断 VOICE_MAPPING_MISSING 且零 job 行零 Provider 请求', async () => {
    const harness = createHarness([CHARACTER], {
      effective: new Map([['narrator', NARRATOR_VOICE]]),
    });
    const result = await harness.service.generateForEpisode(
      episodeInput([CHARACTER.shotId]),
      'trace_1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VOICE_MAPPING_MISSING');
    expect(result.error.message).toContain('char_hero');
    expect(harness.repositories.jobs).toHaveLength(0);
    expect(harness.kicks).toHaveLength(0);
  });

  it('凭据未配置—先于建批稳定失败 VOICE_PROVIDER_NOT_CONFIGURED', async () => {
    const harness = createHarness([NARRATION], { credentialReady: false });
    const result = await harness.service.generateForEpisode(episodeInput([NARRATION.shotId]), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VOICE_PROVIDER_NOT_CONFIGURED');
    expect(harness.repositories.jobs).toHaveLength(0);
  });

  it('当前世代已有 SUCCEEDED 候选—ALREADY_GENERATED 跳过；全部跳过回稳定错误', async () => {
    const harness = createHarness([NARRATION]);
    await harness.repositories.insertCandidate(
      succeededCandidate({
        generationInputHash: computeVoiceGenerationInputHash(
          {
            modelId: MODEL_ID,
            shotVersionId: NARRATION.versionId,
            spokenTextSha256: hashText('雨巷开场'),
            voiceId: NARRATOR_VOICE,
          },
          hashPayload,
        ),
        shotId: NARRATION.shotId,
        shotVersionId: NARRATION.versionId,
      }),
    );
    const result = await harness.service.generateForEpisode(episodeInput([NARRATION.shotId]), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MEDIA_BATCH_NO_PENDING_SHOTS');
    expect(harness.repositories.jobs).toHaveLength(0);
    const withFresh = createHarness([NARRATION, CHARACTER], {
      effective: new Map([
        ['narrator', NARRATOR_VOICE],
        ['char_hero', 'Stella'],
      ]),
    });
    await withFresh.repositories.insertCandidate(
      succeededCandidate({
        generationInputHash: computeVoiceGenerationInputHash(
          {
            modelId: MODEL_ID,
            shotVersionId: NARRATION.versionId,
            spokenTextSha256: hashText('雨巷开场'),
            voiceId: NARRATOR_VOICE,
          },
          hashPayload,
        ),
        shotId: NARRATION.shotId,
        shotVersionId: NARRATION.versionId,
      }),
    );
    const mixed = await withFresh.service.generateForEpisode(
      episodeInput([NARRATION.shotId, CHARACTER.shotId]),
      't',
    );
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.data.targetShotIds).toEqual([CHARACTER.shotId]);
    expect(mixed.data.skippedShots).toEqual([
      { reason: 'ALREADY_GENERATED', shotId: NARRATION.shotId },
    ]);
  });

  it('工作区未初始化/镜头不在集合—各自稳定拒绝', async () => {
    const uninitializedService = createVoiceGenerationService({
      assertCredentialReady: () => Promise.resolve(),
      clock: () => NOW,
      hashPayload,
      hashText,
      mappings: { resolveEffectiveMappings: () => Promise.resolve(new Map()) },
      model: { resolveModel: () => Promise.resolve({ modelId: MODEL_ID }) },
      newId: () => 'x',
      repositories: new InMemoryVoiceGenerationRepository(),
      scheduler: { kick: () => undefined },
      workspaceQuery: {
        getWorkspace: () => Promise.resolve(null),
        getVersionDocument: () => Promise.resolve(null),
      },
    });
    const uninitialized = await uninitializedService.generateForEpisode(
      episodeInput([NARRATION.shotId]),
      't',
    );
    expect(uninitialized.ok).toBe(false);
    if (uninitialized.ok) return;
    expect(uninitialized.error.code).toBe('SCRIPT_WORKSPACE_NOT_INITIALIZED');

    const missing = createHarness([NARRATION]);
    const notInSet = await missing.service.generateForEpisode(episodeInput(['shot_unknown']), 't');
    expect(notInSet.ok).toBe(false);
    if (notInSet.ok) return;
    expect(notInSet.error.code).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
  });

  it('getGenerations—镜头改文后旧 SUCCEEDED 候选惰性标记 STALE_INPUT 且不可试听', async () => {
    const harness = createHarness([NARRATION]);
    // 旧候选冻结在旧版本/旧文本哈希上。
    await harness.repositories.insertCandidate(
      succeededCandidate({
        generationInputHash: 'c'.repeat(64),
        shotId: NARRATION.shotId,
        shotVersionId: 'shotv_old',
      }),
    );
    const result = await harness.service.getGenerations(
      { projectId: PROJECT, shotId: NARRATION.shotId },
      't',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.status).toBe('STALE_INPUT');
    expect(result.data[0]?.mediaUrl).toBeNull();
    // 持久层已迁移（第二次读取前已是 STALE，不再重复标记）。
    expect(harness.repositories.candidates[0]?.status).toBe('STALE_INPUT');
  });

  it('selectCandidate—成功落位并清旧指针；STALE/FAILED/不存在各自稳定拒绝', async () => {
    const harness = createHarness([NARRATION]);
    const current = succeededCandidate({
      generationInputHash: 'd'.repeat(64),
      shotId: NARRATION.shotId,
      shotVersionId: NARRATION.versionId,
    });
    const newer: VoiceCandidateRecord = {
      ...current,
      id: 'vc_new',
      roundNo: 2,
      selectedAt: null,
    };
    await harness.repositories.insertCandidate(current);
    await harness.repositories.insertCandidate(newer);
    const selected = await harness.service.selectCandidate(
      { candidateId: 'vc_new', projectId: PROJECT, requestId: 'request_sel_0001' },
      't',
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const selectedRow = selected.data.find((row) => row.id === 'vc_new');
    const oldRow = selected.data.find((row) => row.id === current.id);
    expect(selectedRow?.selectedAt).toBe(NOW);
    expect(oldRow?.selectedAt).toBeNull();

    await harness.repositories.markCandidatesStale([current.id], NOW);
    const stale = await harness.service.selectCandidate(
      { candidateId: current.id, projectId: PROJECT, requestId: 'request_sel_0002' },
      't',
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('VOICE_CANDIDATE_STALE');

    const failed: VoiceCandidateRecord = {
      ...newer,
      id: 'vc_failed',
      roundNo: 3,
      status: 'FAILED',
      errorCode: 'MODEL_UNKNOWN',
    };
    await harness.repositories.insertCandidate(failed);
    const notSelectable = await harness.service.selectCandidate(
      { candidateId: 'vc_failed', projectId: PROJECT, requestId: 'request_sel_0003' },
      't',
    );
    expect(notSelectable.ok).toBe(false);
    if (notSelectable.ok) return;
    expect(notSelectable.error.code).toBe('MEDIA_CANDIDATE_NOT_SELECTABLE');

    const absent = await harness.service.selectCandidate(
      { candidateId: 'vc_absent', projectId: PROJECT, requestId: 'request_sel_0004' },
      't',
    );
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.error.code).toBe('MEDIA_CANDIDATE_NOT_FOUND');
  });

  it('deleteCandidate—非 PENDING 删除仅删登记；PENDING 稳定拒绝', async () => {
    const harness = createHarness([NARRATION]);
    const candidate = succeededCandidate({
      generationInputHash: 'e'.repeat(64),
      shotId: NARRATION.shotId,
      shotVersionId: NARRATION.versionId,
    });
    await harness.repositories.insertCandidate(candidate);
    const removed = await harness.service.deleteCandidate(
      { candidateId: candidate.id, projectId: PROJECT, requestId: 'request_del_0001' },
      't',
    );
    expect(removed.ok).toBe(true);
    expect(harness.repositories.candidates).toHaveLength(0);

    const pending: VoiceCandidateRecord = {
      ...candidate,
      id: 'vc_pending',
      byteSize: null,
      durationMs: null,
      fileSha256: null,
      mimeType: null,
      status: 'PENDING',
      storageRelPath: null,
    };
    await harness.repositories.insertCandidate(pending);
    const guarded = await harness.service.deleteCandidate(
      { candidateId: 'vc_pending', projectId: PROJECT, requestId: 'request_del_0002' },
      't',
    );
    expect(guarded.ok).toBe(false);
    if (guarded.ok) return;
    expect(guarded.error.code).toBe('IPC_INVALID_REQUEST');
  });

  it('活跃 job 存在—重复建批 MEDIA_BATCH_ALREADY_RUNNING', async () => {
    const harness = createHarness([NARRATION, CHARACTER], {
      effective: new Map([
        ['narrator', NARRATOR_VOICE],
        ['char_hero', 'Stella'],
      ]),
    });
    const first = await harness.service.generateForEpisode(
      episodeInput([NARRATION.shotId]),
      'request_a',
    );
    expect(first.ok).toBe(true);
    const second = await harness.service.generateForEpisode(
      episodeInput([CHARACTER.shotId], 'request_b'),
      't',
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('MEDIA_BATCH_ALREADY_RUNNING');
  });
});
