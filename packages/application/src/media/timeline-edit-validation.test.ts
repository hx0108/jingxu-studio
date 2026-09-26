import { describe, expect, it } from 'vitest';

import {
  normalizeTimelineClips,
  snapToTimelineGrid,
  validateEditedAudioTracks,
  validateEditedTimeline,
} from './timeline-edit-validation';

const clip = (overrides: Record<string, unknown> = {}) => ({
  clipId: 'clip_00000001',
  enabled: true,
  position: 0,
  shotId: 'shot_00000001',
  targetStartMs: 0,
  trimInMs: 0,
  trimOutMs: 1000,
  ...overrides,
});

describe('可剪辑时间线确定性校验', () => {
  it('同镜头同候选分割为两个不重叠片段时，保留总时长', () => {
    expect(
      validateEditedTimeline([
        clip({ trimOutMs: 500 }),
        clip({ clipId: 'clip_00000002', position: 1, targetStartMs: 500, trimInMs: 500 }),
      ]),
    ).toEqual({ error: null, totalDurationMs: 1000 });
  });

  it('移动第二片段产生显式空隙时，总时长包含空隙', () => {
    expect(
      validateEditedTimeline([
        clip(),
        clip({ clipId: 'clip_00000002', position: 1, targetStartMs: 1500 }),
      ]),
    ).toEqual({ error: null, totalDurationMs: 2500 });
  });

  it('片段重叠、重复身份、未对齐刻度和空轨均拒绝', () => {
    expect(
      validateEditedTimeline([
        clip(),
        clip({ clipId: 'clip_00000002', position: 1, targetStartMs: 900 }),
      ]).error,
    ).toBe('VIDEO_TIMELINE_OVERLAP');
    expect(validateEditedTimeline([clip(), clip({ position: 1, targetStartMs: 1000 })]).error).toBe(
      'VIDEO_TIMELINE_CLIP_DUPLICATE',
    );
    expect(validateEditedTimeline([clip({ targetStartMs: 150 })]).error).toBe(
      'VIDEO_TIMELINE_START_INVALID',
    );
    expect(validateEditedTimeline([]).error).toBe('VIDEO_TIMELINE_EMPTY');
  });

  it('超过六十个片段时拒绝，边界六十个可保存', () => {
    const clips = Array.from({ length: 61 }, (_, index) =>
      clip({
        clipId: `clip_${String(index).padStart(8, '0')}`,
        position: index,
        targetStartMs: index * 1000,
      }),
    );
    expect(validateEditedTimeline(clips.slice(0, 60)).error).toBeNull();
    expect(validateEditedTimeline(clips).error).toBe('VIDEO_TIMELINE_CLIP_LIMIT');
  });

  it('拖动值按 100ms 吸附，规范化后按绝对起点、原位置和 clipId 稳定排序', () => {
    expect(snapToTimelineGrid(149)).toBe(100);
    expect(snapToTimelineGrid(150)).toBe(200);
    expect(snapToTimelineGrid(-30)).toBe(0);
    expect(
      normalizeTimelineClips([
        clip({ clipId: 'clip_00000003', position: 2, targetStartMs: 1_051 }),
        clip({ clipId: 'clip_00000002', position: 1, targetStartMs: 151 }),
        clip({ clipId: 'clip_00000001', position: 0, targetStartMs: 149 }),
      ]).map(({ clipId, position, targetStartMs }) => ({ clipId, position, targetStartMs })),
    ).toEqual([
      { clipId: 'clip_00000001', position: 0, targetStartMs: 100 },
      { clipId: 'clip_00000002', position: 1, targetStartMs: 200 },
      { clipId: 'clip_00000003', position: 2, targetStartMs: 1_100 },
    ]);
  });

  it('对白绝对起点/音量/裁剪与配乐裁剪/淡入淡出越界均由纯函数稳定拒绝', () => {
    const music = {
      audioAssetId: 'audio_0001',
      fadeInMs: 500,
      fadeOutMs: 600,
      startMs: 0,
      trimInMs: 0,
      trimOutMs: 1_000,
      volume: 0.2,
    };
    expect(
      validateEditedAudioTracks(
        [
          {
            clipId: 'voice_00000001',
            enabled: true,
            targetStartMs: 0,
            trimInMs: 0,
            trimOutMs: 800,
            volume: 1,
          },
        ],
        music,
      ),
    ).toBe('VIDEO_AUDIO_FADE_INVALID');
    expect(
      validateEditedAudioTracks(
        [
          {
            clipId: 'voice_00000001',
            enabled: true,
            targetStartMs: 150,
            trimInMs: 0,
            trimOutMs: 800,
            volume: 1.2,
          },
        ],
        { ...music, fadeOutMs: 500 },
      ),
    ).toBe('VIDEO_TIMELINE_START_INVALID');
  });
});
