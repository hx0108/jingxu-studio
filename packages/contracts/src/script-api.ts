import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { jobSummarySchema } from './job-provider-api';
import { projectIdSchema, requestIdSchema } from './project-dto';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const stageDataSchema = z.record(z.string(), z.unknown());
const originalCreativeTextSchema = z.string().superRefine((value, context) => {
  const characterCount = Array.from(value).length;
  if (characterCount < 20 || characterCount > 2_000 || value.trim().length === 0) {
    context.addIssue({
      code: 'custom',
      message: '原创输入必须包含 20–2,000 个 Unicode 字符。',
    });
  }
});

export const stagedScriptStageSchema = z.enum([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
]);
/**
 * 确认/恢复命令接受六阶段：SHOT_CONTRACT 走分镜路径（D4 语义，D6 零新增命令）；
 * saveDraft 与阶段文档仍限五阶段——分镜集合只能由生成/确认/恢复产生，无手写草稿。
 */
export const scriptVersionCommandStageSchema = z.enum([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
  'SHOT_CONTRACT',
]);
export const scriptVersionStatusSchema = z.enum(['DRAFT', 'READY', 'STALE_INPUT']);
export const scriptVersionSourceSchema = z.enum(['AI', 'USER', 'IMPORT', 'SYSTEM_INVALIDATION']);

const episodeIdSchema = idSchema;
const versionIdSchema = idSchema;
const isProjectStage = (stage: z.infer<typeof scriptVersionCommandStageSchema>): boolean =>
  stage === 'CONCEPT' || stage === 'STORY_BIBLE';
