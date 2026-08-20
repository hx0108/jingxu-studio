import type { FormatProfile } from '@jingxu/domain';
import type { AppResultDto, ProjectErrorCode } from '@jingxu/contracts';

import type { ScriptUnitOfWorkPort } from '../ports/script/index';
import type { FormatProfileRepository } from '../ports/project/format-profile-repository';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';
import {
  extractShotCollectionBibleKeys,
  validateShotSetCollection,
} from './shot-collection-validator';

/**
 * 分镜整集导出（storyboard-export，PRD 9.7.1/9.8）。
 *
 * 三段式用例：①READY_EXPORT 门禁与组装（读事务内）→ ②文件落盘（注入 sink，
 * main 侧 save dialog + 写文件；路径绝不进入本层与回执）→ ③审计留痕（独立
 * 短事务）。Σ 软带 [60,120] 偏离须用户确认并留原因（D5：单命令确认重发）。
 */

export interface StoryboardExportInput {
  /** 越带偏离原因；Σ∉[60,120] 时与 warnConfirmed 同为必填（服务层判定）。 */
  readonly deviationReason?: string | null | undefined;
  readonly episodeId: string;
  /** 基线整集版本 id；与当前 head 不一致视为并发冲突。 */
  readonly expectedVersionId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly warnConfirmed?: boolean | undefined;
}

export interface StoryboardExportSummary {
  readonly byteSize: number;
  readonly episodeVersionId: string;
  readonly exportId: string;
  readonly fileSha256: string;
  readonly totalDurationSec: number;
}

/** 文件落盘端口（main 实现：save dialog + 写文件 + 哈希；E2E 注入定名路径）。 */
export interface StoryboardExportFileSink {
  write(
    defaultFileName: string,
    content: string,
  ): Promise<
    | Readonly<{ byteSize: number; fileSha256: string; outcome: 'written' }>
    | Readonly<{ outcome: 'cancelled' }>
    | Readonly<{ outcome: 'failed' }>
  >;
}

