/**
 * EvaluationService（design.md 事务边界；spec「样本入库与去重/项目派生样本」）。
 *
 * 写命令走 AppResultDto 脱敏回执；样本入库统一单事务
 * 「dedup 检查 → 信封防御校验 → 规则命中 → insert → audit」。
 * requestId 不做持久化重放（V1 无集成证明的缺口）：仅作为审计 traceId，
 * Main 侧以 singleflight 防并发重放（见 design.md 幂等拍板）。
 */

import {
  EVALUATION_GUIDELINE_VERSION,
  evaluationAuthorizationSchema,
  evaluationDatasetSplitSchema,
  evaluationDedupKeySchema,
  evaluationExpectedSchema,
  evaluationSampleInputSchema,
} from '@jingxu/contracts';
import type {
  AppResultDto,
  EvaluationAddAnnotationInputDto,
  EvaluationAnnotationDto,
  EvaluationCreateFromEpisodeInputDto,
  EvaluationCreateFromEpisodeResultDto,
  EvaluationCreateSampleInputDto,
  EvaluationImportBatchResultDto,
  EvaluationImportItemResultDto,
  EvaluationIssueCode,
  EvaluationListSamplesInputDto,
  EvaluationListSamplesResultDto,
  EvaluationRuleHitDto,
  EvaluationSampleDetailDto,
  EvaluationSampleInputDto,
  EvaluationSampleSummaryDto,
  ProjectErrorCode,
} from '@jingxu/contracts';

import type {
  EvaluationAnnotationRecord,
  EvaluationImportEnvelopeItem,
  EvaluationSampleRecord,
} from '../ports/evaluation/evaluation-types';
import type {
  EvaluationImportFilePort,
  EvaluationRepositories,
  EvaluationRulesPort,
  EvaluationUnitOfWorkPort,
} from '../ports/evaluation';
import { PRODUCIBILITY_RULES_VERSION } from '../script/storyboard-export-markdown';

export interface EvaluationServiceDependencies {
  readonly file: EvaluationImportFilePort;
  readonly newId: () => string;
  readonly now: () => string;
  readonly rules: EvaluationRulesPort;
  readonly unitOfWork: EvaluationUnitOfWorkPort;
}

export interface EvaluationService {
  listSamples(
    input: EvaluationListSamplesInputDto,
    traceId: string,
  ): Promise<AppResultDto<EvaluationListSamplesResultDto>>;
  getSample(
    input: Readonly<{ sampleId: string }>,
    traceId: string,
  ): Promise<AppResultDto<EvaluationSampleDetailDto>>;
  createSample(
    input: EvaluationCreateSampleInputDto,
    traceId: string,
  ): Promise<AppResultDto<EvaluationSampleSummaryDto>>;
  createFromEpisode(
    input: EvaluationCreateFromEpisodeInputDto,
    traceId: string,
  ): Promise<AppResultDto<EvaluationCreateFromEpisodeResultDto>>;
  deleteSample(
    input: Readonly<{ requestId: string; sampleId: string }>,
    traceId: string,
  ): Promise<AppResultDto<Readonly<{ deletedAnnotations: number; sampleId: string }>>>;
  addAnnotation(
    input: EvaluationAddAnnotationInputDto,
    traceId: string,
  ): Promise<AppResultDto<Readonly<{ annotations: readonly EvaluationAnnotationDto[] }>>>;
  importBatch(
    input: Readonly<{ requestId: string }>,
    traceId: string,
  ): Promise<AppResultDto<EvaluationImportBatchResultDto>>;
}

const IMPORT_MAX_SAMPLES = 256;
const REASON_MAX = 280;

const boundedReason = (parts: readonly string[]): string => {
  const joined = parts.filter((part) => part.length > 0).join('; ');
  return (joined.length > 0 ? joined : '样本信封非法').slice(0, REASON_MAX - 1) + '…';
};

type StagedImportItem =
  | { readonly valid: true; readonly item: EvaluationImportEnvelopeItem }
  | { readonly valid: false; readonly dedupKey: string | null; readonly reason: string };

