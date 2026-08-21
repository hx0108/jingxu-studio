import type {
  AppResultDto,
  ProjectErrorCode,
  TransferExportProjectInputDto,
  TransferExportResultDto,
  TransferImportMode,
  TransferImportProjectInputDto,
  TransferImportResultDto,
  TransferWarningCode,
} from '@jingxu/contracts';

import type { TransferFilePort, TransferUnitOfWorkPort } from '../ports/transfer';
import type { TransferJson } from '../ports/transfer/transfer-types';
import { assembleStoryboardExport } from '../script/storyboard-export-service';
import { assembleTransferBundle, stableTransferJson } from './transfer-bundle';
import {
  restoreOriginProjectFromBundle,
  writeNewProjectFromBundle,
} from './transfer-import-writer';
import {
  decodeTransferBytes,
  parseTransferJson,
  TransferValidationError,
  validateTransferBundleShape,
  validateTransferHash,
  validateTransferReferences,
} from './transfer-staging';

export type TransferSchemaValidator = (
  document: unknown,
) => Readonly<{ readonly valid: true }> | Readonly<{ readonly valid: false }>;

export interface TransferServiceDependencies {
  readonly file: TransferFilePort;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (text: string) => string;
  readonly newId: () => string;
  readonly now: () => string;
  /** ProjectTransferBundle 1.0.0 正式校验（注入 registry.validate）。 */
  readonly validateBundleSchema: TransferSchemaValidator;
  /** EpisodeStoryboardExport 1.1.0 校验（导出侧组装后自检）。 */
  readonly validateStoryboardEnvelope: TransferSchemaValidator;
  readonly unitOfWork: TransferUnitOfWorkPort;
}

export interface TransferService {
  exportProject(
    input: TransferExportProjectInputDto,
    traceId: string,
  ): Promise<AppResultDto<TransferExportResultDto>>;
  importProject(
    input: TransferImportProjectInputDto,
    traceId: string,
  ): Promise<AppResultDto<TransferImportResultDto>>;
}

const isRecord = (value: unknown): value is TransferJson =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseDocument = (raw: string): TransferJson | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const failure = <T>(
  code: ProjectErrorCode,
  message: string,
  traceId: string,
  retryable = false,
  userAction: string | null = null,
): AppResultDto<T> => ({
  error: { code, fieldErrors: null, message, retryable, traceId, userAction },
  ok: false,
});

const bundleHasMediaReferences = (bundle: TransferJson): boolean => {
  const storyboard = bundle.episode_storyboard;
  if (!isRecord(storyboard) || !Array.isArray(storyboard.shot_contracts)) return false;
  return storyboard.shot_contracts.some(
    (shot) =>
      isRecord(shot) &&
      isRecord(shot.continuity) &&
      Array.isArray(shot.continuity.asset_version_ids) &&
      shot.continuity.asset_version_ids.length > 0,
  );
};

const importWarnings = (
  bundle: TransferJson,
  importMode: TransferImportMode,
): readonly TransferWarningCode[] => {
  const warningCodes: TransferWarningCode[] = ['TRANSFER_CURRENT_ONLY'];
  if (importMode === 'NEW_PROJECT') {
    warningCodes.push('TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE');
  }
  if (bundleHasMediaReferences(bundle)) {
    warningCodes.push('TRANSFER_MEDIA_REFERENCE_MISSING');
  }
  return warningCodes;
};

