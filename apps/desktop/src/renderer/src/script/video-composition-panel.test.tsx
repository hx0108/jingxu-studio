import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VideoCompositionPanel, VideoExportJobStatus } from './VideoCompositionPanel';

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
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*name="import-video-background-music"/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*name="start-video-export"/u);
    expect(html).not.toContain('ffmpeg');
    expect(html).not.toContain('C:');
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
    expect(succeeded).toContain('aria-label="已导出 MP4 预览"');
    expect(succeeded).toContain('jingxu://media/video-export/export_0001');
    expect(`${running}${failed}${cancelled}${succeeded}`).not.toContain('C:');
    expect(`${running}${failed}${cancelled}${succeeded}`).not.toContain('--');
  });
});
