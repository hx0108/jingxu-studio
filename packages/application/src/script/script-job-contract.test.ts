import { describe, expect, it, vi } from 'vitest';

import type { ScriptStageJob } from '../ports/persistence/job/index';
import type { ScriptJobRepositories } from '../ports/script/index';
import { buildScriptCandidateContract, createScriptCommitHandler } from './script-job-contract';
import type { ShotCollectionStoryBibleIds } from './shot-collection-validator';

describe('buildScriptCandidateContract', () => {
  it('条件—模型候选含伪造系统字段—只保留 data 并注入受信元数据', () => {
    const validateCandidate = vi.fn(() => ({ valid: true as const }));
    const validateFinal = vi.fn(() => ({ valid: true as const }));
    const job = {
      episodeId: 'episode-0001',
      projectId: 'project-0001',
      stage: 'SCENE_SCRIPT',
    } as ScriptStageJob;
    const contract = buildScriptCandidateContract(job, 'invocation-0001', {
      newId: () => 'generated-id',
      validateCandidate,
      validateFinal,
    });
    const candidate = {
      data: { scenes: [] },
      project_id: 'forged-project',
      schema_version: 'forged',
      source_invocation_id: 'forged-invocation',
    };

    expect(contract.validateCandidate(candidate)).toEqual({ valid: true });
    const finalValue = contract.injectSystemFields(candidate);
    expect(finalValue).toEqual({
      data: candidate.data,
      episode_id: 'episode-0001',
      project_id: 'project-0001',
      schema_version: '1.0.0',
      source_invocation_id: 'invocation-0001',
      stage: 'SCENE_SCRIPT',
    });
    expect(contract.validateFinal(finalValue)).toEqual({ valid: true });
    expect(validateCandidate).toHaveBeenCalledWith(candidate);
    expect(validateFinal).toHaveBeenCalledWith(finalValue);
  });

  it('条件—候选没有 data 根—系统字段注入稳定失败且不调用正式 validator', () => {
    const validateFinal = vi.fn(() => ({ valid: true as const }));
    const contract = buildScriptCandidateContract(
      { episodeId: null, projectId: 'project-0001', stage: 'CONCEPT' } as ScriptStageJob,
      'invocation-0001',
      { newId: () => 'generated-id', validateCandidate: () => ({ valid: true }), validateFinal },
    );

    expect(() => contract.injectSystemFields({ title: 'missing data' })).toThrow(
      'SYSTEM_FIELD_INJECTION_FAILED',
    );
    expect(validateFinal).not.toHaveBeenCalled();
  });
});

// ---- SHOT_CONTRACT（design.md D1/D2/D5）----

const shotJob = {
  episodeId: 'episode-0001',
  id: 'job-shot-0001',
  inputVersionsJson: JSON.stringify({
    references: [
      { objectId: 'scene-0001', objectType: 'SCRIPT_VERSION', versionId: 'scene-0001' },
      { objectId: 'story-0001', objectType: 'STORY_BIBLE_VERSION', versionId: 'story-0001' },
      { objectId: 'outline-0001', objectType: 'SCRIPT_VERSION', versionId: 'outline-0001' },
      { objectId: 'format-0001', objectType: 'FORMAT_PROFILE', versionId: 'format-0001' },
    ],
  }),
  projectId: 'project-0001',
  stage: 'SHOT_CONTRACT',
  userOperationId: 'op-0001',
} as unknown as ScriptStageJob;

const creativeShot = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  acceptance: { must_include: [], must_not_include: [] },
  cinematography: {
    camera_angle: 'EYE_LEVEL',
    camera_motion: 'STATIC',
    composition: '中心构图',
    focus: '角色面部',
    frontal_face: true,
    mouth_visible: true,
    shot_size: 'MEDIUM',
  },
  content: {
    action: '角色走入房间',
    character_ids: ['char_a'],
    emotion: '平静',
    prop_ids: [],
    scene_id: 'scene_a',
    spoken_text: '',
  },
  continuity: {
    continuity_mode: 'SCENE_CHANGE',
    first_frame_requirement: '门口',
    last_frame_requirement: '桌前',
  },
  dialogue: {
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 0,
    speaker_id: null,
  },
  generation_constraints: {
    capability_requirements: [],
    image_prompt: '首帧',
    negative_constraints: [],
    video_prompt: '运镜',
  },
  narrative_purpose: '开场建立空间',
  target_duration_sec: 12,
  ...overrides,
});