const addEpisodeScopeIssue = (
  episodeId: string | null,
  stage: z.infer<typeof scriptVersionCommandStageSchema>,
  context: z.core.$RefinementCtx,
): void => {
  if (
    (isProjectStage(stage) && episodeId !== null) ||
    (!isProjectStage(stage) && episodeId === null)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'episodeId 与阶段层级不匹配。',
      path: ['episodeId'],
    });
  }
};
export const initializeOriginalInputSchema = z
  .object({
    creativeText: originalCreativeTextSchema,
    dataProcessingConsent: z.literal(true),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const getScriptWorkspaceInputSchema = z.object({ projectId: projectIdSchema }).strict();

const scriptVersionCommandSchema = z
  .object({
    episodeId: episodeIdSchema.nullable(),
    expectedVersionId: versionIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    stage: scriptVersionCommandStageSchema,
    versionId: versionIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addEpisodeScopeIssue(value.episodeId, value.stage, context);
  });

export const saveScriptDraftInputSchema = z
  .object({
    data: stageDataSchema,
    episodeId: episodeIdSchema.nullable(),
    expectedVersionId: versionIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    stage: stagedScriptStageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addEpisodeScopeIssue(value.episodeId, value.stage, context);
  });
export const confirmScriptVersionInputSchema = scriptVersionCommandSchema;
export const restoreScriptVersionInputSchema = scriptVersionCommandSchema;

export const scriptStageDocumentSchema = z
  .object({
    data: stageDataSchema,
    episode_id: episodeIdSchema.nullable(),
    project_id: projectIdSchema,
    schema_version: z.literal('1.0.0'),
    source_invocation_id: idSchema,
    stage: stagedScriptStageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addEpisodeScopeIssue(value.episode_id, value.stage, context);
  });
export const scriptVersionSchema = z
  .object({
    createdAt: isoDateTimeSchema,
    document: scriptStageDocumentSchema,
    documentHash: hashSchema,
    id: versionIdSchema,
    parentId: versionIdSchema.nullable(),
    projectId: projectIdSchema,
    source: scriptVersionSourceSchema,
    status: scriptVersionStatusSchema,
    versionNo: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.document.project_id !== value.projectId) {
      context.addIssue({
        code: 'custom',
        message: '版本文档项目归属不一致。',
        path: ['document', 'project_id'],
      });
    }
  });
export const scriptStageWorkspaceSchema = z
  .object({
    current: scriptVersionSchema.nullable(),
    history: z.array(scriptVersionSchema).max(100),
    prerequisiteReady: z.boolean(),
    stage: stagedScriptStageSchema,
  })
  .strict();

// ---- SHOT_CONTRACT storyboard 节（shot-contract-generation §5.2，D6）----

export const storyboardShotSummarySchema = z
  .object({
    cameraMotion: z.enum(['STATIC', 'PAN', 'TILT', 'DOLLY', 'ZOOM', 'TRACK', 'HANDHELD', 'OTHER']),
    /** 当前版本完整 ShotContract 文档（shot-edit-lock D1：JSON 编辑器数据源）。 */
    document: z.record(z.string(), z.unknown()),
    dialogueRenderMode: z.enum([
      'NARRATION_FIRST',
      'WEAK_LIP_SYNC',
      'PRECISE_LIP_SYNC',
      'SUBTITLE_ONLY',
    ]),
    /** 有效锁投影（不变量 13：≡ lock_records 有效集合）。 */
    lockedPaths: z.array(z.string().regex(/^\//u)).max(32),
    narrativePurpose: z.string().min(1).max(500),
    sequence: z.number().int().positive(),
    shotId: idSchema,
    shotSize: z.enum(['EXTREME_LONG', 'LONG', 'FULL', 'MEDIUM', 'CLOSE_UP', 'EXTREME_CLOSE_UP']),
    targetDurationSec: z.number().min(1).max(20),
    versionId: idSchema,
  })
  .strict();
/** 与 application StoryboardVersionSummary 同形；§5.3 确认/恢复响应复用。 */
export const storyboardVersionSummarySchema = z
  .object({
    createdAt: isoDateTimeSchema,
    episodeId: episodeIdSchema,
    formatProfileId: idSchema,
    id: versionIdSchema,
    parentId: versionIdSchema.nullable(),
    shotCount: z.number().int().nonnegative(),
    shotSetHash: hashSchema,
    status: scriptVersionStatusSchema,
    storyBibleVersionId: idSchema,
    targetDurationSec: z.number().int().min(30).max(180),
    versionNo: z.number().int().positive(),
  })
  .strict();
/** 确认/恢复的联合响应：五阶段返回版本文档，SHOT_CONTRACT 返回整集摘要。 */
export const scriptMutationResultSchema = z.union([
  scriptVersionSchema,
  storyboardVersionSummarySchema,
]);
export const storyboardWorkspaceSchema = z
  .object({
    current: storyboardVersionSummarySchema.nullable(),
    history: z.array(storyboardVersionSummarySchema).max(50),
    shots: z.array(storyboardShotSummarySchema).max(180),
    totalDurationSec: z.number().min(0),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.shots.length; index += 1) {
      const shot = value.shots[index];
      const previous = value.shots[index - 1];
      if (shot === undefined || previous === undefined) continue;
      if (shot.sequence <= previous.sequence) {
        context.addIssue({
          code: 'custom',
          message: '镜头 sequence 必须严格递增。',
          path: ['shots', index, 'sequence'],
        });
      }
    }
    if (
      value.shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0) !== value.totalDurationSec
    ) {
      context.addIssue({
        code: 'custom',
        message: '时长汇总与镜头时长之和不一致。',
        path: ['totalDurationSec'],
      });
    }
    if (value.current === null && value.shots.length > 0) {
      context.addIssue({
        code: 'custom',
        message: '无当前分镜版本时不应携带镜头列表。',
        path: ['shots'],
      });
    }
    if (value.current !== null && value.current.shotCount !== value.shots.length) {
      context.addIssue({
        code: 'custom',
        message: '当前版本镜头数与列表长度不一致。',
        path: ['current', 'shotCount'],
      });
    }
  });
export const scriptWorkspaceSchema = z
  .object({
    currentJob: jobSummarySchema.nullable(),
    episode: z
      .object({
        id: episodeIdSchema,
        projectId: projectIdSchema,
        targetDurationSec: z.number().min(30).max(180),
        title: z.string().min(1).max(100),
      })
      .strict(),
    prerequisites: z.array(
      z
        .object({
          message: z.string().min(1).max(280),
          ready: z.boolean(),
          stage: stagedScriptStageSchema,
        })
        .strict(),
    ),
    projectId: projectIdSchema,
    source: z
      .object({
        characterCount: z.number().int().min(20).max(2_000),
        contentHash: hashSchema,
        creativeText: originalCreativeTextSchema,
        id: idSchema,
        projectId: projectIdSchema,
      })
      .strict(),
    /** SHOT_CONTRACT 整集分镜读模型；无分镜时 current 为 null 且 shots 为空。 */
    storyboard: storyboardWorkspaceSchema,
    stages: z.array(scriptStageWorkspaceSchema).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.episode.projectId !== value.projectId || value.source.projectId !== value.projectId) {
      context.addIssue({
        code: 'custom',
        message: '工作区对象项目归属不一致。',
        path: ['projectId'],
      });
    }
    if (value.currentJob !== null && value.currentJob.projectId !== value.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'Job 项目归属不一致。',
        path: ['currentJob', 'projectId'],
      });
    }
    if (
      value.storyboard.current !== null &&
      value.storyboard.current.episodeId !== value.episode.id
    ) {
      context.addIssue({
        code: 'custom',
        message: '分镜版本与工作区 Episode 不一致。',
        path: ['storyboard', 'current'],
      });
    }
    for (const [index, version] of value.storyboard.history.entries()) {
      if (version.episodeId !== value.episode.id) {
        context.addIssue({
          code: 'custom',
          message: '分镜历史版本与工作区 Episode 不一致。',
          path: ['storyboard', 'history', index],
        });
      }
    }
    for (const [index, stage] of value.stages.entries()) {
      for (const version of [
        ...stage.history,
        ...(stage.current === null ? [] : [stage.current]),
      ]) {
        if (version.projectId !== value.projectId) {
          context.addIssue({
            code: 'custom',
            message: '版本项目归属不一致。',
            path: ['stages', index],
          });
        }
      }
    }
  });

