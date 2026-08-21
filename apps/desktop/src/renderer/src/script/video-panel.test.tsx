import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { VideoCandidateViewDto } from '@jingxu/contracts';

import { VideoBoard } from './VideoPanel';

const NOW = '2026-08-21T00:00:00.000Z';
const CURRENT_HASH = 'a'.repeat(64);
const STALE_HASH = 'b'.repeat(64);

const candidate = (overrides: {
  readonly generationInputHash: string;
  readonly id: string;
  readonly indexInRound: number;
  readonly roundNo: number;
  readonly status: VideoCandidateViewDto['status'];
  readonly selectedAt?: string | null;
}): VideoCandidateViewDto => ({
  actualDurationSec: 5,
  byteSize: 1_024,
  continuationSegmentCount: 0,
  createdAt: NOW,
  errorCode: null,
  firstFrameCandidateId: 'frame_00000001',
  generationInputHash: overrides.generationInputHash,
  height: 720,
  id: overrides.id,
  indexInRound: overrides.indexInRound,
  mediaUrl:
    overrides.status === 'SUCCEEDED' ? `jingxu://media/video-candidate/${overrides.id}` : null,
  mimeType: overrides.status === 'SUCCEEDED' ? 'video/mp4' : null,
  requestedDurationSec: 5,
  roundNo: overrides.roundNo,
  selectedAt: overrides.selectedAt ?? null,
  shotId: 'shot_00000001',
  shotVersionId: 'scv_00000001',
  status: overrides.status,
  trimRange: null,
  width: 1280,
});

describe('VideoBoard 可观察基线（世代分组 + video 播放 + 选择 + STALE 追溯）', () => {
  const board = (candidates: readonly VideoCandidateViewDto[]): string =>
    renderToStaticMarkup(
      <VideoBoard
        busy={false}
        candidates={candidates}
        onSelect={vi.fn()}
        pendingCandidateId={null}
      />,
    );

  it('空候选—给出视频尚未生成提示', () => {
    expect(board([])).toContain('该镜头尚未生成视频候选。');
  });

  it('当前世代—以受限 URL 渲染 video、可选择未选 SUCCEEDED 候选', () => {
    const html = board([
      candidate({
        generationInputHash: CURRENT_HASH,
        id: 'video_00000001',
        indexInRound: 0,
        roundNo: 1,
        selectedAt: NOW,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: CURRENT_HASH,
        id: 'video_00000002',
        indexInRound: 1,
        roundNo: 1,
        status: 'SUCCEEDED',
      }),
    ]);
    expect(html).toContain('当前视频输入世代');
    expect(html).toContain('<video');
    expect(html).toContain('src="jingxu://media/video-candidate/video_00000001"');
    expect(html).toContain('当前视频段');
    expect(html).toContain('设为当前视频段');
    expect(html).toContain('请求 5s · 实际 5s');
  });

  it('历史世代—仍可播放追溯但不提供选择入口，旧选择明确标记失效', () => {
    const html = board([
      candidate({
        generationInputHash: CURRENT_HASH,
        id: 'video_00000010',
        indexInRound: 0,
        roundNo: 2,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: STALE_HASH,
        id: 'video_00000011',
        indexInRound: 0,
        roundNo: 1,
        selectedAt: NOW,
        status: 'STALE_INPUT',
      }),
    ]);
    expect(html).toContain('历史视频输入世代（输入已变化，仅供追溯）');
    expect(html).toContain('candidate-stale');
    expect(html).toContain('当前选择（已失效）');
    expect(html).toContain('src="jingxu://media/video-candidate/video_00000011"');
    expect(html.split('设为当前视频段').length).toBe(2);
    expect(html.indexOf('当前视频输入世代')).toBeLessThan(html.indexOf('历史视频输入世代'));
  });
});
