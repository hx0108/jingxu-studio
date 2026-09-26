import type {
  VideoTimelineItemDto,
  VideoTimelineSummaryDto,
  VideoTimelineVoiceItemDto,
} from '@jingxu/contracts';

type BgmPatch = Partial<
  Pick<
    VideoTimelineSummaryDto,
    | 'audioVolume'
    | 'bgmFadeInMs'
    | 'bgmFadeOutMs'
    | 'bgmMuted'
    | 'bgmStartMs'
    | 'bgmTrimInMs'
    | 'bgmTrimOutMs'
    | 'voiceTrackMuted'
  >
>;

export interface TimelineDraft {
  readonly original: VideoTimelineSummaryDto;
  readonly current: VideoTimelineSummaryDto;
  readonly undo: readonly VideoTimelineSummaryDto[];
  readonly redo: readonly VideoTimelineSummaryDto[];
  readonly dirty: boolean;
  readonly playheadMs: number;
  readonly selectedClipId: string | null;
}

export type TimelineDraftAction =
  | { readonly type: 'select'; readonly clipId: string | null }
  | { readonly type: 'seek'; readonly timeMs: number }
  | { readonly type: 'move-video'; readonly clipId: string; readonly targetStartMs: number }
  | { readonly type: 'reorder-video'; readonly clipId: string; readonly direction: -1 | 1 }
  | {
      readonly type: 'trim-video';
      readonly clipId: string;
      readonly trimInMs?: number;
      readonly trimOutMs?: number;
    }
  | {
      readonly type: 'split-video';
      readonly clipId: string;
      readonly newClipId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'copy-video';
      readonly clipId: string;
      readonly newClipId: string;
      readonly targetStartMs: number;
    }
  | { readonly type: 'delete-video'; readonly clipId: string }
  | { readonly type: 'set-video-enabled'; readonly clipId: string; readonly enabled: boolean }
  | { readonly type: 'move-voice'; readonly clipId: string; readonly targetStartMs: number }
  | {
      readonly type: 'trim-voice';
      readonly clipId: string;
      readonly trimInMs?: number;
      readonly trimOutMs?: number;
    }
  | { readonly type: 'delete-voice'; readonly clipId: string }
  | {
      readonly type: 'set-voice';
      readonly clipId: string;
      readonly patch: Partial<
        Pick<VideoTimelineVoiceItemDto, 'enabled' | 'volume' | 'offsetMs' | 'alignmentOverride'>
      >;
    }
  | { readonly type: 'set-subtitle-enabled'; readonly shotId: string; readonly enabled: boolean }
  | { readonly type: 'set-bgm'; readonly patch: BgmPatch }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export const snapToTimelineGrid = (milliseconds: number): number =>
  Math.max(0, Math.round(milliseconds / 100) * 100);

export const createTimelineDraft = (timeline: VideoTimelineSummaryDto): TimelineDraft => ({
  original: timeline,
  current: timeline,
  undo: [],
  redo: [],
  dirty: false,
  playheadMs: 0,
  selectedClipId: null,
});

const updateClip = <T extends { readonly clipId: string }>(
  clips: readonly T[],
  clipId: string,
  change: (clip: T) => T,
): T[] => clips.map((clip) => (clip.clipId === clipId ? change(clip) : clip));

const reindex = (items: readonly VideoTimelineItemDto[]): VideoTimelineItemDto[] =>
  items.map((item, position) => ({ ...item, position }));

const saveStep = (draft: TimelineDraft, next: VideoTimelineSummaryDto): TimelineDraft => {
  if (JSON.stringify(next) === JSON.stringify(draft.current)) return draft;
  return {
    ...draft,
    current: next,
    dirty: JSON.stringify(next) !== JSON.stringify(draft.original),
    redo: [],
    undo: [...draft.undo, draft.current].slice(-30),
  };
};

