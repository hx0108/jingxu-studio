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
export const scriptVersionStatusSchema = z.enum(['DRAFT', 'READY', 'STALE_INPUT']);
export const scriptVersionSourceSchema = z.enum(['AI', 'USER', 'IMPORT', 'SYSTEM_INVALIDATION']);

const episodeIdSchema = idSchema;
const versionIdSchema = idSchema;
const isProjectStage = (stage: z.infer<typeof stagedScriptStageSchema>): boolean =>
  stage === 'CONCEPT' || stage === 'STORY_BIBLE';
const addEpisodeScopeIssue = (
  episodeId: string | null,
  stage: z.infer<typeof stagedScriptStageSchema>,
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
    stage: stagedScriptStageSchema,
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

export interface ScriptApi {
  initializeOriginal(input: InitializeOriginalInputDto): Promise<AppResultDto<ScriptWorkspaceDto>>;
  getWorkspace(input: GetScriptWorkspaceInputDto): Promise<AppResultDto<ScriptWorkspaceDto>>;
  saveDraft(input: SaveScriptDraftInputDto): Promise<AppResultDto<ScriptVersionDto>>;
  confirmVersion(input: ConfirmScriptVersionInputDto): Promise<AppResultDto<ScriptVersionDto>>;
  restoreVersion(input: RestoreScriptVersionInputDto): Promise<AppResultDto<ScriptVersionDto>>;
}

export const SCRIPT_IPC_CHANNELS = {
  confirmVersion: 'script.confirmVersion',
  getWorkspace: 'script.getWorkspace',
  initializeOriginal: 'script.initializeOriginal',
  restoreVersion: 'script.restoreVersion',
  saveDraft: 'script.saveDraft',
} as const;
