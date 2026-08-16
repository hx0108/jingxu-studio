/**
 * ImageApi 应用服务（shot-first-frame-image-generation 任务 5.1，design D4）。
 *
 * IPC 六方法的用例编排层：Repository 记录 → 契约 DTO 映射、上传字节落盘 +
 * 资产建档/升版 + STALE 传播、生成建档后 kick 调度器。不含 SQL、文件系统路径
 * 或 Provider 原文；候选/资产取图一律输出受限 `jingxu://media/` URL。
 */

import type {
  AppResultDto,
  AssetVersionViewDto,
  AssetViewDto,
  GenerateCandidatesInputDto,
  GetMediaTaskInputDto,
  ImageCandidateViewDto,
  ListAssetsInputDto,
  ListCandidatesInputDto,
  MediaTaskViewDto,
  SelectCandidateInputDto,
  UploadAssetReferenceInputDto,
  UploadAssetReferenceResultDto,
} from '@jingxu/contracts';
import { assetVersionMediaUrl, candidateMediaUrl } from '@jingxu/contracts';

import type {
  MediaAssetVersionRecord,
  MediaAssetWithVersions,
  MediaCandidateRecord,
  MediaTaskRecord,
  MediaUnitOfWorkPort,
} from '../ports/media/media-repository';
import type { MediaGenerationService } from './media-generation-service';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';

/** 资产参考图字节落盘（组合根包装 ContentAddressedStore.write 的 assets 命名空间）。 */
export interface MediaAssetFileStorePort {
  readonly writeAsset: (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly projectId: string;
  }) => Promise<{
    readonly byteSize: number;
    readonly mimeType: string;
    readonly sha256: string;
    readonly storageRelPath: string;
  }>;
}

