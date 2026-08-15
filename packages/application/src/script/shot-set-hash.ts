export interface ShotSetHashEntry {
  readonly sequence: number;
  readonly shotId: string;
  readonly shotVersionId: string;
  readonly documentSha256: string;
}

// design.md D1：shot_set_hash 对 [shot_id, shot_version_id, document_sha256] 三元组
// 按 sequence 排序后 JSON 序列化取 SHA-256（与 hashDocument 同源算法）。
// episode_version 是整集快照，该哈希用于 STALE 沿用原值与整集集合比对。
export const computeShotSetHash = (
  entries: readonly ShotSetHashEntry[],
  hashText: (text: string) => string,
): string =>
  hashText(
    JSON.stringify(
      [...entries]
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => [entry.shotId, entry.shotVersionId, entry.documentSha256]),
    ),
  );
