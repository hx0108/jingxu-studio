import { describe, expect, it } from 'vitest';

import {
  ASSET_REFERENCE_MAX_BYTES,
  IMAGE_IPC_CHANNELS,
  assetViewSchema,
  candidateMediaUrl,
  generateCandidatesInputSchema,
  generationInputDescriptorSchema,
  imageCandidateViewSchema,
  mediaTaskViewSchema,
  uploadAssetReferenceInputSchema,
  uploadAssetReferenceResultSchema,
} from './image-api';

const id = 'cand_00000001';
const shotId = 'shot_00000001';
const projectId = 'proj_00000001';
const requestId = 'req_000000001';
const hash = 'a'.repeat(64);
const iso = '2026-08-16T00:00:00.000Z';

const succeededCandidate = {
  byteSize: 1024,
  createdAt: iso,
  errorCode: null,
  generationInputHash: hash,
  height: 1440,
  id,
  indexInRound: 0,
  mediaUrl: candidateMediaUrl(id),
  mimeType: 'image/png',
  roundNo: 1,
  selectedAt: null,
  shotId,
  shotVersionId: 'shver_0000001',
  status: 'SUCCEEDED',
  width: 2560,
} as const;

const assetVersion = {
  assetId: 'asset_0000001',
  byteSize: 2048,
  createdAt: iso,
  description: null,
  height: 1024,
  id: 'asver_0000001',
  mediaUrl: `jingxu://media/asset-version/asver_0000001`,
  mimeType: 'image/png',
  provenance: 'UPLOADED',
  versionNo: 1,
  width: 1024,
} as const;