export interface ImageApiService {
  generateCandidates(
    input: GenerateCandidatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaTaskViewDto>>;
  listCandidates(
    input: ListCandidatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  selectCandidate(
    input: SelectCandidateInputDto,
    traceId: string,
  ): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  listAssets(input: ListAssetsInputDto, traceId: string): Promise<AppResultDto<AssetViewDto[]>>;
  uploadAssetReference(
    input: UploadAssetReferenceInputDto,
    traceId: string,
  ): Promise<AppResultDto<UploadAssetReferenceResultDto>>;
  getMediaTask(
    input: GetMediaTaskInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaTaskViewDto>>;
}

export interface ImageApiServiceDependencies {
  readonly assetFileStore: MediaAssetFileStorePort;
  readonly generation: MediaGenerationService;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly newId: () => string;
  /** 生成建档成功后触发该项目后台排空（幂等；重放旧任务时无可排空即空转）。 */
  readonly scheduler: { readonly kick: (projectId: string) => void };
}

const toTaskView = (task: MediaTaskRecord): MediaTaskViewDto => ({
  candidateCount: task.candidateCount,
  createdAt: task.createdAt,
  errorCode: task.errorCode,
  generationInputHash: task.generationInputHash,
  id: task.id,
  phase: task.phase,
  shotId: task.shotId,
  shotVersionId: task.shotVersionId,
  updatedAt: task.updatedAt,
});

/** mediaUrl 仅 SUCCEEDED 候选携带（契约 superRefine 同一不变式）。 */
const toCandidateView = (candidate: MediaCandidateRecord): ImageCandidateViewDto => ({
  byteSize: candidate.byteSize,
  createdAt: candidate.createdAt,
  errorCode: candidate.errorCode,
  generationInputHash: candidate.generationInputHash,
  height: candidate.height,
  id: candidate.id,
  indexInRound: candidate.indexInRound,
  mediaUrl: candidate.status === 'SUCCEEDED' ? candidateMediaUrl(candidate.id) : null,
  mimeType: candidate.mimeType,
  roundNo: candidate.roundNo,
  selectedAt: candidate.selectedAt,
  shotId: candidate.shotId,
  shotVersionId: candidate.shotVersionId,
  status: candidate.status,
  width: candidate.width,
});

const toAssetVersionView = (version: MediaAssetVersionRecord): AssetVersionViewDto => {
  // 契约只认三种参考图 mime；坏行（历史篡改/手改库）按稳定标记失败，不静默降级。
  if (
    version.mimeType !== 'image/png' &&
    version.mimeType !== 'image/jpeg' &&
    version.mimeType !== 'image/webp'
  ) {
    throw new Error('MEDIA_ROW_CORRUPT');
  }
  return {
    assetId: version.assetId,
    byteSize: version.byteSize,
    createdAt: version.createdAt,
    description: version.description,
    height: version.height,
    id: version.id,
    mediaUrl: assetVersionMediaUrl(version.id),
    mimeType: version.mimeType,
    provenance: version.provenance,
    versionNo: version.versionNo,
    width: version.width,
  };
};

const toAssetView = ({ asset, versions }: MediaAssetWithVersions): AssetViewDto => {
  const current = versions[versions.length - 1];
  return {
    assetType: asset.assetType,
    bibleRefId: asset.bibleRefId,
    createdAt: asset.createdAt,
    currentVersion: current === undefined ? null : toAssetVersionView(current),
    displayName: asset.displayName,
    id: asset.id,
    projectId: asset.projectId,
    updatedAt: asset.updatedAt,
    versions: versions.map(toAssetVersionView),
  };
};

export const createImageApiService = (
  dependencies: ImageApiServiceDependencies,
): ImageApiService => {
  const { mediaUnitOfWork } = dependencies;
  return {
    generateCandidates: async (input, traceId) => {
      const created = await dependencies.generation.generateCandidates(input, traceId);
      if (!created.ok) return created;
      dependencies.scheduler.kick(input.projectId);
      return { data: toTaskView(created.data), ok: true };
    },

    listCandidates: async (input, traceId) => {
      try {
        const candidates = await mediaUnitOfWork.run((media) => media.listCandidates(input.shotId));
        return { data: candidates.map(toCandidateView), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    selectCandidate: async (input, traceId) => {
      try {
        const updated = await mediaUnitOfWork.run(async (media) => {
          const candidate = await media.findCandidateById(input.projectId, input.candidateId);
          if (candidate === null) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
          await media.selectCandidate(candidate.shotId, input.candidateId);
          return media.listCandidates(candidate.shotId);
        });
        return { data: updated.map(toCandidateView), ok: true };
      } catch (caught: unknown) {
        const marker = caught instanceof Error ? caught.message : '';
        if (marker === 'MEDIA_CANDIDATE_NOT_FOUND') {
          return mediaFailure('MEDIA_CANDIDATE_NOT_FOUND', '候选不存在或不在该项目中', traceId);
        }
        if (marker === 'MEDIA_CANDIDATE_NOT_SELECTABLE') {
          return mediaFailure(
            'MEDIA_CANDIDATE_NOT_SELECTABLE',
            '仅成功候选可设为当前首帧',
            traceId,
          );
        }
        return mediaPersistenceFailure(traceId);
      }
    },

    listAssets: async (input, traceId) => {
      try {
        const assets = await mediaUnitOfWork.run((media) => media.listAssets(input.projectId));
        return { data: assets.map(toAssetView), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    uploadAssetReference: async (input, traceId) => {
      try {
        const stored = await dependencies.assetFileStore.writeAsset({
          bytes: input.bytes,
          mimeType: input.mimeType,
          projectId: input.projectId,
        });
        const version = await mediaUnitOfWork.run(async (media) => {
          const existing = await media.findAssetByIdentity(
            input.projectId,
            input.assetType,
            input.bibleRefId,
          );
          const asset =
            existing ??
            (await media.createAsset({
              assetType: input.assetType,
              bibleRefId: input.bibleRefId,
              displayName: input.displayName,
              id: dependencies.newId(),
              projectId: input.projectId,
            }));
          return media.appendAssetVersion({
            assetId: asset.id,
            byteSize: stored.byteSize,
            description: input.description,
            fileSha256: stored.sha256,
            height: null,
            id: dependencies.newId(),
            mimeType: stored.mimeType,
            width: null,
          });
        });
        // 升版已落库；STALE 传播失败时如实失败（重传产生新版本行，字节按内容寻址去重）。
        const propagated = await dependencies.generation.propagateStaleForAssetChange(
          { bibleRefId: input.bibleRefId, projectId: input.projectId },
          traceId,
        );
        if (!propagated.ok) return propagated;
        // 受影响镜头清单随版本返回（spec：资产升版 MUST 支持列出受影响镜头供用户决策）。
        return {
          data: { affectedShots: [...propagated.data], version: toAssetVersionView(version) },
          ok: true,
        };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    getMediaTask: async (input, traceId) => {
      try {
        const task = await mediaUnitOfWork.run((media) =>
          media.findTaskById(input.projectId, input.taskId),
        );
        if (task === null) {
          return mediaFailure('MEDIA_TASK_NOT_FOUND', '生成任务不存在', traceId);
        }
        return { data: toTaskView(task), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },
  };
};
