import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  VideoCompositionPanel,
  VideoExportJobStatus,
  VideoExportMockNotice,
  VideoExportRecords,
} from './VideoCompositionPanel';

const job = (overrides: Record<string, unknown> = {}) => ({
  byteSize: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  errorCode: null,
  fileSha256: null,
  id: 'export_0001',
  mediaUrl: null,
  status: 'RUNNING' as const,
  timelineVersionId: 'timeline_0001',
  totalDurationMs: 1_000,
  updatedAt: '2026-08-24T00:00:00.000Z',
  ...overrides,
});

describe('VideoCompositionPanel', () => {
  it('空时间线—入口可见、依赖动作禁用且不显示本地路径', () => {
    const html = renderToStaticMarkup(
      <VideoCompositionPanel
        episodeId="episode_0001"
        episodeVersionId="episode_version_0001"
        projectId="project_0001"
      />,
    );
    expect(html).toContain('生成时间线');
    expect(html).not.toContain('name="import-video-background-music"');
    expect(html).not.toContain('name="start-video-export"');
    expect(html).not.toContain('ffmpeg');
    expect(html).not.toContain('C:');
    // 未载入时间线：BGM 音量与对齐摘要均不渲染（对齐摘要随版本数据出现）。
    expect(html).not.toContain('bgm-volume');
    expect(html).not.toContain('对齐摘要');
  });

  it('运行、失败、取消与成功—仅展示稳定状态和受限预览 URL', () => {
    const running = renderToStaticMarkup(<VideoExportJobStatus job={job()} />);
    const failed = renderToStaticMarkup(
      <VideoExportJobStatus job={job({ errorCode: 'FFMPEG_NOT_AVAILABLE', status: 'FAILED' })} />,
    );
    const cancelled = renderToStaticMarkup(
      <VideoExportJobStatus
        job={job({ errorCode: 'VIDEO_EXPORT_CANCELLED', status: 'CANCELLED' })}
      />,
    );
    const succeeded = renderToStaticMarkup(
      <VideoExportJobStatus
        job={job({
          byteSize: 100,
          fileSha256: 'a'.repeat(64),
          mediaUrl: 'jingxu://media/video-export/export_0001',
          status: 'SUCCEEDED',
        })}
      />,
    );
    expect(running).toContain('导出状态：生成中');
    expect(failed).toContain('导出失败，请检查时间线和媒体输入后重试');
    expect(failed).toContain('<summary>查看错误详情</summary>');
    expect(failed).toContain('FFMPEG_NOT_AVAILABLE');
    expect(cancelled).toContain('导出已取消');
    expect(succeeded).toContain('aria-label="已导出成片预览"');
    expect(succeeded).toContain('jingxu://media/video-export/export_0001');
    expect(`${running}${failed}${cancelled}${succeeded}`).not.toContain('C:');
    expect(`${running}${failed}${cancelled}${succeeded}`).not.toContain('--');
  });
});

describe('VideoExportMockNotice（low-cost 6.4 导出前检查）', () => {
  it('含模拟视频段—醒目提示数量与模拟口径；零模拟不渲染', () => {
    const withMock = renderToStaticMarkup(<VideoExportMockNotice count={2} />);
    expect(withMock).toContain('导出前检查：时间线包含 2 个模拟视频段');
    expect(withMock).toContain('不代表真实服务生成画质');
    expect(withMock).not.toContain('Mock');
    expect(withMock).not.toContain('Provider');
    expect(renderToStaticMarkup(<VideoExportMockNotice count={0} />)).toBe('');
  });
});

describe('VideoExportRecords', () => {
  it('真实记录—展示稳定状态和时间，不泄露本地路径', () => {
    const html = renderToStaticMarkup(
      <VideoExportRecords
        jobs={[
          job({
            byteSize: 100,
            fileSha256: 'a'.repeat(64),
            mediaUrl: 'jingxu://media/video-export/export_0001',
            status: 'SUCCEEDED',
          }),
        ]}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('最近导出记录');
    expect(html).toContain('1 秒成片');
    expect(html).toContain('已完成');
    expect(html).toContain('查看成片');
    expect(html).not.toContain('C:');
    expect(html).not.toContain('storageRelPath');
  });
});