describe('image-api contracts', () => {
  it('SUCCEEDED 候选—携带受限协议 mediaUrl 与字节元数据', () => {
    expect(imageCandidateViewSchema.safeParse(succeededCandidate).success).toBe(true);
  });

  it('非 SUCCEEDED 候选—不得携带 mediaUrl；errorCode 只在 FAILED 携带', () => {
    const pending = {
      ...succeededCandidate,
      mediaUrl: null,
      mimeType: null,
      byteSize: null,
      status: 'PENDING' as const,
    };
    expect(imageCandidateViewSchema.safeParse(pending).success).toBe(true);

    const pendingWithUrl = { ...pending, mediaUrl: candidateMediaUrl(id) };
    expect(imageCandidateViewSchema.safeParse(pendingWithUrl).success).toBe(false);

    const failed = {
      ...pending,
      byteSize: null,
      errorCode: 'MODEL_RATE_LIMITED',
      status: 'FAILED' as const,
    };
    expect(imageCandidateViewSchema.safeParse(failed).success).toBe(true);

    const staleWithCode = {
      ...pending,
      errorCode: 'MODEL_UNKNOWN',
      status: 'STALE_INPUT' as const,
    };
    expect(imageCandidateViewSchema.safeParse(staleWithCode).success).toBe(false);
  });

  it('mediaUrl—外部协议被拒绝（CSP 前置防线之外的第二道契约防线）', () => {
    expect(
      imageCandidateViewSchema.safeParse({
        ...succeededCandidate,
        mediaUrl: 'https://evil.example/x.png',
      }).success,
    ).toBe(false);
  });

  it('媒体任务视图—phase 枚举与哈希形状', () => {
    const task = {
      candidateCount: 4,
      createdAt: iso,
      errorCode: null,
      generationInputHash: hash,
      id: 'task_00000001',
      phase: 'DOWNLOADING',
      shotId,
      shotVersionId: 'shver_0000001',
      updatedAt: iso,
    } as const;
    expect(mediaTaskViewSchema.safeParse(task).success).toBe(true);
    expect(mediaTaskViewSchema.safeParse({ ...task, phase: 'RUNNING' }).success).toBe(false);
    expect(
      mediaTaskViewSchema.safeParse({ ...task, generationInputHash: 'deadbeef' }).success,
    ).toBe(false);
  });

  it('资产视图—当前版本必须包含在版本列表中', () => {
    const asset = {
      assetType: 'CHARACTER',
      bibleRefId: 'bibl_00000001',
      createdAt: iso,
      currentVersion: assetVersion,
      displayName: '主角',
      id: 'asset_0000001',
      projectId,
      updatedAt: iso,
      versions: [assetVersion],
    } as const;
    expect(assetViewSchema.safeParse(asset).success).toBe(true);
    expect(
      assetViewSchema.safeParse({
        ...asset,
        currentVersion: { ...assetVersion, id: 'asver_0000002' },
      }).success,
    ).toBe(false);
  });

  it('上传参考图—字节与声明尺寸一致、≤20MB、仅 PNG/JPEG/WebP', () => {
    const upload = {
      assetType: 'SCENE',
      bibleRefId: 'bibl_00000002',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      description: null,
      displayName: '废弃工厂',
      mimeType: 'image/png',
      projectId,
      requestId,
    };
    expect(uploadAssetReferenceInputSchema.safeParse(upload).success).toBe(true);

    expect(uploadAssetReferenceInputSchema.safeParse({ ...upload, byteSize: 5 }).success).toBe(
      false,
    );
    expect(
      uploadAssetReferenceInputSchema.safeParse({
        ...upload,
        byteSize: ASSET_REFERENCE_MAX_BYTES + 1,
        bytes: new Uint8Array(ASSET_REFERENCE_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      uploadAssetReferenceInputSchema.safeParse({ ...upload, mimeType: 'image/gif' }).success,
    ).toBe(false);
  });

  it('上传结果—携带新版本与受影响镜头清单—未知字段拒绝', () => {
    const result = {
      affectedShots: [{ candidateCount: 4, shotId }],
      version: assetVersion,
    } as const;
    expect(uploadAssetReferenceResultSchema.safeParse(result).success).toBe(true);
    expect(
      uploadAssetReferenceResultSchema.safeParse({ ...result, affectedShots: [] }).success,
    ).toBe(true);
    expect(
      uploadAssetReferenceResultSchema.safeParse({
        ...result,
        affectedShots: [{ candidateCount: 0, shotId }],
      }).success,
    ).toBe(false);
    expect(
      uploadAssetReferenceResultSchema.safeParse({ ...result, storageRelPath: 'C:\\secret' })
        .success,
    ).toBe(false);
  });

  it('生成输入哈希输入集—参考图绑定 ≤14（方舟 image 参数上限）', () => {
    const descriptor = {
      boundAssetVersionIds: Array.from(
        { length: 14 },
        (_, index) => `asver_${String(index).padStart(7, '0')}`,
      ),
      modelId: 'doubao-seedream-5-0-lite-260128',
      parametersFingerprint: 'size=2048x2048;watermark=default',
      shotContentHash: hash,
      shotVersionId: 'shver_0000001',
    };
    expect(generationInputDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(
      generationInputDescriptorSchema.safeParse({
        ...descriptor,
        boundAssetVersionIds: [...descriptor.boundAssetVersionIds, 'asver_9000000'],
      }).success,
    ).toBe(false);
  });

  it('IPC 通道—image 前缀六方法与 API 接口一一对应', () => {
    expect(Object.keys(IMAGE_IPC_CHANNELS).sort()).toEqual([
      'generateCandidates',
      'getTask',
      'listAssets',
      'listCandidates',
      'selectCandidate',
      'uploadAssetReference',
    ]);
    for (const channel of Object.values(IMAGE_IPC_CHANNELS)) {
      expect(channel.startsWith('image.')).toBe(true);
    }
  });

  it('generateCandidates 输入—projectId/shotId/requestId 必填且 strict', () => {
    expect(generateCandidatesInputSchema.safeParse({ projectId, requestId, shotId }).success).toBe(
      true,
    );
    expect(generateCandidatesInputSchema.safeParse({ projectId, shotId }).success).toBe(false);
    expect(
      generateCandidatesInputSchema.safeParse({ extra: 1, projectId, requestId, shotId }).success,
    ).toBe(false);
  });
});
