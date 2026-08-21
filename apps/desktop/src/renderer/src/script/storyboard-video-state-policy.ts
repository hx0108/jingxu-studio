import type { ShotVideoStateDto, StoryboardVideoStatesDto } from '@jingxu/contracts';

import { isTerminalMediaTaskPhase } from './first-frame-policy';

export interface ShotVideoBadge {
  readonly className: string;
  readonly label: string;
}

/** 视频徽标优先级：排队 > 生成中 > 当前世代就绪 > 失败 > 无候选。 */
export const shotVideoBadge = (state: ShotVideoStateDto): ShotVideoBadge => {
  if (state.queuedInBatchId !== null)
    return { className: 'status-video_queued', label: '视频排队中' };
  if (state.activeTaskPhase !== null && !isTerminalMediaTaskPhase(state.activeTaskPhase)) {
    return { className: 'status-video_active', label: '视频生成中' };
  }
  if (state.currentGenSucceededCount > 0) {
    return {
      className: 'status-video_ready',
      label: `视频就绪 ${String(state.currentGenSucceededCount)} 段`,
    };
  }
  if (state.latestTaskErrorCode !== null)
    return { className: 'status-video_failed', label: '视频失败' };
  return { className: 'status-video_empty', label: '未生成视频' };
};

export const shotVideoGenerationBusy = (state: ShotVideoStateDto | null): boolean =>
  state !== null &&
  (state.queuedInBatchId !== null ||
    (state.activeTaskPhase !== null && !isTerminalMediaTaskPhase(state.activeTaskPhase)));

/** 仅在存在 RUNNING 批次或镜头在飞时以 1 秒节奏轮询。 */
export const hasActiveVideoWork = (states: StoryboardVideoStatesDto): boolean =>
  states.batches.some((batch) => batch.status === 'RUNNING') ||
  states.shots.some((state) => shotVideoGenerationBusy(state));