/** staging（事务外）：文件级损坏整体拒绝；条目级问题降级为逐样本 REJECTED 原因。 */
const stageImportEnvelope = (bytes: Uint8Array): readonly StagedImportItem[] | null => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.samples)) return null;
  if (parsed.samples.length > IMPORT_MAX_SAMPLES) return null;
  return parsed.samples.map((raw): StagedImportItem => {
    if (!isRecord(raw)) {
      return { dedupKey: null, reason: '样本条目不是对象', valid: false };
    }
    const dedupKey = typeof raw.dedupKey === 'string' ? raw.dedupKey : null;
    const fieldErrors = envelopeFieldErrors(raw);
    const authorization = evaluationAuthorizationSchema.safeParse(raw.authorization);
    const datasetSplit = evaluationDatasetSplitSchema.safeParse(raw.datasetSplit);
    if (
      fieldErrors !== null ||
      !authorization.success ||
      !datasetSplit.success ||
      (raw.projectId != null && typeof raw.projectId !== 'string')
    ) {
      const parts: string[] = [];
      if (fieldErrors !== null) {
        for (const [field, message] of Object.entries(fieldErrors)) {
          parts.push(`${field}: ${message}`);
        }
      }
      if (!authorization.success) parts.push('authorization: 授权状态非法');
      if (!datasetSplit.success) parts.push('datasetSplit: 数据拆分非法');
      if (raw.projectId != null && typeof raw.projectId !== 'string') {
        parts.push('projectId: 类型非法');
      }
      return { dedupKey, reason: boundedReason(parts), valid: false };
    }
    return {
      item: {
        authorization: authorization.data,
        datasetSplit: datasetSplit.data,
        dedupKey: raw.dedupKey as string,
        input: raw.input as EvaluationSampleInputDto,
        projectId: raw.projectId ?? null,
        expected: raw.expected as EvaluationSampleRecord['expected'],
      },
      valid: true,
    };
  });
};

