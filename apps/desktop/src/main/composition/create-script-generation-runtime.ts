import { createHash, randomUUID } from 'node:crypto';

import {
  createScriptGenerationRuntime,
  type CandidateContractValidation,
  type CompiledSchemaRegistry,
  type ScriptGenerationRuntime,
  type ScriptStageJob,
  type ScriptUnitOfWorkPort,
  type TextModelPort,
} from '@jingxu/application';
import { buildScriptPrompt, SCRIPT_PROMPT_MANIFEST } from '@jingxu/prompts';
import {
  validateModelScriptStageCandidate,
  validateModelShotSetCandidate,
  V1_SCHEMA_IDS,
} from '@jingxu/validation';

const SCRIPT_STAGE_OUTPUT_SCHEMA_ID = 'https://jingxu.studio/schemas/script-stage-output/1.0.0';
export const PRIMARY_QWEN_PROFILE_ID = 'profile_qwen_primary';

const sha256Text = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const sha256Payload = (value: Readonly<Record<string, unknown>>): string =>
  sha256Text(JSON.stringify(value));

type FrozenReference = Readonly<{
  objectId: string;
  objectType:
    'EPISODE' | 'FORMAT_PROFILE' | 'SOURCE_INPUT' | 'SCRIPT_VERSION' | 'STORY_BIBLE_VERSION';
  sha256: string;
  versionId: string;
}>;

const parseReferences = (job: ScriptStageJob): readonly FrozenReference[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.inputVersionsJson) as unknown;
  } catch {
    throw new Error('STALE_INPUT');
  }
  if (typeof parsed !== 'object' || parsed === null || !('references' in parsed)) {
    throw new Error('STALE_INPUT');
  }
  const references = (parsed as Readonly<{ references?: unknown }>).references;
  if (!Array.isArray(references)) throw new Error('STALE_INPUT');
  return references.map((candidate): FrozenReference => {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('STALE_INPUT');
    const value = candidate as Partial<FrozenReference>;
    if (
      typeof value.objectId !== 'string' ||
      typeof value.objectType !== 'string' ||
      typeof value.sha256 !== 'string' ||
      typeof value.versionId !== 'string'
    ) {
      throw new Error('STALE_INPUT');
    }
    if (
      ![
        'EPISODE',
        'FORMAT_PROFILE',
        'SOURCE_INPUT',
        'SCRIPT_VERSION',
        'STORY_BIBLE_VERSION',
      ].includes(value.objectType)
    ) {
      throw new Error('STALE_INPUT');
    }
    return value as FrozenReference;
  });
};

const materialForReference = async (
  unitOfWork: ScriptUnitOfWorkPort,
  reference: FrozenReference,
  projectId: string,
): Promise<unknown> =>
  unitOfWork.run(async (repositories) => {
    switch (reference.objectType) {
      case 'SOURCE_INPUT': {
        const source = await repositories.sourceInputs.findById(reference.objectId);
        if (
          source?.projectId !== projectId ||
          source.id !== reference.versionId ||
          source.sha256 !== reference.sha256
        )
          throw new Error('STALE_INPUT');
        return { content: source.content };
      }
      case 'FORMAT_PROFILE': {
        const profile = await repositories.formatProfiles.findCurrent(projectId);
        if (profile?.id !== reference.versionId) throw new Error('STALE_INPUT');
        const hash = sha256Payload({
          createdAt: profile.createdAt,
          objectId: profile.id,
          objectType: 'FORMAT_PROFILE',
          parentId: profile.parentId,
          projectId: profile.projectId,
          spec: profile.spec,
          versionId: profile.id,
          versionNo: profile.versionNo,
        });
        if (hash !== reference.sha256) throw new Error('STALE_INPUT');
        return { spec: profile.spec };
      }
      case 'EPISODE': {
        const episode = await repositories.episodes.findById(reference.objectId);
        if (episode?.projectId !== projectId || episode.id !== reference.versionId)
          throw new Error('STALE_INPUT');
        const hash = sha256Payload({
          currentVersionId: episode.currentVersionId,
          deletedAt: episode.deletedAt,
          objectId: episode.id,
          objectType: 'EPISODE',
          projectId: episode.projectId,
          targetDurationSec: episode.targetDurationSec,
          title: episode.title,
          updatedAt: episode.updatedAt,
          versionId: episode.id,
        });
        if (hash !== reference.sha256) throw new Error('STALE_INPUT');
        return { targetDurationSec: episode.targetDurationSec, title: episode.title };
      }
      case 'SCRIPT_VERSION': {
        const version = await repositories.scriptVersions.findById(reference.versionId);
        if (version?.projectId !== projectId || version.documentSha256 !== reference.sha256)
          throw new Error('STALE_INPUT');
        return JSON.parse(version.document) as unknown;
      }
      case 'STORY_BIBLE_VERSION': {
        const version = await repositories.storyBibleVersions.findById(reference.versionId);
        if (version?.projectId !== projectId || version.documentSha256 !== reference.sha256)
          throw new Error('STALE_INPUT');
        return JSON.parse(version.document) as unknown;
      }
    }
  });