export const createTransferService = (
  dependencies: TransferServiceDependencies,
): TransferService => ({
  async exportProject(input, traceId) {
    const inputFingerprint = dependencies.hashPayload({
      episodeId: input.episodeId,
      expectedVersionId: input.expectedVersionId,
      projectId: input.projectId,
    });
    // ① 幂等重放：同 requestId 已成功导出 → 原样返回摘要；不同载荷 → 拒绝。
    const replayed = await dependencies.unitOfWork.run((repositories) =>
      repositories.transfer.findExportByRequestId(input.requestId),
    );
    if (replayed?.status === 'SUCCEEDED') {
      const stored = replayed.resultSummary;
      if (stored?.inputFingerprint !== inputFingerprint) {
        return failure('TRANSFER_IDEMPOTENCY_CONFLICT', '请求标识已用于不同导出命令', traceId);
      }
      return {
        data: {
          byteSize: replayed.byteSize,
          exportId: replayed.id,
          fileSha256: replayed.payloadSha256,
          warningCodes: [...stored.warningCodes],
        },
        ok: true,
      };
    }

    // ② 读事务内组装（零文件 I/O）：门禁 + 快照投影 + Schema 自检。
    const prepared = await dependencies.unitOfWork.run(async (repositories) => {
      const deny = (code: ProjectErrorCode, message: string) => ({
        denial: failure<TransferExportResultDto>(code, message, traceId),
      });
      const project = await repositories.projects.findById(input.projectId, 'ACTIVE');
      if (project === null) {
        return deny('PROJECT_NOT_FOUND', '项目不存在或已删除');
      }
      const formatProfile = await repositories.formatProfiles.findCurrent(input.projectId);
      if (formatProfile === null) {
        return deny('EXPORT_NOT_READY', '项目尚未形成可导出的完整快照');
      }
      const readStageOutput = async (
        stage: 'STORY_BIBLE' | 'CONCEPT' | 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT',
        episodeId: string | null,
      ): Promise<{ output: TransferJson; versionId: string } | null> => {
        const head = await repositories.stageHeads.find(input.projectId, episodeId, stage);
        if (head === null) return null;
        const version =
          stage === 'STORY_BIBLE'
            ? await repositories.storyBibleVersions.findById(head.currentVersionId)
            : await repositories.scriptVersions.findById(head.currentVersionId);
        if (version === null) return null;
        const parsed = parseDocument(version.document);
        return parsed === null ? null : { output: parsed, versionId: version.id };
      };
      const storyBible = await readStageOutput('STORY_BIBLE', null);
      const concept = await readStageOutput('CONCEPT', null);
      const episodeOutline = await readStageOutput('EPISODE_OUTLINE', input.episodeId);
      const beatSheet = await readStageOutput('BEAT_SHEET', input.episodeId);
      const sceneScript = await readStageOutput('SCENE_SCRIPT', input.episodeId);
      if (
        storyBible === null ||
        concept === null ||
        episodeOutline === null ||
        beatSheet === null ||
        sceneScript === null
      ) {
        return deny(
          'EXPORT_NOT_READY',
          '项目尚未形成可导出的完整快照（缺少已确认的圣经/脚本阶段）',
        );
      }
      const storyboardHead = await repositories.stageHeads.find(
        input.projectId,
        input.episodeId,
        'SHOT_CONTRACT',
      );
      if (storyboardHead?.currentVersionId !== input.expectedVersionId) {
        return deny('SCRIPT_VERSION_CONFLICT', '当前整集版本已变化，请刷新后重试');
      }
      const current = await repositories.episodeVersions.findById(storyboardHead.currentVersionId);
      if (current?.status !== 'READY') {
        return deny('EXPORT_NOT_READY', '整集尚未确认 READY，无法导出');
      }
      const links = await repositories.episodeVersions.listShotLinks(current.id);
      const shotDocuments: TransferJson[] = [];
      for (const link of links) {
        const shotVersion = await repositories.shotContractVersions.findById(link.shotVersionId);
        const document = shotVersion === null ? null : parseDocument(shotVersion.document);
        if (document === null) {
          return deny('TRANSFER_BUNDLE_INVALID', '项目快照数据暂时无法导出，请重试');
        }
        shotDocuments.push(document);
      }
      const envelope = assembleStoryboardExport({
        appVersion: 'jingxu-studio',
        episodeId: input.episodeId,
        episodeVersionNo: current.versionNo,
        exportedAt: dependencies.now(),
        exportId: `export_${dependencies.newId()}`,
        formatProfile,
        projectId: input.projectId,
        shotDocuments,
        storyBibleVersionId: current.storyBibleVersionId,
        targetDurationSec: current.targetDurationSec,
      });
      if (!dependencies.validateStoryboardEnvelope(envelope).valid) {
        return deny('EXPORT_SCHEMA_INVALID', '导出物未通过 EpisodeStoryboardExport 校验');
      }
      const assembled = assembleTransferBundle({
        bundleId: `bundle_${dependencies.newId()}`,
        episodeStoryboard: envelope,
        exportedAt: dependencies.now(),
        projectSnapshot: {
          creationMode: project.creationMode,
          dialogueRenderMode: project.dialogueRenderMode,
          name: project.name,
          projectId: project.id,
        },
        scriptStageOutputs: [concept, episodeOutline, beatSheet, sceneScript],
        storyBible,
      });
      if (!dependencies.validateBundleSchema(assembled.bundle).valid) {
        return deny('TRANSFER_BUNDLE_INVALID', '项目快照未通过 ProjectTransferBundle 校验');
      }
      return {
        assembled,
        episodeVersionId: current.id,
        ok: true as const,
      };
    });
    if ('denial' in prepared) return prepared.denial;

    // ③ 落盘（事务外）：默认拒绝覆盖；取消/失败不留成功记录。
    const bytes = new TextEncoder().encode(stableTransferJson(prepared.assembled.bundle));
    const written = await dependencies.file.writeJsonAtomically(
      `project-transfer-${input.projectId}.json`,
      bytes,
      input.overwriteConfirmed,
    );
    if (written.outcome === 'cancelled') {
      return failure('TRANSFER_FILE_CANCELLED', '已取消导出', traceId);
    }
    if (written.outcome === 'refused') {
      return failure(
        'TRANSFER_FILE_WRITE_FAILED',
        '目标文件已存在，默认拒绝覆盖',
        traceId,
        false,
        '如需覆盖请显式确认后重试',
      );
    }
    if (written.outcome === 'failed') {
      return failure('TRANSFER_FILE_WRITE_FAILED', '导出文件写入失败，请重试', traceId, true);
    }

    // ④ 完成记录（独立短事务）：requestId 幂等事实源。
    const exportId = `export_${dependencies.newId()}`;
    const warningCodes = [...prepared.assembled.warningCodes];
    try {
      await dependencies.unitOfWork.run(async (repositories) => {
        await repositories.transfer.insertExport({
          byteSize: written.byteSize,
          createdAt: dependencies.now(),
          episodeId: input.episodeId,
          episodeVersionId: prepared.episodeVersionId,
          errorCode: null,
          finishedAt: dependencies.now(),
          id: exportId,
          overwritePolicy: input.overwriteConfirmed ? 'CONFIRMED_OVERWRITE' : 'REJECT',
          payloadSha256: written.sha256,
          projectId: input.projectId,
          requestId: input.requestId,
          resultSummary: {
            inputFingerprint,
            warningCodes,
          },
          status: 'SUCCEEDED',
          targetRef: written.targetRef,
        });
      });
    } catch {
      return failure(
        'TRANSFER_PERSISTENCE_FAILED',
        '导出文件已写入，但记录保存失败',
        traceId,
        true,
        `文件 SHA-256：${written.sha256}`,
      );
    }
    return {
      data: { byteSize: written.byteSize, exportId, fileSha256: written.sha256, warningCodes },
      ok: true,
    };
  },

  async importProject(input, traceId) {
    // ① 文件选择（事务外，Main Open Dialog）；取消直接返回。
    const selected = await dependencies.file.readSelectedJson();
    if (selected === null) {
      return failure('TRANSFER_FILE_CANCELLED', '已取消导入', traceId);
    }

    // ② staging 校验链（大小→UTF-8→JSON→形状→Hash→Schema→引用）。
    const recordFailure = async (code: ProjectErrorCode): Promise<void> => {
      try {
        await dependencies.unitOfWork.run(async (repositories) => {
          await repositories.transfer.insertImport({
            createdAt: dependencies.now(),
            finishedAt: dependencies.now(),
            id: `import_${dependencies.newId()}`,
            idMapping: null,
            importMode: input.importMode,
            projectId: null,
            requestId: input.requestId,
            resultSummary: null,
            sourceRef: selected.sourceRef,
            sourceSha256: selected.sha256,
            status: 'FAILED',
            validationErrors: [code],
          });
        });
      } catch {
        // 证据写入失败不掩盖原始错误（失败必须响亮）。
      }
    };
    let bundle: TransferJson;
    let content: string;
    try {
      content = decodeTransferBytes(selected.bytes);
      bundle = validateTransferBundleShape(parseTransferJson(content));
      validateTransferHash(content, selected.sha256, dependencies.hashText);
      if (!dependencies.validateBundleSchema(bundle).valid) {
        throw new TransferValidationError('TRANSFER_BUNDLE_INVALID');
      }
      validateTransferReferences(bundle);
    } catch (caught) {
      const code: ProjectErrorCode =
        caught instanceof TransferValidationError ? caught.code : 'TRANSFER_BUNDLE_INVALID';
      const message =
        code === 'TRANSFER_HASH_MISMATCH'
          ? '导入文件完整性校验失败，请重新导出后再导入'
          : code === 'TRANSFER_BUNDLE_UNSUPPORTED'
            ? '项目快照 Schema 版本不受支持'
            : '导入文件不是有效的 ProjectTransferBundle';
      await recordFailure(code);
      return failure(code, message, traceId);
    }

    // ③ 正式导入：ID Mapping/重写/版本/阶段头/依赖/审计/import_records 同一事务。
    const warningCodes = importWarnings(bundle, input.importMode);
    const sourceProjectId = String((bundle.project_snapshot as TransferJson).project_id);
    try {
      const result = await dependencies.unitOfWork.run(
        async (
          repositories,
        ): Promise<
          { readonly replay: TransferImportResultDto | null } & TransferImportResultDto
        > => {
          const replayed = await repositories.transfer.findImportByRequestId(input.requestId);
          if (
            replayed !== null &&
            replayed.status === 'SUCCEEDED' &&
            (replayed.sourceSha256 !== selected.sha256 || replayed.importMode !== input.importMode)
          ) {
            throw new TransferValidationError('TRANSFER_IDEMPOTENCY_CONFLICT');
          }
          if (replayed?.status === 'SUCCEEDED') {
            return {
              createdObjectCount: 0,
              importId: replayed.id,
              projectId: replayed.projectId ?? sourceProjectId,
              replay: replayed.resultSummary,
              sourceProjectId,
              warningCodes: [...warningCodes],
            };
          }
          const outcome =
            input.importMode === 'NEW_PROJECT'
              ? await writeNewProjectFromBundle(repositories, dependencies, bundle, traceId)
              : await restoreOriginProjectFromBundle(repositories, dependencies, bundle, traceId);
          const importId = `import_${dependencies.newId()}`;
          await repositories.transfer.insertImport({
            createdAt: dependencies.now(),
            finishedAt: dependencies.now(),
            id: importId,
            idMapping: outcome.idMapping,
            importMode: input.importMode,
            projectId: outcome.projectId,
            requestId: input.requestId,
            resultSummary: {
              createdObjectCount: outcome.createdObjectCount,
              importId,
              projectId: outcome.projectId,
              sourceProjectId,
              warningCodes: [...warningCodes],
            },
            sourceRef: selected.sourceRef,
            sourceSha256: selected.sha256,
            status: 'SUCCEEDED',
            validationErrors: [],
          });
          return {
            createdObjectCount: outcome.createdObjectCount,
            importId,
            projectId: outcome.projectId,
            replay: null,
            sourceProjectId,
            warningCodes: [...warningCodes],
          };
        },
      );
      if (result.replay !== null) {
        return { data: result.replay, ok: true };
      }
      // 首次成功：剥离内部 replay 标记，回执恰为 DTO 5 键（preload strict parse）。
      return {
        data: {
          createdObjectCount: result.createdObjectCount,
          importId: result.importId,
          projectId: result.projectId,
          sourceProjectId: result.sourceProjectId,
          warningCodes: result.warningCodes,
        },
        ok: true,
      };
    } catch (caught) {
      if (caught instanceof TransferValidationError) {
        const message =
          caught.code === 'TRANSFER_PROJECT_CONFLICT'
            ? '目标项目已发生变化，请刷新后重新导入'
            : caught.code === 'TRANSFER_IDEMPOTENCY_CONFLICT'
              ? '请求标识已用于不同导入命令'
              : '导入文件校验失败';
        await recordFailure(caught.code);
        return failure(caught.code, message, traceId);
      }
      await recordFailure('TRANSFER_PERSISTENCE_FAILED');
      return failure('TRANSFER_PERSISTENCE_FAILED', '导入失败，原项目未修改', traceId, true);
    }
  },
});
