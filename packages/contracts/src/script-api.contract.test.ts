import { describe, expect, expectTypeOf, it } from 'vitest';

import { appErrorSchema } from './app-result';
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
