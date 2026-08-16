import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ImageCandidateViewDto } from '@jingxu/contracts';

import { FirstFrameBoard, FirstFrameUploadForm } from './FirstFramePanel';

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

describe('FirstFrameBoard 可观察基线（世代分组 + 选择入口 + STALE 追溯）', () => {
  const board = (candidates: readonly ImageCandidateViewDto[]): string =>
    renderToStaticMarkup(
      <FirstFrameBoard
        busy={false}
        candidates={candidates}
        onSelect={vi.fn()}
        pendingCandidateId={null}
      />,
    );

  it('空候选—给出尚未生成提示—不出现世代分组', () => {
    const html = board([]);
    expect(html).toContain('该镜头尚未生成首帧候选。');
    expect(html).not.toContain('candidate-generation');
  });

  it('当前世代在前—SUCCEEDED 可选、已选者带当前首帧徽标—PENDING 无字节显示占位', () => {
    const html = board([
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000001',
        indexInRound: 0,
        roundNo: 1,
        selectedAt: NOW,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000002',
        indexInRound: 1,
        roundNo: 1,
        status: 'SUCCEEDED',
      }),
      candidate({
        byteSize: null,
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000003',
        indexInRound: 2,
        roundNo: 1,
        status: 'PENDING',
      }),
    ]);
    expect(html).toContain('当前输入世代');
    expect(html).not.toContain('历史输入世代');
    expect(html).toContain('当前首帧');
    expect(html).toContain('设为当前首帧');
    expect(html).toContain('尚未出图');
    expect(html).toContain('src="jingxu://media/candidate/cand_00000001"');
    // 已选候选不再提供切换按钮；未选 SUCCEEDED 各一枚。
    expect(html.split('设为当前首帧').length).toBe(2);
    expect(html.split('当前首帧').length).toBe(3);
  });

  it('历史世代只读追溯—失效候选仍可读图（受限 URL）—无选择按钮—旧选择标注已失效', () => {
    const html = board([
      candidate({
        generationInputHash: HASH_CURRENT,
        id: 'cand_00000010',
        indexInRound: 0,
        roundNo: 2,
        status: 'SUCCEEDED',
      }),
      candidate({
        generationInputHash: HASH_STALE,
        id: 'cand_00000011',
        indexInRound: 0,
        roundNo: 1,
        selectedAt: NOW,
        status: 'STALE_INPUT',
      }),
      candidate({
        generationInputHash: HASH_STALE,
        id: 'cand_00000012',
        indexInRound: 1,
        roundNo: 1,
        status: 'STALE_INPUT',
      }),
    ]);
    expect(html).toContain('历史输入世代（输入已变化，仅供追溯）');
    expect(html).toContain('candidate-stale');
    expect(html).toContain('当前选择（已失效）');
    expect(html).toContain('已失效');
    // STALE 候选文件四元组保留：Renderer 侧构造受限取图 URL，仍可追溯查看。
    expect(html).toContain('src="jingxu://media/candidate/cand_00000011"');
    expect(html).toContain('src="jingxu://media/candidate/cand_00000012"');
    // 只有一枚选择按钮（当前世代那张）；失效世代不给切换入口。
    expect(html.split('设为当前首帧').length).toBe(2);
    // 当前世代分组出现在历史世代之前。
    expect(html.indexOf('当前输入世代')).toBeLessThan(html.indexOf('历史输入世代'));
  });

  it('busy 或 pending 时—选择按钮禁用防并发切换', () => {
    const html = renderToStaticMarkup(
      <FirstFrameBoard
        busy={true}
        candidates={[
          candidate({
            generationInputHash: HASH_CURRENT,
            id: 'cand_00000020',
            indexInRound: 0,
            roundNo: 1,
            status: 'SUCCEEDED',
          }),
        ]}
        onSelect={vi.fn()}
        pendingCandidateId={null}
      />,
    );
    expect(html).toContain('disabled=""');
  });
});

describe('FirstFrameUploadForm 可观察基线（参考图上传约束前置）', () => {
  it('初始态—文件未选禁用提交—accept 限定 PNG/JPEG/WebP—提示 20MB 上限', () => {
    const html = renderToStaticMarkup(<FirstFrameUploadForm busy={false} onSubmit={vi.fn()} />);
    expect(html).toContain('id="reference-upload-form"');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).toContain('参考图（≤20MB PNG/JPEG/WebP）');
    expect(html).toContain('圣经引用 ID');
    expect(html).toContain('scene_train');
    expect(html).toContain('上传参考图');
    expect(html).toContain('disabled=""');
  });

  it('busy 态—按钮文案切换为上传中', () => {
    const html = renderToStaticMarkup(<FirstFrameUploadForm busy={true} onSubmit={vi.fn()} />);
    expect(html).toContain('上传中…');
  });
});
