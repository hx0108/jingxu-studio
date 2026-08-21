import type { VideoCandidateViewDto } from '@jingxu/contracts';

/**
 * 视频候选按服务端 generationInputHash 分组。输入世代已经由服务端判定，
 * Renderer 只负责比较当前世代与追溯历史世代，绝不自行推断 STALE_INPUT。
 */
export interface VideoCandidateGenerationGroup {
  readonly candidates: readonly VideoCandidateViewDto[];
  readonly generationInputHash: string;
  readonly rounds: readonly number[];
  readonly stale: boolean;
}

export const groupVideoCandidatesByGeneration = (
  candidates: readonly VideoCandidateViewDto[],
): readonly VideoCandidateGenerationGroup[] => {
  const byHash = new Map<string, VideoCandidateViewDto[]>();
  for (const candidate of candidates) {
    const bucket = byHash.get(candidate.generationInputHash);
    if (bucket === undefined) byHash.set(candidate.generationInputHash, [candidate]);
    else bucket.push(candidate);
  }
  return [...byHash.entries()]
    .map(([generationInputHash, bucket]) => ({
      candidates: [...bucket].sort(
        (left, right) => right.roundNo - left.roundNo || left.indexInRound - right.indexInRound,
      ),
      generationInputHash,
      rounds: [...new Set(bucket.map((candidate) => candidate.roundNo))].sort(
        (left, right) => right - left,
      ),
      stale: bucket.every((candidate) => candidate.status === 'STALE_INPUT'),
    }))
    .sort(
      (left, right) =>
        Number(left.stale) - Number(right.stale) || (right.rounds[0] ?? 0) - (left.rounds[0] ?? 0),
    );
};

export const isSelectableVideoCandidate = (candidate: VideoCandidateViewDto): boolean =>
  candidate.status === 'SUCCEEDED';

/** STALE 候选仍允许通过受限协议追溯播放；文件路径始终不进入 Renderer。 */
export const candidateVideoSrc = (candidate: VideoCandidateViewDto): string | null => {
  if (candidate.status === 'SUCCEEDED') return candidate.mediaUrl;
  return candidate.byteSize === null ? null : `jingxu://media/video-candidate/${candidate.id}`;
};

export const VIDEO_CANDIDATE_STATUS_LABELS: Readonly<
  Record<VideoCandidateViewDto['status'], string>
> = {
  FAILED: '失败',
  PENDING: '生成中',
  STALE_INPUT: '已失效',
  SUCCEEDED: '成功',
};
