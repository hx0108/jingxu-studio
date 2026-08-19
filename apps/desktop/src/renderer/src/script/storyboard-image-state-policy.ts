import type {
  MediaBatchViewDto,
  ShotImageStateDto,
  StoryboardImageStatesDto,
} from '@jingxu/contracts';

import { isTerminalMediaTaskPhase } from './first-frame-policy';

/**
 * 列表级首帧状态纯策略（batch-first-frame-generation design D5）：
 * 徽标、批次进度与轮询停启全部由 Renderer 从 listStoryboardImageStates 的
 * 原始字段派生；「当前世代」由服务端统一计算，渲染层不重复判定。
 */

export interface ShotFirstFrameBadge {
  readonly className: string;
  readonly label: string;
}

/**
 * 徽标优先级与契约 shotImageStateSchema JSDoc 同序：
 * 排队 → 生成中 → N 就绪 → 失败 → 无候选。已有可用首帧（N 就绪）时失败
 * 重试不再顶替徽标——可用帧存在本身是更强事实，重试入口在批次进度行。
 */
export const shotFirstFrameBadge = (state: ShotImageStateDto): ShotFirstFrameBadge => {
  if (state.queuedInBatchId !== null) {
    return { className: 'status-first_frame_queued', label: '首帧排队中' };
  }
  if (state.activeTaskPhase !== null && !isTerminalMediaTaskPhase(state.activeTaskPhase)) {
    return { className: 'status-first_frame_active', label: '首帧生成中' };
  }
  if (state.currentGenSucceededCount > 0) {
    return {
      className: 'status-first_frame_ready',
      label: `首帧就绪 ${String(state.currentGenSucceededCount)} 张`,
    };
  }
  if (state.latestTaskErrorCode !== null) {
    return { className: 'status-first_frame_failed', label: '首帧失败' };
  }
  return { className: 'status-first_frame_empty', label: '未生成首帧' };
};

/** 单镜头生成入口的批次占线判定：排队或在飞任务期间不重复发起。 */
export const shotGenerationBusy = (state: ShotImageStateDto | null): boolean => {
  if (state === null) return false;
  return (
    state.queuedInBatchId !== null ||
    (state.activeTaskPhase !== null && !isTerminalMediaTaskPhase(state.activeTaskPhase))
  );
};

/** 轮询停启：存在 RUNNING 批次或任一镜头在飞任务才继续，否则终态即停。 */
export const hasActiveImageWork = (states: StoryboardImageStatesDto): boolean =>
  states.batches.some((batch) => batch.status === 'RUNNING') ||
  states.shots.some((state) => shotGenerationBusy(state));

export interface BatchProgress {
  /** 已落终态（COMPLETED/FAILED/CANCELLED）的成员数。 */
  readonly settled: number;
  /** 成员任务 FAILED 的镜头清单（重试入口按此发起新批次，design D2）。 */
  readonly failedShotIds: readonly string[];
  readonly total: number;
}

/** 批次进度行数据：n/total 与失败清单由成员相位派生（契约层不冗余）。 */
export const batchProgressOf = (batch: MediaBatchViewDto): BatchProgress => ({
  failedShotIds: batch.members
    .filter((member) => member.phase === 'FAILED')
    .map((member) => member.shotId),
  settled: batch.members.filter(
    (member) => member.phase !== null && isTerminalMediaTaskPhase(member.phase),
  ).length,
  total: batch.members.length,
});

export const MEDIA_BATCH_STATUS_LABELS: Readonly<Record<MediaBatchViewDto['status'], string>> = {
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  PARTIAL_COMPLETED: '部分完成',
  RUNNING: '进行中',
};
