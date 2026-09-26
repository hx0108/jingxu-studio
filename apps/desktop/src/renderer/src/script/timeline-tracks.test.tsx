import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createTimelineDraft } from './timeline-draft';
import { TimelineTracks } from './TimelineTracks';

const HASH = 'a'.repeat(64);

describe('三轨剪辑器', () => {
  it('画面、对白、配乐均有可识别轨道，播放头和撤销操作可见', () => {
    const draft = createTimelineDraft({
      alignmentItems: [],
      audioAsset: null,
      audioVolume: 0.2,
      bgmFadeInMs: 0,
      bgmFadeOutMs: 2000,
      bgmMuted: false,
      bgmStartMs: 0,
      bgmTrimInMs: 0,
      bgmTrimOutMs: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      episodeId: 'episode_00000001',
      episodeVersionId: 'episode_v0000001',
      formatProfileId: 'format_00000001',
      id: 'timeline_0000001',
      inputHash: HASH,
      items: [],
      parentVersionId: null,
      subtitleItems: [],
      totalDurationMs: 0,
      versionNo: 1,
      voiceItems: [],
      voiceTrackMuted: false,
    });
    const html = renderToStaticMarkup(<TimelineTracks draft={draft} onAction={vi.fn()} />);
    expect(html).toContain('aria-label="画面轨"');
    expect(html).toContain('aria-label="对白轨"');
    expect(html).toContain('aria-label="配乐轨"');
    expect(html).toContain('aria-label="播放头位置"');
    expect(html).toContain('工作预览');
    expect(html).toContain('撤销');
  });
});
