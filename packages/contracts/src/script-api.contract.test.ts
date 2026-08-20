import { describe, expect, expectTypeOf, it } from 'vitest';

import { appErrorSchema, projectErrorCodeSchema } from './app-result';
import {
  SCRIPT_IPC_CHANNELS,
  confirmScriptVersionInputSchema,
  initializeOriginalInputSchema,
  restoreScriptVersionInputSchema,
  saveScriptDraftInputSchema,
  scriptWorkspaceSchema,
  type ScriptApi,
} from './script-api';

const projectId = 'project_12345678';
const episodeId = 'episode_12345678';
const versionId = 'version_12345678';

describe('Script IPC Contract', () => {
  it('频道白名单—五个逐方法接口—名称固定且 API 类型公开', () => {
    expect(Object.values(SCRIPT_IPC_CHANNELS).sort()).toEqual([
      'script.confirmVersion',
      'script.getWorkspace',
      'script.initializeOriginal',
      'script.restoreVersion',
      'script.saveDraft',
    ]);
    expectTypeOf<ScriptApi>().toBeObject();
  });

  it('原创初始化—用户字段合法—接受原始空白且要求明确的数据处理同意', () => {
    const input = {
      creativeText: '  这是一个长度足够且保留首尾空白的原创故事创意，用于测试。  ',
      dataProcessingConsent: true,
      projectId,
      requestId: 'request-123',
    };
    expect(initializeOriginalInputSchema.safeParse(input).success).toBe(true);
    expect(
      initializeOriginalInputSchema.safeParse({ ...input, dataProcessingConsent: false }).success,
    ).toBe(false);
    expect(
      initializeOriginalInputSchema.safeParse({ ...input, sourceInputId: 'forged' }).success,
    ).toBe(false);
  });

  it('阶段命令—未知或机器字段—strict 契约拒绝', () => {
    const save = {
      data: { title: '标题' },
      episodeId: null,
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
      stage: 'CONCEPT',
    };
    expect(saveScriptDraftInputSchema.safeParse(save).success).toBe(true);
    expect(saveScriptDraftInputSchema.safeParse({ ...save, schemaVersion: '1.0.0' }).success).toBe(
      false,
    );
    expect(saveScriptDraftInputSchema.safeParse({ ...save, status: 'READY' }).success).toBe(false);
    expect(saveScriptDraftInputSchema.safeParse({ ...save, stage: 'SHOT_CONTRACT' }).success).toBe(
      false,
    );
  });

  it('阶段与 Episode—项目级或集级组合不合法—所有写命令拒绝', () => {
    const base = {
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
      versionId,
    };
    expect(
      confirmScriptVersionInputSchema.safeParse({
        ...base,
        episodeId,
        stage: 'STORY_BIBLE',
      }).success,
    ).toBe(false);
    expect(
      restoreScriptVersionInputSchema.safeParse({
        ...base,
        episodeId: null,
        stage: 'SCENE_SCRIPT',
      }).success,
    ).toBe(false);
  });

  it('确认/恢复命令—SHOT_CONTRACT 集级（§5.3 D6）—接受并复用回执命令；saveDraft 仍拒绝', () => {
    const command = {
      episodeId,
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
      stage: 'SHOT_CONTRACT',
      versionId,
    };
    expect(confirmScriptVersionInputSchema.safeParse(command).success).toBe(true);
    expect(restoreScriptVersionInputSchema.safeParse(command).success).toBe(true);
    // 集级阶段必须携带 episodeId；未知字段 strict 拒绝。
    expect(confirmScriptVersionInputSchema.safeParse({ ...command, episodeId: null }).success).toBe(
      false,
    );
    expect(
      restoreScriptVersionInputSchema.safeParse({ ...command, shotId: 'forged' }).success,
    ).toBe(false);
  });

  it('Workspace 输出—嵌套对象项目归属不一致—拒绝跨项目数据', () => {
    const workspace = {
      currentJob: null,
      episode: {
        id: episodeId,
        projectId,
        targetDurationSec: 90,
        title: '第 1 集',
      },
      prerequisites: [],
      projectId,
      source: {
        characterCount: 24,
        contentHash: 'a'.repeat(64),
        creativeText: '这是一个长度足够且用于工作区输出验证的原创故事创意。',
        id: 'source_12345678',
        projectId,
      },
      storyboard: { current: null, history: [], shots: [], totalDurationSec: 0 },
      stages: [],
    };
    expect(scriptWorkspaceSchema.safeParse(workspace).success).toBe(true);
    expect(
      scriptWorkspaceSchema.safeParse({
        ...workspace,
        episode: { ...workspace.episode, projectId: 'project_other_1234' },
      }).success,
    ).toBe(false);
    // storyboard 节（§5.2）：同 Episode 整集摘要通过，跨 Episode 分镜版本拒绝。
    const storyboardVersion = {
      createdAt: '2026-08-13T00:00:00.000Z',
      episodeId,
      formatProfileId: 'format_12345678',
      id: versionId,
      parentId: null,
      shotCount: 0,
      shotSetHash: 'b'.repeat(64),
      status: 'DRAFT',
      storyBibleVersionId: 'version_12345678',
      targetDurationSec: 90,
      versionNo: 1,
    };
    expect(
      scriptWorkspaceSchema.safeParse({
        ...workspace,
        storyboard: { current: storyboardVersion, history: [], shots: [], totalDurationSec: 0 },
      }).success,
    ).toBe(true);
    expect(
      scriptWorkspaceSchema.safeParse({
        ...workspace,
        storyboard: {
          current: { ...storyboardVersion, episodeId: 'episode_other_1234567' },
          history: [],
          shots: [],
          totalDurationSec: 0,
        },
      }).success,
    ).toBe(false);
  });

  it('storyboard 节—集合不变量与字段边界—完整正例通过，越界形态拒绝（§5.5）', () => {
    const shot = (sequence: number, targetDurationSec = 15): Record<string, unknown> => ({
      cameraMotion: sequence === 1 ? 'STATIC' : 'DOLLY',
      dialogueRenderMode: 'NARRATION_FIRST',
      document: {
        narrative_purpose: `镜头 ${String(sequence)}`,
        target_duration_sec: targetDurationSec,
      },
      lockedPaths: [],
      narrativePurpose: `镜头 ${String(sequence)} 的叙事目的`,
      sequence,
      shotId: `shot_0000000${String(sequence)}`,
      shotSize: 'MEDIUM',
      targetDurationSec,
      versionId: `shotver_00${String(sequence)}`,
    });
    const current: Record<string, unknown> = {
      createdAt: '2026-08-13T00:00:00.000Z',
      episodeId,
      formatProfileId: 'format_12345678',
      id: versionId,
      parentId: null,
      shotCount: 2,
      shotSetHash: 'b'.repeat(64),
      status: 'DRAFT',
      storyBibleVersionId: 'bible_1234567',
      targetDurationSec: 90,
      versionNo: 1,
    };
    const storyboard = { current, history: [], shots: [shot(1), shot(2)], totalDurationSec: 30 };
    const baseWorkspace = {
      currentJob: null,
      episode: { id: episodeId, projectId, targetDurationSec: 90, title: '第 1 集' },
      prerequisites: [],
      projectId,
      source: {
        characterCount: 24,
        contentHash: 'a'.repeat(64),
        creativeText: '这是一个长度足够且用于工作区输出验证的原创故事创意。',
        id: 'source_12345678',
        projectId,
      },
      stages: [],
    };
    const parseStoryboard = (next: unknown): boolean =>
      scriptWorkspaceSchema.safeParse({ ...baseWorkspace, storyboard: next }).success;
    // 完整正例：sequence 递增、Σ 时长一致、shotCount 一致。
    expect(parseStoryboard(storyboard)).toBe(true);
    expect(parseStoryboard({ ...storyboard, history: [current] })).toBe(true);
    // 集合不变量：sequence 降序 / Σ 时长不一致 / 无 current 却有镜头 / shotCount 不一致。
    expect(parseStoryboard({ ...storyboard, shots: [shot(2), shot(1)] })).toBe(false);
    expect(parseStoryboard({ ...storyboard, totalDurationSec: 29 })).toBe(false);
    expect(
      parseStoryboard({ current: null, history: [], shots: [shot(1)], totalDurationSec: 15 }),
    ).toBe(false);
    expect(parseStoryboard({ ...storyboard, current: { ...current, shotCount: 3 } })).toBe(false);
    // 字段边界：整集时长 30–180、单镜头 1–20、叙事目的非空、运机枚举。
    expect(
      parseStoryboard({
        ...storyboard,
        current: { ...current, targetDurationSec: 25 },
        totalDurationSec: 30,
      }),
    ).toBe(false);
    expect(
      parseStoryboard({ ...storyboard, shots: [shot(1, 21), shot(2)], totalDurationSec: 36 }),
    ).toBe(false);
    expect(
      parseStoryboard({ ...storyboard, shots: [shot(1), { ...shot(2), narrativePurpose: '' }] }),
    ).toBe(false);
    expect(
      parseStoryboard({ ...storyboard, shots: [shot(1), { ...shot(2), cameraMotion: 'ORBIT' }] }),
    ).toBe(false);
    // 归属：history 条目跨 Episode 拒绝（与 current 同规）。
    expect(
      parseStoryboard({
        ...storyboard,
        history: [{ ...current, id: 'ev-history-0001', episodeId: 'episode_other_1234567' }],
      }),
    ).toBe(false);
  });

  it('storyboard 错误码映射—服务错误码属 ProjectErrorCode，Job 终态码走自由字符串通道（§5.5）', () => {
    // StoryboardVersionService 的四个稳定错误码必须可进 AppError（ERROR_COPY 由 tsc 全量强制）。
    for (const code of [
      'REQUEST_ID_REUSED',
      'SCRIPT_VERSION_CONFLICT',
      'SCRIPT_VERSION_NOT_FOUND',
      'PROJECT_PERSISTENCE_FAILED',
    ]) {
      expect(projectErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(
      appErrorSchema.safeParse({
        code: 'SCRIPT_VERSION_NOT_FOUND',
        fieldErrors: null,
        message: '指定分镜版本不存在',
        retryable: false,
        traceId: 'trace-1234',
        userAction: '刷新历史版本后重试。',
      }).success,
    ).toBe(true);
    // Job 终态 errorCode 是自由字符串（JobSummaryDto），不属 AppError 枚举，由 Renderer 本地文案脱敏映射。
    expect(projectErrorCodeSchema.safeParse('CONTRACT_VALIDATION_FAILED').success).toBe(false);
    expect(projectErrorCodeSchema.safeParse('STRUCTURE_REPAIR_FAILED').success).toBe(false);
  });

  it('Script 错误—稳定错误码可用且调试字段或原响应不能进入输出', () => {
    const error = {
      code: 'SCRIPT_SCHEMA_INVALID',
      fieldErrors: { '/data/title': 'required' },
      message: '阶段内容未通过结构校验。',
      retryable: false,
      traceId: 'trace-1234',
      userAction: '请修正标记字段后重试。',
    };
    expect(appErrorSchema.safeParse(error).success).toBe(true);
    expect(appErrorSchema.safeParse({ ...error, sql: 'SELECT' }).success).toBe(false);
    expect(appErrorSchema.safeParse({ ...error, providerResponse: 'secret' }).success).toBe(false);
  });
});