const failure = <T>(
  code: ProjectErrorCode,
  message: string,
  traceId: string,
  fieldErrors: Readonly<Record<string, string>> | null = null,
  retryable = false,
): AppResultDto<T> => ({
  error: {
    code,
    fieldErrors: fieldErrors === null ? null : { ...fieldErrors },
    message,
    retryable,
    traceId,
    userAction: null,
  },
  ok: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonRecord = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** 信封防御校验（IPC 边界之外的第二道；导入路径的唯一一道）。 */
const envelopeFieldErrors = (
  input: Readonly<{ dedupKey?: unknown; expected?: unknown; input?: unknown }>,
): Readonly<Record<string, string>> | null => {
  const errors: Record<string, string> = {};
  const dedupKey = evaluationDedupKeySchema.safeParse(input.dedupKey);
  if (!dedupKey.success) {
    errors.dedupKey = 'dedup_key 需为 3–96 位字母数字与 :._- 组合';
  }
  const envelope = evaluationSampleInputSchema.safeParse(input.input);
  if (!envelope.success) {
    errors.input = envelope.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ');
  }
  const expected = evaluationExpectedSchema.safeParse(input.expected);
  if (!expected.success) {
    errors.expected = expected.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'expected'}: ${issue.message}`)
      .join('; ');
  }
  return Object.keys(errors).length > 0 ? errors : null;
};

const hitCodesOf = (hits: readonly EvaluationRuleHitDto[]): readonly EvaluationIssueCode[] => [
  ...new Set(hits.map((hit) => hit.code)),
];

const annotationDto = (annotation: EvaluationAnnotationRecord) => ({
  annotator: annotation.annotator,
  createdAt: annotation.createdAt,
  guidelineVersion: annotation.guidelineVersion,
  id: annotation.id,
  label: annotation.label,
  rationale: annotation.rationale,
  sampleId: annotation.sampleId,
});

const summarize = (
  record: EvaluationSampleRecord,
  annotations: readonly EvaluationAnnotationRecord[],
): EvaluationSampleSummaryDto => {
  const latest = annotations.at(-1);
  return {
    acceptable: record.expected.acceptable,
    authorization: record.authorization,
    createdAt: record.createdAt,
    datasetSplit: record.datasetSplit,
    dedupKey: record.dedupKey,
    hitCodes: [...hitCodesOf(record.ruleHits ?? [])],
    latestAnnotation: latest === undefined ? null : annotationDto(latest),
    projectId: record.projectId,
    sampleId: record.id,
    sampleType: record.sampleType,
  };
};

interface InsertSampleArgs {
  readonly authorization: EvaluationSampleRecord['authorization'];
  readonly datasetSplit: EvaluationSampleRecord['datasetSplit'];
  readonly dedupKey: string;
  readonly envelope: EvaluationSampleInputDto;
  readonly expected: EvaluationSampleRecord['expected'];
  readonly hits: readonly EvaluationRuleHitDto[];
  readonly projectId: string | null;
  readonly ruleVersion: string;
  readonly traceId: string;
}

const insertAuditedSample = async (
  repositories: EvaluationRepositories,
  dependencies: EvaluationServiceDependencies,
  args: InsertSampleArgs,
): Promise<EvaluationSampleRecord> => {
  const record: EvaluationSampleRecord = {
    id: `eval_${dependencies.newId()}`,
    projectId: args.projectId,
    sampleType: args.envelope.candidate.kind,
    input: args.envelope,
    expected: args.expected,
    authorization: args.authorization,
    dedupKey: args.dedupKey,
    datasetSplit: args.datasetSplit,
    ruleHits: args.hits,
    ruleVersion: args.ruleVersion,
    createdAt: dependencies.now(),
  };
  await repositories.samples.insert(record);
  await repositories.audit.record({
    id: `audit_${dependencies.newId()}`,
    projectId: args.projectId,
    actor: 'USER',
    action: 'EVALUATION_SAMPLE_CREATED',
    objectType: 'EVALUATION_SAMPLE',
    objectId: record.id,
    objectVersionId: null,
    beforeSha256: null,
    afterSha256: null,
    metadata: {
      authorization: args.authorization,
      datasetSplit: args.datasetSplit,
      dedupKey: args.dedupKey,
      hitCodes: [...hitCodesOf(args.hits)],
      sampleType: args.envelope.candidate.kind,
    },
    traceId: args.traceId,
    createdAt: dependencies.now(),
  });
  return record;
};

interface FrozenDerivation {
  readonly characters: string[];
  readonly dialogueRenderMode: EvaluationSampleInputDto['context']['dialogueRenderMode'];
  readonly scenes: string[];
  readonly selected: readonly {
    readonly document: Record<string, unknown>;
    readonly shotId: string;
  }[];
  readonly targetDurationSec: number;
}

const freezeDerivation = async (
  repositories: EvaluationRepositories,
  input: EvaluationCreateFromEpisodeInputDto,
  traceId: string,
): Promise<Readonly<{ derivation: FrozenDerivation } | { denial: AppResultDto<never> }>> => {
  const project = await repositories.projects.findById(input.projectId, 'ACTIVE');
  if (project === null) {
    return { denial: failure('PROJECT_NOT_FOUND', '项目不存在或已删除', traceId) };
  }
  const version = await repositories.episodeVersions.findById(input.expectedVersionId);
  if (version === null) {
    return {
      denial: failure('SCRIPT_VERSION_CONFLICT', '整集版本不存在或已变化，请刷新后重试', traceId),
    };
  }
  const episode = await repositories.episodes.findById(version.episodeId);
  if (
    episode?.deletedAt !== null ||
    episode.projectId !== input.projectId ||
    episode.currentVersionId !== input.expectedVersionId
  ) {
    return {
      denial: failure('SCRIPT_VERSION_CONFLICT', '当前整集版本已变化，请刷新后重试', traceId),
    };
  }
  if (version.status !== 'READY') {
    return {
      denial: failure(
        'EVALUATION_DERIVE_NOT_READY',
        '整集尚未确认 READY，无法派生评测样本',
        traceId,
      ),
    };
  }
  const links = await repositories.episodeVersions.listShotLinks(version.id);
  const documents: Record<string, unknown>[] = [];
  for (const link of links) {
    const shotVersion = await repositories.shotContractVersions.findById(link.shotVersionId);
    const document = shotVersion === null ? null : parseJsonRecord(shotVersion.document);
    if (document === null) {
      return {
        denial: failure(
          'EVALUATION_DERIVE_NOT_READY',
          '派生源数据暂时无法读取，请重试',
          traceId,
          null,
          true,
        ),
      };
    }
    documents.push(document);
  }
  if (documents.length === 0) {
    return {
      denial: failure('EVALUATION_DERIVE_NOT_READY', '整集版本没有镜头，无法派生评测样本', traceId),
    };
  }
  const indexes = input.shotIndexes ?? documents.map((_, index) => index);
  const selected = indexes.flatMap((index) => {
    const link = links[index];
    const document = link === undefined ? undefined : documents[index];
    return link !== undefined && document !== undefined ? [{ document, shotId: link.shotId }] : [];
  });
  if (selected.length === 0) {
    return {
      denial: failure('EVALUATION_SAMPLE_INVALID', '所选镜头范围为空', traceId, {
        shotIndexes: '未命中任何镜头',
      }),
    };
  }
  // 上下文以整集版本快照冻结（角色/场景取全集并集，排序保证确定性）。
  const characters = [
    ...new Set(
      documents.flatMap((document) => {
        const content = isRecord(document.content) ? document.content : null;
        return content !== null && Array.isArray(content.character_ids)
          ? content.character_ids.filter((id): id is string => typeof id === 'string')
          : [];
      }),
    ),
  ].sort();
  const scenes = [
    ...new Set(
      documents
        .map((document) => {
          const content = isRecord(document.content) ? document.content : null;
          return content !== null && typeof content.scene_id === 'string' ? content.scene_id : null;
        })
        .filter((sceneId): sceneId is string => sceneId !== null),
    ),
  ].sort();
  return {
    derivation: {
      characters,
      dialogueRenderMode: project.dialogueRenderMode,
      scenes,
      selected,
      targetDurationSec: version.targetDurationSec,
    },
  };
};

/** 派生样本期望结论由引擎结果推导（WARN 不阻断），待人工标注校正。 */
const derivedExpected = (
  hits: readonly EvaluationRuleHitDto[],
): EvaluationSampleRecord['expected'] => ({
  acceptable: hits.every((hit) => hit.code === 'EVAL_ISSUE_PRODUCIBILITY_WARN'),
  expectedIssueCodes: [...hitCodesOf(hits)],
  referenceContract: null,
});

export const createEvaluationService = (
  dependencies: EvaluationServiceDependencies,
): EvaluationService => ({
  async listSamples(input, _traceId) {
    const summaries = await dependencies.unitOfWork.run(async (repositories) => {
      const records = await repositories.samples.list({
        datasetSplit: input.datasetSplit ?? null,
        projectId: input.projectId ?? null,
        sampleType: input.sampleType ?? null,
        scope: input.scope,
      });
      const mapped: EvaluationSampleSummaryDto[] = [];
      for (const record of records) {
        const annotations = await repositories.annotations.listBySampleId(record.id);
        mapped.push(summarize(record, annotations));
      }
      return mapped.sort((left, right) =>
        left.createdAt === right.createdAt
          ? right.sampleId.localeCompare(left.sampleId)
          : right.createdAt.localeCompare(left.createdAt),
      );
    });
    return { data: { samples: summaries }, ok: true };
  },

  async getSample(input, traceId) {
    const detail = await dependencies.unitOfWork.run(async (repositories) => {
      const record = await repositories.samples.findById(input.sampleId);
      if (record === null) return null;
      const annotations = await repositories.annotations.listBySampleId(record.id);
      return { annotations, record };
    });
    if (detail === null) {
      return failure('EVALUATION_NOT_FOUND', '样本不存在', traceId);
    }
    return {
      data: {
        ...summarize(detail.record, detail.annotations),
        annotations: detail.annotations.map(annotationDto),
        expected: detail.record.expected,
        hits: [...(detail.record.ruleHits ?? [])],
        input: detail.record.input,
        // 0017 前的行理论上不存在写入路径；兜底保持回执可解析。
        ruleVersion: detail.record.ruleVersion ?? PRODUCIBILITY_RULES_VERSION,
      },
      ok: true,
    };
  },

  async createSample(input, traceId) {
    const fieldErrors = envelopeFieldErrors(input);
    if (fieldErrors !== null) {
      return failure('EVALUATION_SAMPLE_INVALID', '样本信封或期望结论非法', traceId, fieldErrors);
    }
    return dependencies.unitOfWork.run(async (repositories) => {
      if (input.projectId != null) {
        const project = await repositories.projects.findById(input.projectId, 'ACTIVE');
        if (project === null) {
          return failure('PROJECT_NOT_FOUND', '项目不存在或已删除', traceId);
        }
      }
      const existing = await repositories.samples.findByDedupKey(input.dedupKey);
      if (existing !== null) {
        return failure('EVALUATION_DEDUP_CONFLICT', 'dedup_key 已存在', traceId);
      }
      const evaluation = dependencies.rules.evaluate(input.input);
      const record = await insertAuditedSample(repositories, dependencies, {
        authorization: input.authorization,
        datasetSplit: input.datasetSplit,
        dedupKey: input.dedupKey,
        envelope: input.input,
        expected: input.expected,
        hits: evaluation.hits,
        projectId: input.projectId ?? null,
        ruleVersion: evaluation.ruleVersion,
        traceId,
      });
      return { data: summarize(record, []), ok: true as const };
    });
  },

  async createFromEpisode(input, traceId) {
    const frozen = await dependencies.unitOfWork.run((repositories) =>
      freezeDerivation(repositories, input, traceId),
    );
    if ('denial' in frozen) return frozen.denial;

    const samples: EvaluationSampleSummaryDto[] = [];
    for (const shot of frozen.derivation.selected) {
      const dedupKey = `derive:${input.projectId}:${input.expectedVersionId}:${shot.shotId}`;
      const envelope: EvaluationSampleInputDto = {
        candidate: { document: shot.document, kind: 'SHOT_CONTRACT' },
        context: {
          characters: frozen.derivation.characters,
          dialogueRenderMode: frozen.derivation.dialogueRenderMode,
          previousShotSummary: null,
          scenes: frozen.derivation.scenes,
          targetDurationSec: null,
        },
      };
      const evaluation = dependencies.rules.evaluate(envelope);
      const summary = await dependencies.unitOfWork.run(async (repositories) => {
        const replayed = await repositories.samples.findByDedupKey(dedupKey);
        if (replayed !== null) {
          const annotations = await repositories.annotations.listBySampleId(replayed.id);
          return summarize(replayed, annotations);
        }
        const record = await insertAuditedSample(repositories, dependencies, {
          authorization: input.authorization,
          datasetSplit: input.datasetSplit,
          dedupKey,
          envelope,
          expected: derivedExpected(evaluation.hits),
          hits: evaluation.hits,
          projectId: input.projectId,
          ruleVersion: evaluation.ruleVersion,
          traceId: input.requestId,
        });
        return summarize(record, []);
      });
      samples.push(summary);
    }
    return { data: { samples }, ok: true };
  },

  async deleteSample(input, traceId) {
    return dependencies.unitOfWork.run(async (repositories) => {
      const record = await repositories.samples.findById(input.sampleId);
      if (record === null) {
        return failure('EVALUATION_NOT_FOUND', '样本不存在', traceId);
      }
      const deletedAnnotations = await repositories.samples.deleteById(input.sampleId);
      if (deletedAnnotations === null) {
        return failure('EVALUATION_NOT_FOUND', '样本不存在', traceId);
      }
      await repositories.audit.record({
        id: `audit_${dependencies.newId()}`,
        projectId: record.projectId,
        actor: 'USER',
        action: 'EVALUATION_SAMPLE_DELETED',
        objectType: 'EVALUATION_SAMPLE',
        objectId: input.sampleId,
        objectVersionId: null,
        beforeSha256: null,
        afterSha256: null,
        metadata: {
          datasetSplit: record.datasetSplit,
          deletedAnnotations,
          dedupKey: record.dedupKey,
          sampleType: record.sampleType,
        },
        traceId: input.requestId,
        createdAt: dependencies.now(),
      });
      return {
        data: { deletedAnnotations, sampleId: input.sampleId },
        ok: true as const,
      };
    });
  },

  async addAnnotation(input, traceId) {
    if (input.guidelineVersion !== EVALUATION_GUIDELINE_VERSION) {
      return failure('EVALUATION_SAMPLE_INVALID', '标注指南版本不受支持', traceId, {
        guidelineVersion: `仅支持当前指南版本 ${EVALUATION_GUIDELINE_VERSION}`,
      });
    }
    return dependencies.unitOfWork.run(async (repositories) => {
      const sample = await repositories.samples.findById(input.sampleId);
      if (sample === null) {
        return failure('EVALUATION_NOT_FOUND', '样本不存在', traceId);
      }
      const record: EvaluationAnnotationRecord = {
        id: `anno_${dependencies.newId()}`,
        sampleId: input.sampleId,
        guidelineVersion: input.guidelineVersion,
        label: input.label,
        rationale: input.rationale,
        annotator: input.annotator,
        createdAt: dependencies.now(),
      };
      await repositories.annotations.insert(record);
      await repositories.audit.record({
        id: `audit_${dependencies.newId()}`,
        projectId: sample.projectId,
        actor: 'USER',
        action: 'EVALUATION_ANNOTATION_ADDED',
        objectType: 'EVALUATION_ANNOTATION',
        objectId: record.id,
        objectVersionId: null,
        beforeSha256: null,
        afterSha256: null,
        metadata: {
          guidelineVersion: input.guidelineVersion,
          sampleId: input.sampleId,
          verdict: input.label.verdict,
        },
        traceId: input.requestId,
        createdAt: dependencies.now(),
      });
      const annotations = await repositories.annotations.listBySampleId(input.sampleId);
      return { data: { annotations: annotations.map(annotationDto) }, ok: true as const };
    });
  },

  async importBatch(input, traceId) {
    // ① 文件选择（事务外，Main Open Dialog）；取消直接返回，路径不进入任何回执。
    const selected = await dependencies.file.readSelectedJson();
    if (selected === null) {
      return failure('TRANSFER_FILE_CANCELLED', '已取消导入', traceId);
    }
    // ② staging：文件级损坏整体拒绝（零入库）。
    const stagedItems = stageImportEnvelope(selected.bytes);
    if (stagedItems === null) {
      return failure('EVALUATION_IMPORT_INVALID', '导入文件不是有效的评测集导入信封', traceId);
    }
    // ③ 逐样本独立短事务：合法入库、重复/非法拒绝，聚合回执。
    const items: EvaluationImportItemResultDto[] = [];
    for (const staged of stagedItems) {
      const outcome = await dependencies.unitOfWork.run(async (repositories) => {
        if (!staged.valid) {
          return {
            dedupKey: staged.dedupKey,
            reason: staged.reason,
            sampleId: null,
            status: 'REJECTED' as const,
          };
        }
        const existing = await repositories.samples.findByDedupKey(staged.item.dedupKey);
        if (existing !== null) {
          return {
            dedupKey: staged.item.dedupKey,
            reason: 'dedup_key 已存在',
            sampleId: existing.id,
            status: 'DUPLICATE' as const,
          };
        }
        if (staged.item.projectId != null) {
          const project = await repositories.projects.findById(staged.item.projectId, 'ACTIVE');
          if (project === null) {
            return {
              dedupKey: staged.item.dedupKey,
              reason: '归属项目不存在',
              sampleId: null,
              status: 'REJECTED' as const,
            };
          }
        }
        const evaluation = dependencies.rules.evaluate(staged.item.input);
        const record = await insertAuditedSample(repositories, dependencies, {
          authorization: staged.item.authorization,
          datasetSplit: staged.item.datasetSplit,
          dedupKey: staged.item.dedupKey,
          envelope: staged.item.input,
          expected: staged.item.expected,
          hits: evaluation.hits,
          projectId: staged.item.projectId ?? null,
          ruleVersion: evaluation.ruleVersion,
          traceId: input.requestId,
        });
        return {
          dedupKey: staged.item.dedupKey,
          reason: null,
          sampleId: record.id,
          status: 'CREATED' as const,
        };
      });
      items.push(outcome);
    }
    // ④ 批次审计（一次）：回执计数入 metadata，不含路径。
    await dependencies.unitOfWork.run(async (repositories) => {
      await repositories.audit.record({
        id: `audit_${dependencies.newId()}`,
        projectId: null,
        actor: 'USER',
        action: 'EVALUATION_BATCH_IMPORTED',
        objectType: 'EVALUATION_SAMPLE',
        objectId: `batch_${dependencies.newId()}`,
        objectVersionId: null,
        beforeSha256: null,
        afterSha256: null,
        metadata: {
          created: items.filter((item) => item.status === 'CREATED').length,
          duplicate: items.filter((item) => item.status === 'DUPLICATE').length,
          rejected: items.filter((item) => item.status === 'REJECTED').length,
        },
        traceId: input.requestId,
        createdAt: dependencies.now(),
      });
    });
    return { data: { items }, ok: true };
  },
});
