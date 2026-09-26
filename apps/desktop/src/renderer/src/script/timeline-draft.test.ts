import { describe, expect, it } from 'vitest';

import { createTimelineDraft, reduceTimelineDraft } from './timeline-draft';

const HASH = 'a'.repeat(64);
const timeline = () => ({
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
  items: [
    {
      candidateId: 'candidate_00001',
      clipId: 'clip_00000001',
      enabled: true,
      fileSha256: HASH,
      generationInputHash: HASH,
      isMock: false,
      position: 0,
      providerKind: 'VOLCARK_SEEDANCE' as const,
      shotId: 'shot_00000001',
      targetStartMs: 0,
      trimInMs: 0,
      trimOutMs: 1000,
    },
  ],
  parentVersionId: null,
  subtitleItems: [],
  totalDurationMs: 1000,
  versionNo: 1,
  voiceItems: [],
  voiceTrackMuted: false,
});

describe('剪辑草稿', () => {
  it('移动按 100 毫秒吸附，撤销与重做仅改变未提交草稿', () => {
    const initial = createTimelineDraft(timeline());
    const moved = reduceTimelineDraft(initial, {
      type: 'move-video',
      clipId: 'clip_00000001',
      targetStartMs: 154,
    });
    expect(moved.current.items[0]?.targetStartMs).toBe(200);
    expect(moved.dirty).toBe(true);
    const undone = reduceTimelineDraft(moved, { type: 'undo' });
    expect(undone.current.items[0]?.targetStartMs).toBe(0);
    expect(undone.dirty).toBe(false);
    expect(reduceTimelineDraft(undone, { type: 'redo' }).current.items[0]?.targetStartMs).toBe(200);
  });

  it('分割同一候选生成两个稳定身份片段，删除与复制可撤销', () => {
    const initial = createTimelineDraft(timeline());
    const split = reduceTimelineDraft(initial, {
      type: 'split-video',
      clipId: 'clip_00000001',
      newClipId: 'clip_00000002',
      atMs: 500,
    });
    expect(split.current.items).toMatchObject([
      { clipId: 'clip_00000001', trimOutMs: 500 },
      { clipId: 'clip_00000002', targetStartMs: 500, trimInMs: 500 },
    ]);
    const copied = reduceTimelineDraft(split, {
      type: 'copy-video',
      clipId: 'clip_00000002',
      newClipId: 'clip_00000003',
      targetStartMs: 1200,
    });
    expect(copied.current.items).toHaveLength(3);
    expect(
      reduceTimelineDraft(copied, { type: 'delete-video', clipId: 'clip_00000003' }).current.items,
    ).toHaveLength(2);
  });

  it('配乐设置随快照撤销，草稿历史最多保留三十步', () => {
    let draft = createTimelineDraft(timeline());
    for (let index = 0; index < 35; index += 1)
      draft = reduceTimelineDraft(draft, { type: 'set-bgm', patch: { audioVolume: index / 100 } });
    expect(draft.undo).toHaveLength(30);
    expect(draft.current.audioVolume).toBe(0.34);
    expect(reduceTimelineDraft(draft, { type: 'undo' }).current.audioVolume).toBe(0.33);
  });

  it('选择与播放头不污染历史；对白裁剪、音量、静音、字幕开关和删除均可撤销', () => {
    const withTracks = {
      ...timeline(),
      subtitleItems: [
        {
          enabled: true,
          safeAreaPct: 5,
          shotId: 'shot_00000001',
          spokenTextSha256: HASH,
        },
      ],
      voiceItems: [
        {
          candidateId: 'voice_candidate_1',
          clipId: 'voice_clip_0001',
          enabled: true,
          fileSha256: HASH,
          generationInputHash: HASH,
          offsetMs: 0,
          shotId: 'shot_00000001',
          targetStartMs: 0,
          trimInMs: 0,
          trimOutMs: 900,
          volume: 1,
        },
      ],
    };
    const selected = reduceTimelineDraft(createTimelineDraft(withTracks), {
      type: 'select',
      clipId: 'voice_clip_0001',
    });
    const sought = reduceTimelineDraft(selected, { type: 'seek', timeMs: 349 });
    expect(sought.playheadMs).toBe(300);
    expect(sought.undo).toHaveLength(0);
    const trimmed = reduceTimelineDraft(sought, {
      type: 'trim-voice',
      clipId: 'voice_clip_0001',
      trimInMs: 100,
      trimOutMs: 800,
    });
    const quiet = reduceTimelineDraft(trimmed, {
      type: 'set-voice',
      clipId: 'voice_clip_0001',
      patch: { volume: 0.45 },
    });
    const muted = reduceTimelineDraft(quiet, {
      type: 'set-bgm',
      patch: { bgmMuted: true, voiceTrackMuted: true },
    });
    const subtitlesOff = reduceTimelineDraft(muted, {
      type: 'set-subtitle-enabled',
      shotId: 'shot_00000001',
      enabled: false,
    });
    const deleted = reduceTimelineDraft(subtitlesOff, {
      type: 'delete-voice',
      clipId: 'voice_clip_0001',
    });
    expect(deleted.current.voiceItems).toEqual([]);
    expect(deleted.current.voiceTrackMuted).toBe(true);
    expect(deleted.current.bgmMuted).toBe(true);
    expect(deleted.current.subtitleItems[0]?.enabled).toBe(false);
    expect(reduceTimelineDraft(deleted, { type: 'undo' }).current.voiceItems).toHaveLength(1);
  });
});
