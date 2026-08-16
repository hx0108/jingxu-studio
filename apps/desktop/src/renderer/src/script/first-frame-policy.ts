import {
  ASSET_REFERENCE_MAX_BYTES,
  candidateMediaUrl,
  type ImageCandidateViewDto,
  type MediaTaskViewDto,
} from '@jingxu/contracts';

/**
 * 首帧面板纯策略（shot-first-frame-image-generation design D3）：
 * 同 generation_input_hash 的候选视为同一输入世代；世代内跨轮可比，
 * 跨世代比较无意义——历史世代只读追溯，选择只落在当前世代。
 */

export type MediaTaskPhase = MediaTaskViewDto['phase'];

export const isTerminalMediaTaskPhase = (phase: MediaTaskPhase): boolean =>
  phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';

export interface CandidateGenerationGroup {
  /** 世代内按轮次倒序、轮内按位次排列。 */
  readonly candidates: readonly ImageCandidateViewDto[];
  readonly generationInputHash: string;
  /** 轮次倒序去重（世代内可能跨多轮）。 */
  readonly rounds: readonly number[];
  /** 全员 STALE_INPUT 即历史世代（输入已变化，仅追溯）。 */
  readonly stale: boolean;
}

export const groupCandidatesByGeneration = (
  candidates: readonly ImageCandidateViewDto[],
): readonly CandidateGenerationGroup[] => {
  const byHash = new Map<string, ImageCandidateViewDto[]>();
  for (const candidate of candidates) {
    const bucket = byHash.get(candidate.generationInputHash);
    if (bucket === undefined) byHash.set(candidate.generationInputHash, [candidate]);
    else bucket.push(candidate);
  }
  const groups = [...byHash.entries()].map(([generationInputHash, bucket]) => ({
    candidates: [...bucket].sort(
      (left, right) => right.roundNo - left.roundNo || left.indexInRound - right.indexInRound,
    ),
    generationInputHash,
    rounds: [...new Set(bucket.map((candidate) => candidate.roundNo))].sort(
      (left, right) => right - left,
    ),
    stale: bucket.every((candidate) => candidate.status === 'STALE_INPUT'),
  }));
  // 当前世代恒在最前；历史世代之间按最新轮次倒序。
  return groups.sort(
    (left, right) =>
      Number(left.stale) - Number(right.stale) || (right.rounds[0] ?? 0) - (left.rounds[0] ?? 0),
  );
};

/** 选择只落在当前输入世代的 SUCCEEDED 候选上（repo 侧同守卫，UI 前置禁用）。 */
export const isSelectableCandidate = (candidate: ImageCandidateViewDto): boolean =>
  candidate.status === 'SUCCEEDED';

/**
 * 取图 src：SUCCEEDED 用 DTO 携带的受限 mediaUrl；STALE 候选文件四元组保留，
 * 由协议按同一受限形状回源（协议侧仍做归属反查，越权一律 404）。
 */
export const candidateImageSrc = (candidate: ImageCandidateViewDto): string | null => {
  if (candidate.status === 'SUCCEEDED') return candidate.mediaUrl;
  return candidate.byteSize === null ? null : candidateMediaUrl(candidate.id);
};

export const CANDIDATE_STATUS_LABELS: Readonly<Record<ImageCandidateViewDto['status'], string>> = {
  FAILED: '失败',
  PENDING: '生成中',
  STALE_INPUT: '已失效',
  SUCCEEDED: '成功',
};

/** 上传前置校验：与契约层同一白名单与上限（IPC 层仍独立复验）。 */
export const validateReferenceFile = (file: {
  readonly size: number;
  readonly type: string;
}): string | null => {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg' && file.type !== 'image/webp') {
    return '参考图仅支持 PNG、JPEG 或 WebP。';
  }
  if (file.size === 0) return '参考图文件为空。';
  if (file.size > ASSET_REFERENCE_MAX_BYTES) return '参考图不能超过 20MB。';
  return null;
};