const shotContract = (shotCollection: ShotCollectionStoryBibleIds | null) => {
  let sequence = 0;
  return buildScriptCandidateContract(shotJob, 'invocation-shot-0001', {
    newId: () => {
      sequence += 1;
      return `id${String(sequence)}`;
    },
    shotCollection,
    validateCandidate: () => ({ valid: true }),
    validateFinal: () => ({ valid: true }),
  });
};

describe('buildScriptCandidateContract(SHOT_CONTRACT)', () => {
  it('条件—候选 shots 数组—逐镜头注入受信标识并按 sequence 派生 previous_shot_id', () => {
    const contract = shotContract({ characterIds: ['char_a'], sceneIds: ['scene_a'] });
    const documents = contract.injectSystemFields({
      data: {
        shots: [
          creativeShot(),
          creativeShot({
            continuity: {
              continuity_mode: 'CONTINUOUS_ACTION',
              first_frame_requirement: '同上',
              last_frame_requirement: '同上',
            },
          }),
          creativeShot(),
        ],
      },
    }) as readonly Readonly<Record<string, unknown>>[];

    expect(documents).toHaveLength(3);
    // 工厂调用序：三个 shot_id 先生成（id1..id3），随后逐镜头 version_id（id4..id6）。
    expect(documents[0]).toMatchObject({
      format_profile_id: 'format-0001',
      schema_version: '1.1.0',
      sequence: 1,
      shot_id: 'shot_id1',
      version_id: 'scv_id4_v1',
    });
    expect((documents[1]?.continuity as Readonly<Record<string, unknown>>).previous_shot_id).toBe(
      'shot_id1',
    );
    expect(
      (documents[0]?.continuity as Readonly<Record<string, unknown>>).previous_shot_id,
    ).toBeNull();
    expect(contract.validateCollection(documents)).toEqual({ valid: true });
  });

  it('条件—集合含未收录角色/时长越界—COLLECTION 层给出稳定失败码', () => {
    const contract = shotContract({ characterIds: ['char_a'], sceneIds: ['scene_a'] });
    const candidate = {
      data: {
        shots: [
          creativeShot({ target_duration_sec: 5 }),
          creativeShot({ target_duration_sec: 5 }),
          creativeShot({ target_duration_sec: 5 }),
        ],
      },
    };

    const shortSet = contract.injectSystemFields(candidate) as readonly unknown[];
    expect(contract.validateCollection(shortSet)).toMatchObject({
      code: 'SHOT_SET_DURATION_OUT_OF_RANGE',
      valid: false,
    });

    const unknownCharacter = contract.injectSystemFields({
      data: { shots: [creativeShot(), creativeShot(), creativeShot()] },
    }) as readonly Readonly<Record<string, unknown>>[];
    // 候选校验先于注入：这里直接构造含未收录角色的注入产物验证集合层。
    const forged = unknownCharacter.map((document, index) =>
      index === 0
        ? {
            ...document,
            content: {
              ...(document.content as Readonly<Record<string, unknown>>),
              character_ids: ['char_missing'],
            },
          }
        : document,
    );
    expect(contract.validateCollection(forged)).toMatchObject({
      code: 'SHOT_SET_CHARACTER_UNKNOWN',
      valid: false,
    });
  });

  it('条件—冻结 STORY_BIBLE 读取失败（shotCollection null）—集合层返回 STALE_INPUT', () => {
    const contract = shotContract(null);
    expect(contract.validateCollection([])).toEqual({ code: 'STALE_INPUT', valid: false });
  });
});