const validationResult = (
  valid: boolean,
  code: string,
  details?: readonly string[],
): CandidateContractValidation =>
  valid ? { valid: true } : { code, ...(details ? { details } : {}), valid: false };

export interface CreateDesktopScriptGenerationRuntimeOptions {
  readonly clock: () => string;
  readonly registry: CompiledSchemaRegistry;
  readonly textModel: TextModelPort;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

/** Main composition adapter: loads frozen project data and injects infrastructure Ports. */
export const createDesktopScriptGenerationRuntime = ({
  clock,
  registry,
  textModel,
  unitOfWork,
}: CreateDesktopScriptGenerationRuntimeOptions): ScriptGenerationRuntime =>
  createScriptGenerationRuntime({
    createInvocationId: () => randomUUID(),
    createLeaseToken: randomUUID,
    finalSchemaId: (stage) =>
      stage === 'SHOT_CONTRACT' ? V1_SCHEMA_IDS.shotContract : SCRIPT_STAGE_OUTPUT_SCHEMA_ID,
    hashPayload: sha256Payload,
    hashText: sha256Text,
    loadPromptSnapshot: async (job) => {
      const references = parseReferences(job);
      const inputs: Record<string, unknown> = {};
      for (const reference of references) {
        inputs[`${reference.objectType}:${reference.objectId}`] = await materialForReference(
          unitOfWork,
          reference,
          job.projectId,
        );
      }
      return buildScriptPrompt({
        inputVersions: references.map((reference) => ({
          id: reference.versionId,
          kind: reference.objectType,
        })),
        inputs,
        stage: job.stage,
      });
    },
    model: {
      id: 'qwen3.7-plus-2026-05-26',
      providerProfileId: PRIMARY_QWEN_PROFILE_ID,
      version: '2026-05-26',
    },
    newId: randomUUID,
    now: clock,
    parameters: { response_format: { type: 'json_object' } },
    promptTemplateId: (stage) => {
      const prompt = SCRIPT_PROMPT_MANIFEST.find((entry) => entry.stage === stage);
      if (prompt === undefined) throw new Error('SCRIPT_STAGE_UNSUPPORTED');
      return prompt.promptTemplateId;
    },
    textModel,
    unitOfWork,
    validateCandidate: (job, value) => {
      if (job.stage === 'SHOT_CONTRACT') {
        const result = validateModelShotSetCandidate(value);
        return validationResult(
          result.ok,
          result.errorCode ?? 'CANDIDATE_SCHEMA_INVALID',
          result.ok ? undefined : result.details,
        );
      }
      const result = validateModelScriptStageCandidate(job.stage, value);
      return validationResult(result.ok, result.errorCode ?? 'CANDIDATE_SCHEMA_INVALID');
    },
    validateFinal: (job, value) => {
      if (job.stage === 'SHOT_CONTRACT') {
        // 注入产物为逐镜头数组：对每个 ShotContract 1.1.0 文档正式校验，
        // details 以 shots[i] 前缀定位（仅结构元数据，不含实例值）。
        if (!Array.isArray(value) || value.length === 0) {
          return { code: 'SCRIPT_SCHEMA_INVALID', valid: false };
        }
        const shotDocuments = value as readonly unknown[];
        const details: string[] = [];
        let firstCode: string | null = null;
        for (const [index, shot] of shotDocuments.entries()) {
          const result = registry.validate(V1_SCHEMA_IDS.shotContract, shot);
          if (result.valid) continue;
          firstCode ??= result.issues[0]?.messageCode ?? 'SCRIPT_SCHEMA_INVALID';
          for (const issue of result.issues) {
            details.push(`shots[${String(index)}]${issue.instancePath}:${issue.messageCode}`);
          }
        }
        return validationResult(
          firstCode === null,
          firstCode ?? 'SCRIPT_SCHEMA_INVALID',
          details.length > 0 ? details : undefined,
        );
      }
      const result = registry.validate(SCRIPT_STAGE_OUTPUT_SCHEMA_ID, value);
      return validationResult(
        result.valid,
        result.issues[0]?.messageCode ?? 'SCRIPT_SCHEMA_INVALID',
        // 结构元数据（instancePath + messageCode），不含模型输出实例值，可安全落 error_json。
        result.valid
          ? undefined
          : result.issues.map((issue) => `${issue.instancePath}:${issue.messageCode}`),
      );
    },
  });