export type InitializeOriginalInputDto = z.infer<typeof initializeOriginalInputSchema>;
export type GetScriptWorkspaceInputDto = z.infer<typeof getScriptWorkspaceInputSchema>;
export type SaveScriptDraftInputDto = z.infer<typeof saveScriptDraftInputSchema>;
export type ConfirmScriptVersionInputDto = z.infer<typeof confirmScriptVersionInputSchema>;
export type RestoreScriptVersionInputDto = z.infer<typeof restoreScriptVersionInputSchema>;
export type ScriptWorkspaceDto = z.infer<typeof scriptWorkspaceSchema>;
export type ScriptVersionDto = z.infer<typeof scriptVersionSchema>;
export type StoryboardWorkspaceDto = z.infer<typeof storyboardWorkspaceSchema>;
export type StoryboardShotSummaryDto = z.infer<typeof storyboardShotSummarySchema>;
export type StoryboardVersionSummaryDto = z.infer<typeof storyboardVersionSummarySchema>;
export type ScriptMutationResultDto = z.infer<typeof scriptMutationResultSchema>;

export interface ScriptApi {
  initializeOriginal(input: InitializeOriginalInputDto): Promise<AppResultDto<ScriptWorkspaceDto>>;
  getWorkspace(input: GetScriptWorkspaceInputDto): Promise<AppResultDto<ScriptWorkspaceDto>>;
  saveDraft(input: SaveScriptDraftInputDto): Promise<AppResultDto<ScriptVersionDto>>;
  confirmVersion(
    input: ConfirmScriptVersionInputDto,
  ): Promise<AppResultDto<ScriptMutationResultDto>>;
  restoreVersion(
    input: RestoreScriptVersionInputDto,
  ): Promise<AppResultDto<ScriptMutationResultDto>>;
}

export const SCRIPT_IPC_CHANNELS = {
  confirmVersion: 'script.confirmVersion',
  getWorkspace: 'script.getWorkspace',
  initializeOriginal: 'script.initializeOriginal',
  restoreVersion: 'script.restoreVersion',
  saveDraft: 'script.saveDraft',
} as const;