export const reduceTimelineDraft = (
  draft: TimelineDraft,
  action: TimelineDraftAction,
): TimelineDraft => {
  if (action.type === 'select') return { ...draft, selectedClipId: action.clipId };
  if (action.type === 'seek') return { ...draft, playheadMs: snapToTimelineGrid(action.timeMs) };
  if (action.type === 'undo') {
    const previous = draft.undo.at(-1);
    if (previous === undefined) return draft;
    return {
      ...draft,
      current: previous,
      dirty: JSON.stringify(previous) !== JSON.stringify(draft.original),
      redo: [...draft.redo, draft.current].slice(-30),
      undo: draft.undo.slice(0, -1),
    };
  }
  if (action.type === 'redo') {
    const next = draft.redo.at(-1);
    if (next === undefined) return draft;
    return {
      ...draft,
      current: next,
      dirty: JSON.stringify(next) !== JSON.stringify(draft.original),
      redo: draft.redo.slice(0, -1),
      undo: [...draft.undo, draft.current].slice(-30),
    };
  }
  const current = draft.current;
  if (action.type === 'set-bgm') return saveStep(draft, { ...current, ...action.patch });
  if (action.type === 'set-subtitle-enabled')
    return saveStep(draft, {
      ...current,
      subtitleItems: current.subtitleItems.map((item) =>
        item.shotId === action.shotId ? { ...item, enabled: action.enabled } : item,
      ),
    });
  if (action.type === 'reorder-video') {
    const index = current.items.findIndex((clip) => clip.clipId === action.clipId);
    const other = index + action.direction;
    if (index < 0 || other < 0 || other >= current.items.length) return draft;
    const items = [...current.items];
    const first = items[index];
    const second = items[other];
    if (first === undefined || second === undefined) return draft;
    items[index] = { ...second, targetStartMs: first.targetStartMs };
    items[other] = { ...first, targetStartMs: second.targetStartMs };
    return saveStep(draft, { ...current, items: reindex(items) });
  }
  if (action.type === 'move-video')
    return saveStep(draft, {
      ...current,
      items: updateClip(current.items, action.clipId, (clip) => ({
        ...clip,
        targetStartMs: snapToTimelineGrid(action.targetStartMs),
      })),
    });
  if (action.type === 'trim-video')
    return saveStep(draft, {
      ...current,
      items: updateClip(current.items, action.clipId, (clip) => ({
        ...clip,
        trimInMs: action.trimInMs === undefined ? clip.trimInMs : Math.max(0, action.trimInMs),
        trimOutMs: action.trimOutMs === undefined ? clip.trimOutMs : Math.max(0, action.trimOutMs),
      })),
    });
  if (action.type === 'set-video-enabled')
    return saveStep(draft, {
      ...current,
      items: updateClip(current.items, action.clipId, (clip) => ({
        ...clip,
        enabled: action.enabled,
      })),
    });
  if (action.type === 'split-video') {
    if (current.items.some((clip) => clip.clipId === action.newClipId)) return draft;
    const index = current.items.findIndex((clip) => clip.clipId === action.clipId);
    const source = current.items[index];
    if (source === undefined) return draft;
    const atMs = snapToTimelineGrid(action.atMs);
    const sourceSplitMs = source.trimInMs + atMs - source.targetStartMs;
    if (sourceSplitMs <= source.trimInMs || sourceSplitMs >= source.trimOutMs) return draft;
    const left = { ...source, trimOutMs: sourceSplitMs };
    const right = {
      ...source,
      clipId: action.newClipId,
      targetStartMs: atMs,
      trimInMs: sourceSplitMs,
    };
    return saveStep(draft, {
      ...current,
      items: reindex([
        ...current.items.slice(0, index),
        left,
        right,
        ...current.items.slice(index + 1),
      ]),
    });
  }
  if (action.type === 'copy-video') {
    if (current.items.some((clip) => clip.clipId === action.newClipId)) return draft;
    const source = current.items.find((clip) => clip.clipId === action.clipId);
    if (source === undefined) return draft;
    return saveStep(draft, {
      ...current,
      items: reindex([
        ...current.items,
        {
          ...source,
          clipId: action.newClipId,
          targetStartMs: snapToTimelineGrid(action.targetStartMs),
        },
      ]),
    });
  }
  if (action.type === 'delete-video')
    return saveStep(draft, {
      ...current,
      items: reindex(current.items.filter((clip) => clip.clipId !== action.clipId)),
    });
  if (action.type === 'move-voice')
    return saveStep(draft, {
      ...current,
      voiceItems: updateClip(current.voiceItems, action.clipId, (clip) => ({
        ...clip,
        targetStartMs: snapToTimelineGrid(action.targetStartMs),
      })),
    });
  if (action.type === 'trim-voice')
    return saveStep(draft, {
      ...current,
      voiceItems: updateClip(current.voiceItems, action.clipId, (clip) => ({
        ...clip,
        trimInMs: action.trimInMs === undefined ? clip.trimInMs : Math.max(0, action.trimInMs),
        trimOutMs: action.trimOutMs === undefined ? clip.trimOutMs : Math.max(0, action.trimOutMs),
      })),
    });
  if (action.type === 'delete-voice')
    return saveStep(draft, {
      ...current,
      voiceItems: current.voiceItems.filter((clip) => clip.clipId !== action.clipId),
    });
  return saveStep(draft, {
    ...current,
    voiceItems: updateClip(current.voiceItems, action.clipId, (clip) => ({
      ...clip,
      ...action.patch,
    })),
  });
};
