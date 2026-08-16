import { describe, expect, it } from 'vitest';

import { ASSET_REFERENCE_MAX_BYTES, type ImageCandidateViewDto } from '@jingxu/contracts';

import {
  CANDIDATE_STATUS_LABELS,
  candidateImageSrc,
  groupCandidatesByGeneration,
  isSelectableCandidate,
  isTerminalMediaTaskPhase,
  validateReferenceFile,
} from './first-frame-policy';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_CURRENT = 'a'.repeat(64);
const HASH_STALE = 'b'.repeat(64);

const candidate = (overrides: {
  readonly generationInputHash: string;
  readonly id: string;
  readonly indexInRound: number;
  readonly roundNo: number;
  readonly status: ImageCandidateViewDto['status'];
  readonly byteSize?: number | null;
  readonly mediaUrl?: string | null;
  readonly selectedAt?: string | null;
}): ImageCandidateViewDto => ({
  byteSize: overrides.byteSize === undefined ? 1024 : overrides.byteSize,
  createdAt: NOW,
  errorCode: null,
  generationInputHash: overrides.generationInputHash,
  height: 1440,
  id: overrides.id,
  indexInRound: overrides.indexInRound,
  mediaUrl:
    overrides.mediaUrl ??
    (overrides.status === 'SUCCEEDED' ? `jingxu://media/candidate/${overrides.id}` : null),
  mimeType: overrides.status === 'SUCCEEDED' ? 'image/png' : null,
  roundNo: overrides.roundNo,
  selectedAt: overrides.selectedAt ?? null,
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  status: overrides.status,
  width: 2560,
});

describe('首帧面板纯策略（design D3 输入世代分组）', () => {
  it('同 generationInputHash 归入同组—组内轮次倒序、轮内位次正序、rounds 去重倒序', () => {
    const groups = groupCandidatesByGeneration([
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000001',
        indexInRound: 0,
        roundNo: 1,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000002',
        indexInRound: 1,
        roundNo: 2,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000003',
        indexInRound: 0,
        roundNo: 2,
        status: 'SUCCEEDED',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidates.map((item) => item.id)).toEqual([
      'cand_00000003',
      'cand_00000002',
      'cand_00000001',
    ]);
    expect(groups[0]?.rounds).toEqual([2, 1]);
  });

  it('当前世代恒在最前—历史世代之间按最新轮次倒序—跨世代比较入口不混淆', () => {
    const groups = groupCandidatesByGeneration([
      candidate({
        generationInputHash: HASH_STALE,
        id: 'cand_00000010',
        indexInRound: 0,
        roundNo: 1,
        status: 'STALE_INPUT',
      }),
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000011',
        indexInRound: 0,
        roundNo: 3,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: 'c'.repeat(64),
        id: 'cand_00000012',
        indexInRound: 0,
        roundNo: 2,
        status: 'STALE_INPUT',
      }),
    ]);
    expect(groups.map((group) => group.generationInputHash.slice(0, 1))).toEqual(['a', 'c', 'b']);
    expect(groups.map((group) => group.stale)).toEqual([false, true, true]);
  });

  it('全员 STALE_INPUT 才是历史世代—世代内只要有一个可用候选仍属当前世代', () => {
    const groups = groupCandidatesByGeneration([
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000020',
        indexInRound: 0,
        roundNo: 1,
        status: 'STALE_INPUT',
      }),
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000021',
        indexInRound: 1,
        roundNo: 1,
        status: 'SUCCEEDED',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.stale).toBe(false);
  });

  it('isTerminalMediaTaskPhase—仅 COMPLETED/FAILED/CANCELLED 终停轮询—SUBMITTED/POLLING/DOWNLOADING 继续', () => {
    for (const phase of ['SUBMITTED', 'POLLING', 'DOWNLOADING'] as const) {
      expect(isTerminalMediaTaskPhase(phase)).toBe(false);
    }
    for (const phase of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminalMediaTaskPhase(phase)).toBe(true);
    }
  });

  it('candidateImageSrc—SUCCEEDED 用 DTO mediaUrl—STALE 有字节走受限回源—无字节不出图', () => {
    expect(
      candidateImageSrc(
        candidate({
          generationInputHash: HASH_CURRENT,
          id: 'cand_00000030',
          indexInRound: 0,
          roundNo: 1,
          status: 'SUCCEEDED',
        }),
      ),
    ).toBe('jingxu://media/candidate/cand_00000030');
    expect(
      candidateImageSrc(
        candidate({
          byteSize: 2048,
          generationInputHash: HASH_CURRENT,
          id: 'cand_00000031',
          indexInRound: 0,
          roundNo: 1,
          status: 'STALE_INPUT',
        }),
      ),
    ).toBe('jingxu://media/candidate/cand_00000031');
    expect(
      candidateImageSrc(
        candidate({
          byteSize: null,
          generationInputHash: HASH_CURRENT,
          id: 'cand_00000032',
          indexInRound: 0,
          roundNo: 1,
          status: 'PENDING',
        }),
      ),
    ).toBe(null);
  });

  it('isSelectableCandidate—仅 SUCCEEDED 可选—与 repo 侧 MEDIA_CANDIDATE_NOT_SELECTABLE 同守卫前置', () => {
    for (const status of ['SUCCEEDED'] as const) {
      expect(
        isSelectableCandidate(
          candidate({
            generationInputHash: HASH_CURRENT,
            id: 'cand_00000040',
            indexInRound: 0,
            roundNo: 1,
            status,
          }),
        ),
      ).toBe(true);
    }
    for (const status of ['PENDING', 'FAILED', 'STALE_INPUT'] as const) {
      expect(
        isSelectableCandidate(
          candidate({
            generationInputHash: HASH_CURRENT,
            id: 'cand_00000041',
            indexInRound: 0,
            roundNo: 1,
            status,
          }),
        ),
      ).toBe(false);
    }
  });

  it('CANDIDATE_STATUS_LABELS—四个状态全有中文文案—未知状态无法编译期混入', () => {
    expect(Object.keys(CANDIDATE_STATUS_LABELS).sort()).toEqual([
      'FAILED',
      'PENDING',
      'STALE_INPUT',
      'SUCCEEDED',
    ]);
  });

  it('validateReferenceFile—白名单外 MIME 拒绝—空文件与超 20MB 拒绝—合法返回 null', () => {
    expect(validateReferenceFile({ size: 10, type: 'image/gif' })).toBe(
      '参考图仅支持 PNG、JPEG 或 WebP。',
    );
    expect(validateReferenceFile({ size: 0, type: 'image/png' })).toBe('参考图文件为空。');
    expect(validateReferenceFile({ size: ASSET_REFERENCE_MAX_BYTES + 1, type: 'image/png' })).toBe(
      '参考图不能超过 20MB。',
    );
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(validateReferenceFile({ size: 1024, type })).toBe(null);
    }
  });
});
