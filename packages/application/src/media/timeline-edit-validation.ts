/** 保存时间线前的确定性片段规则，不读取媒体或用户路径。 */
export type TimelineClip = Readonly<{
  clipId: string;
  enabled: boolean;
  position: number;
  targetStartMs: number;
  trimInMs: number;
  trimOutMs: number;
}>;

export type TimelineEditError =
  | 'VIDEO_TIMELINE_CLIP_LIMIT'
  | 'VIDEO_TIMELINE_CLIP_DUPLICATE'
  | 'VIDEO_TIMELINE_EMPTY'
  | 'VIDEO_TIMELINE_OVERLAP'
  | 'VIDEO_TIMELINE_START_INVALID'
  | 'VIDEO_TRIM_INVALID';

export type TimelineVoiceClip = Readonly<{
  clipId: string;
  enabled: boolean;
  targetStartMs: number;
  trimInMs: number;
  trimOutMs: number;
  volume: number;
}>;

export type TimelineMusicSettings = Readonly<{
  audioAssetId: string | null;
  fadeInMs: number;
  fadeOutMs: number;
  startMs: number;
  trimInMs: number;
  trimOutMs: number | null;
  volume: number;
}>;

export const snapToTimelineGrid = (valueMs: number): number =>
  Math.max(0, Math.round(valueMs / 100) * 100);

export const normalizeTimelineClips = <T extends TimelineClip>(clips: readonly T[]): T[] =>
  [...clips]
    .map((clip) => ({ ...clip, targetStartMs: snapToTimelineGrid(clip.targetStartMs) }))
    .sort(
      (left, right) =>
        left.targetStartMs - right.targetStartMs ||
        left.position - right.position ||
        left.clipId.localeCompare(right.clipId),
    )
    .map((clip, position) => ({ ...clip, position }));

export const validateEditedAudioTracks = (
  voiceClips: readonly TimelineVoiceClip[],
  music: TimelineMusicSettings,
): TimelineEditError | 'VIDEO_AUDIO_FADE_INVALID' | null => {
  const voiceIds = new Set<string>();
  for (const clip of voiceClips) {
    if (voiceIds.has(clip.clipId)) return 'VIDEO_TIMELINE_CLIP_DUPLICATE';
    voiceIds.add(clip.clipId);
    if (
      !Number.isInteger(clip.targetStartMs) ||
      clip.targetStartMs < 0 ||
      clip.targetStartMs % 100 !== 0
    )
      return 'VIDEO_TIMELINE_START_INVALID';
    if (clip.trimInMs < 0 || clip.trimOutMs <= clip.trimInMs || clip.volume < 0 || clip.volume > 1)
      return 'VIDEO_TRIM_INVALID';
  }
  if (music.audioAssetId === null) return null;
  const durationMs = music.trimOutMs === null ? null : music.trimOutMs - music.trimInMs;
  if (
    music.startMs < 0 ||
    music.startMs % 100 !== 0 ||
    music.trimInMs < 0 ||
    (music.trimOutMs !== null && music.trimOutMs <= music.trimInMs) ||
    music.volume < 0 ||
    music.volume > 1
  )
    return 'VIDEO_TRIM_INVALID';
  if (durationMs !== null && music.fadeInMs + music.fadeOutMs > durationMs)
    return 'VIDEO_AUDIO_FADE_INVALID';
  return null;
};

export const validateEditedTimeline = (
  clips: readonly TimelineClip[],
): { readonly error: TimelineEditError | null; readonly totalDurationMs: number } => {
  const reject = (error: TimelineEditError) => ({ error, totalDurationMs: 0 });
  if (clips.length > 60) return reject('VIDEO_TIMELINE_CLIP_LIMIT');
  if (clips.length === 0 || clips.every((clip) => !clip.enabled))
    return reject('VIDEO_TIMELINE_EMPTY');
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const clip of clips) {
    if (ids.has(clip.clipId)) return reject('VIDEO_TIMELINE_CLIP_DUPLICATE');
    if (positions.has(clip.position)) return reject('VIDEO_TRIM_INVALID');
    ids.add(clip.clipId);
    positions.add(clip.position);
    if (
      !Number.isInteger(clip.targetStartMs) ||
      clip.targetStartMs < 0 ||
      clip.targetStartMs % 100 !== 0
    )
      return reject('VIDEO_TIMELINE_START_INVALID');
    if (
      !Number.isInteger(clip.trimInMs) ||
      !Number.isInteger(clip.trimOutMs) ||
      clip.trimInMs < 0 ||
      clip.trimOutMs <= clip.trimInMs
    )
      return reject('VIDEO_TRIM_INVALID');
  }
  if (![...positions].every((position) => position >= 0 && position < clips.length))
    return reject('VIDEO_TRIM_INVALID');
  const enabled = clips
    .filter((clip) => clip.enabled)
    .sort(
      (left, right) => left.targetStartMs - right.targetStartMs || left.position - right.position,
    );
  let endMs = 0;
  for (const clip of enabled) {
    if (clip.targetStartMs < endMs) return reject('VIDEO_TIMELINE_OVERLAP');
    endMs = clip.targetStartMs + clip.trimOutMs - clip.trimInMs;
  }
  return { error: null, totalDurationMs: endMs };
};