export interface StoryboardExportServiceDependencies {
  readonly appVersion: string;
  /** EpisodeStoryboardExport 1.1.0 正式校验（注入 registry.validate）。 */
  readonly validateExportDocument: (
    document: unknown,
  ) =>
    | Readonly<{ valid: true }>
    | Readonly<{ code: string; details?: readonly string[]; valid: false }>;
  readonly formatProfiles: Pick<FormatProfileRepository, 'findCurrent'>;
  readonly newId: () => string;
  readonly now: () => string;
  readonly sink: StoryboardExportFileSink;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

export interface StoryboardExportService {
  exportEpisode(
    input: StoryboardExportInput,
    traceId: string,
  ): Promise<AppResultDto<StoryboardExportSummary>>;
}

/** PRD 规则 8 软带；[30,180] 硬界由集合校验与 envelope schema 兜底。 */
const DURATION_SOFT_MIN = 60;
const DURATION_SOFT_MAX = 120;
const DETAIL_LIMIT = 10;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeParse = (document: string): unknown => {
  try {
    return JSON.parse(document);
  } catch {
    return null;
  }
};

/** 组装输入：全部为已读快照事实，组装过程零 I/O、零时钟（时间戳由调用方注入）。 */
export interface StoryboardExportAssemblyInput {
  readonly appVersion: string;
  readonly episodeId: string;
  readonly episodeVersionNo: number;
  readonly exportedAt: string;
  readonly exportId: string;
  readonly formatProfile: FormatProfile;
  readonly projectId: string;
  readonly shotDocuments: readonly Readonly<Record<string, unknown>>[];
  readonly storyBibleVersionId: string;
  readonly targetDurationSec: number;
}

/**
 * EpisodeStoryboardExport 1.1.0 确定性组装纯函数：
 * FormatProfile 聚合投影（subtitle_safe_area 四键改名 *_pct）、
 * contains_ai_assisted_content = 任一镜头 provenance.source_type ≠ HUMAN_CREATED
 * （AI_GENERATED/AI_ASSISTED 均属 AI 参与内容）、shot_contracts 原样携带 locked_paths。
 */
export const assembleStoryboardExport = (
  input: StoryboardExportAssemblyInput,
): Readonly<Record<string, unknown>> => {
  const spec = input.formatProfile.spec;
  const area = spec.subtitleSafeArea;
  return {
    episode_id: input.episodeId,
    episode_version: input.episodeVersionNo,
    export_id: input.exportId,
    export_provenance: {
      app_version: input.appVersion,
      contains_ai_assisted_content: input.shotDocuments.some((document) => {
        const provenance = document.provenance;
        return isRecord(provenance) && provenance.source_type !== 'HUMAN_CREATED';
      }),
      exported_by: 'LOCAL_USER',
    },
    exported_at: input.exportedAt,
    format_profile: {
      aspect_ratio: spec.aspectRatio,
      fps: spec.fps,
      height: spec.height,
      id: input.formatProfile.id,
      language: spec.language,
      subtitle_safe_area: {
        bottom_pct: area.bottom,
        left_pct: area.left,
        right_pct: area.right,
        top_pct: area.top,
      },
      width: spec.width,
    },
    lineage_completeness: 'CURRENT_ONLY',
    project_id: input.projectId,
    schema_version: '1.1.0',
    shot_contracts: input.shotDocuments,
    story_bible_version_id: input.storyBibleVersionId,
    target_duration_sec: input.targetDurationSec,
  };
};

type PrepareFailure = Readonly<{
  readonly code: ProjectErrorCode;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  readonly message: string;
  readonly ok: false;
  readonly retryable: boolean;
}>;

const prepareFailure = (
  code: ProjectErrorCode,
  message: string,
  fieldErrors: Readonly<Record<string, string>> | null = null,
  retryable = false,
): PrepareFailure => ({ code, fieldErrors, message, ok: false, retryable });

export const createStoryboardExportService = (
  dependencies: StoryboardExportServiceDependencies,
): StoryboardExportService => {
  const exportEpisode = async (
    input: StoryboardExportInput,
    traceId: string,
  ): Promise<AppResultDto<StoryboardExportSummary>> => {
    // FormatProfile 当前投影在事务外读取（纯读，规格不可变；envelope 校验兜底一致性）。
    const formatProfile = await dependencies.formatProfiles.findCurrent(input.projectId);
    if (formatProfile === null) return scriptPersistenceFailure(traceId);

    // ① 门禁与组装：读事务内完成（不触文件系统/Provider，遵守 unitOfWork 约束）。
    const prepared = await dependencies.unitOfWork.run(async (repositories) => {
      const head = await repositories.stageHeads.find(
        input.projectId,
        input.episodeId,
        'SHOT_CONTRACT',
      );
      if (head?.currentVersionId !== input.expectedVersionId) {
        return prepareFailure('SCRIPT_VERSION_CONFLICT', '当前版本已变化，请刷新后重试');
      }
      const current = await repositories.episodeVersions.findById(head.currentVersionId);
      if (current?.episodeId !== input.episodeId) {
        return prepareFailure('SCRIPT_VERSION_NOT_FOUND', '指定分镜版本不存在');
      }
      if (current.status !== 'READY') {
        return prepareFailure('EXPORT_NOT_READY', '整集尚未确认 READY，无法导出');
      }
      const links = await repositories.episodeVersions.listShotLinks(current.id);
      const shotDocuments: Readonly<Record<string, unknown>>[] = [];
      for (const link of links) {
        const shotVersion = await repositories.shotContractVersions.findById(link.shotVersionId);
        if (shotVersion === null) {
          return prepareFailure('SCRIPT_VERSION_NOT_FOUND', '指定分镜版本不存在');
        }
        const document = safeParse(shotVersion.document);
        if (!isRecord(document))
          return prepareFailure(
            'PROJECT_PERSISTENCE_FAILED',
            '剧本数据暂时无法保存，请重试',
            null,
            true,
          );
        shotDocuments.push(document);
      }
      const bible = await repositories.storyBibleVersions.findById(current.storyBibleVersionId);
      const bibleKeys =
        bible === null ? null : extractShotCollectionBibleKeys(safeParse(bible.document));
      if (bibleKeys === null) {
        return prepareFailure('STALE_INPUT', '分镜引用的故事圣经不可用，请重新生成分镜');
      }
      const collection = validateShotSetCollection(shotDocuments, bibleKeys);
      if (!collection.valid) {
        return prepareFailure('EXPORT_COLLECTION_INVALID', '整集分镜集合校验未通过，无法导出', {
          details: [collection.code, ...collection.details].slice(0, DETAIL_LIMIT).join('; '),
        });
      }
      const totalDurationSec = shotDocuments.reduce(
        (sum, document) => sum + Number(document.target_duration_sec ?? 0),
        0,
      );
      const deviates = totalDurationSec < DURATION_SOFT_MIN || totalDurationSec > DURATION_SOFT_MAX;
      const reason = typeof input.deviationReason === 'string' ? input.deviationReason.trim() : '';
      if (deviates && (input.warnConfirmed !== true || reason === '')) {
        return prepareFailure(
          'EXPORT_DURATION_DEVIATION',
          `整集时长 ${String(totalDurationSec)} 秒偏离 ${String(DURATION_SOFT_MIN)}–${String(DURATION_SOFT_MAX)} 秒目标区间`,
          { totalDurationSec: String(totalDurationSec) },
        );
      }
      const exportId = `export_${dependencies.newId()}`;
      const envelope = assembleStoryboardExport({
        appVersion: dependencies.appVersion,
        episodeId: input.episodeId,
        episodeVersionNo: current.versionNo,
        exportedAt: dependencies.now(),
        exportId,
        formatProfile,
        projectId: input.projectId,
        shotDocuments,
        storyBibleVersionId: current.storyBibleVersionId,
        targetDurationSec: current.targetDurationSec,
      });
      const schemaResult = dependencies.validateExportDocument(envelope);
      if (!schemaResult.valid) {
        return prepareFailure(
          'EXPORT_SCHEMA_INVALID',
          '导出物未通过 EpisodeStoryboardExport 校验',
          {
            details: (schemaResult.details ?? [schemaResult.code])
              .slice(0, DETAIL_LIMIT)
              .join('; '),
          },
        );
      }
      return {
        deviationReason: deviates ? reason : null,
        envelope,
        episodeVersionId: current.id,
        exportId,
        ok: true as const,
        totalDurationSec,
      };
    });
    if (!prepared.ok) {
      return scriptFailure(
        prepared.code,
        prepared.message,
        traceId,
        prepared.fieldErrors,
        prepared.retryable,
      );
    }

    // ② 落盘：main 侧 sink（save dialog + 写文件 + sha256）。取消/失败均不留痕。
    const content = JSON.stringify(prepared.envelope, null, 2);
    const written = await dependencies.sink.write(
      `export_${input.projectId}_${input.episodeId}_v${String(
        // 版本号参与默认文件名：取自 envelope（versionNo），不重复查库。
        prepared.envelope.episode_version,
      )}.json`,
      content,
    );
    if (written.outcome === 'cancelled') {
      return scriptFailure('EXPORT_CANCELLED', '已取消导出', traceId);
    }
    if (written.outcome === 'failed') {
      return scriptFailure(
        'EXPORT_FILE_WRITE_FAILED',
        '导出文件写入失败，请检查保存位置后重试',
        traceId,
        null,
        true,
      );
    }

    // ③ 审计留痕（独立短事务）：失败必须响亮——回报哈希，不静默吞掉已落盘文件。
    try {
      await dependencies.unitOfWork.run(async (repositories) => {
        await repositories.audit.record({
          action: 'STORYBOARD_EXPORTED',
          actor: 'USER',
          afterSha256: written.fileSha256,
          beforeSha256: null,
          createdAt: dependencies.now(),
          id: dependencies.newId(),
          metadata: {
            byteSize: written.byteSize,
            deviationReason: prepared.deviationReason,
            fileSha256: written.fileSha256,
            totalDurationSec: prepared.totalDurationSec,
          },
          objectId: input.episodeId,
          objectType: 'EPISODE_VERSION',
          objectVersionId: prepared.episodeVersionId,
          projectId: input.projectId,
          traceId,
        });
      });
    } catch {
      return scriptFailure(
        'EXPORT_AUDIT_FAILED',
        '导出已完成但留痕失败，请记录文件哈希后联系支持',
        traceId,
        { fileSha256: written.fileSha256 },
      );
    }
    return {
      data: {
        byteSize: written.byteSize,
        episodeVersionId: prepared.episodeVersionId,
        exportId: prepared.exportId,
        fileSha256: written.fileSha256,
        totalDurationSec: prepared.totalDurationSec,
      },
      ok: true,
    };
  };

  return { exportEpisode };
};