describe('createScriptCommitHandler(SHOT_CONTRACT)', () => {
  const shotDocument = (sequence: number, shotId: string, versionId: string) => ({
    dialogue: { dialogue_render_mode: 'NARRATION_FIRST', speaker_id: 'narrator' },
    format_profile_id: 'format-0001',
    provenance: { source_invocation_id: 'invocation-shot-0001' },
    sequence,
    shot_id: shotId,
    target_duration_sec: 30,
    version_id: versionId,
  });

  it('条件—整集集合通过校验—单事务写入四表 + EPISODE_VERSION head + 三条血缘边', async () => {
    const inserted = {
      dependencies: [] as unknown[],
      episode: null as unknown,
      links: [] as unknown[],
      shots: [] as unknown[],
      shotVersions: [] as unknown[],
    };
    const headUpserts: unknown[] = [];
    let newIdSequence = 0;
    const auditRecord = vi.fn();
    const repositories = {
      audit: { record: auditRecord },
      dependencies: {
        insertMany: (values: unknown[]) => void inserted.dependencies.push(...values),
      },
      episodeVersions: {
        findMaxVersionNo: () => Promise.resolve(0),
        insert: (version: unknown) => void (inserted.episode = version),
        insertShotLinks: (links: unknown[]) => void inserted.links.push(...links),
      },
      scriptVersions: {
        findById: (id: string) =>
          Promise.resolve(
            id === 'outline-0001'
              ? {
                  document: JSON.stringify({ data: { target_duration_sec: 90 } }),
                  stage: 'EPISODE_OUTLINE',
                }
              : null,
          ),
      },
      shotContractVersions: {
        insertMany: (values: unknown[]) => void inserted.shotVersions.push(...values),
      },
      shots: { insertMany: (values: unknown[]) => void inserted.shots.push(...values) },
      stageHeads: {
        find: () => Promise.resolve(null),
        upsert: (head: unknown) => {
          headUpserts.push(head);
          return Promise.resolve(true);
        },
      },
    } as unknown as ScriptJobRepositories;
    const handler = createScriptCommitHandler({
      hashDocument: () => 'd'.repeat(64),
      hashText: () => 'h'.repeat(64),
      newId: () => `episode-version-${String((newIdSequence += 1))}`,
      now: () => '2026-08-15T00:00:00.000Z',
      revalidateFrozenInput: () => Promise.resolve(true),
    });

    await handler.commit(
      repositories,
      [shotDocument(1, 'shot_a', 'scv_a_v1'), shotDocument(2, 'shot_b', 'scv_b_v1')],
      shotJob,
    );

    expect(inserted.episode).toMatchObject({
      episodeId: 'episode-0001',
      formatProfileId: 'format-0001',
      id: 'episode-version-1',
      parentId: null,
      shotSetHash: 'h'.repeat(64),
      storyBibleVersionId: 'story-0001',
      status: 'DRAFT',
      targetDurationSec: 90,
      versionNo: 1,
    });
    expect(inserted.shots).toHaveLength(2);
    expect(inserted.shots[0]).toMatchObject({
      currentVersionId: 'scv_a_v1',
      id: 'shot_a',
      lifecycleStatus: 'ACTIVE',
    });
    expect(inserted.shotVersions[0]).toMatchObject({
      id: 'scv_a_v1',
      lineageResolutionStatus: 'ROOT',
      sequence: 1,
      sourceInvocationId: 'invocation-shot-0001',
      versionNo: 1,
      versionStatus: 'DRAFT',
    });
    expect(inserted.links).toEqual([
      {
        episodeVersionId: 'episode-version-1',
        sequence: 1,
        shotId: 'shot_a',
        shotVersionId: 'scv_a_v1',
      },
      {
        episodeVersionId: 'episode-version-1',
        sequence: 2,
        shotId: 'shot_b',
        shotVersionId: 'scv_b_v1',
      },
    ]);
    expect(headUpserts).toEqual([
      {
        currentVersionId: 'episode-version-1',
        currentVersionType: 'EPISODE_VERSION',
        episodeId: 'episode-0001',
        projectId: 'project-0001',
        stage: 'SHOT_CONTRACT',
        updatedAt: '2026-08-15T00:00:00.000Z',
      },
    ]);
    // D5：三条 GENERATED_FROM（sceneScript/storyBible/outline），FORMAT_PROFILE 不建边。
    expect(inserted.dependencies).toHaveLength(3);
    expect(
      inserted.dependencies.every(
        (edge) =>
          (edge as Readonly<Record<string, unknown>>).downstreamType === 'EPISODE_VERSION' &&
          (edge as Readonly<Record<string, unknown>>).downstreamVersionId === 'episode-version-1',
      ),
    ).toBe(true);
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });
});
