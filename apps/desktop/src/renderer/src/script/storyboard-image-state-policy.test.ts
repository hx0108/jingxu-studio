import { describe, expect, it } from 'vitest';

import type {
  MediaBatchViewDto,
  ShotImageStateDto,
  StoryboardImageStatesDto,
} from '@jingxu/contracts';

import {
  MEDIA_BATCH_STATUS_LABELS,
  batchProgressOf,
  hasActiveImageWork,
  shotFirstFrameBadge,
  shotGenerationBusy,
} from './storyboard-image-state-policy';

const NOW = '2026-08-18T00:00:00.000Z';

const shotState = (overrides: Partial<ShotImageStateDto>): ShotImageStateDto => ({
  activeTaskPhase: null,
  currentGenSucceededCount: 0,
  latestTaskErrorCode: null,
  queuedInBatchId: null,
  shotId: 'shot_00000001',
  ...overrides,
});

describe('列表级首帧状态策略（batch-first-frame design D5）', () => {
  it('徽标优先级—排队 > 生成中 > N 就绪 > 失败 > 无候选（契约 JSDoc 同序）', () => {
    // 排队压过一切：即使历史世代已有首帧或最新任务失败。
    expect(
      shotFirstFrameBadge(
        shotState({
          currentGenSucceededCount: 4,
          latestTaskErrorCode: 'MODEL_TIMEOUT',
          queuedInBatchId: 'batch_00000001',
        }),
      ),
    ).toEqual({ className: 'status-first_frame_queued', label: '首帧排队中' });
    // 在飞任务压过就绪与失败。
    expect(
      shotFirstFrameBadge(
        shotState({
          activeTaskPhase: 'DOWNLOADING',
          currentGenSucceededCount: 4,
        }),
      ),
    ).toEqual({ className: 'status-first_frame_active', label: '首帧生成中' });
    // 就绪压过失败：已有可用首帧时，失败重试入口在批次进度行，不顶替徽标。
    expect(
      shotFirstFrameBadge(
        shotState({
          currentGenSucceededCount: 3,
          latestTaskErrorCode: 'MODEL_TIMEOUT',
        }),
      ),
    ).toEqual({ className: 'status-first_frame_ready', label: '首帧就绪 3 张' });
    expect(shotFirstFrameBadge(shotState({ latestTaskErrorCode: 'MODEL_RATE_LIMITED' }))).toEqual({
      className: 'status-first_frame_failed',
      label: '首帧失败',
    });
    expect(shotFirstFrameBadge(shotState({}))).toEqual({
      className: 'status-first_frame_empty',
      label: '未生成首帧',
    });
  });

  it('终态 activeTaskPhase 不算生成中—回落到就绪/失败分支（防御服务端契约漂移）', () => {
    expect(
      shotFirstFrameBadge(shotState({ activeTaskPhase: 'COMPLETED', currentGenSucceededCount: 0 }))
        .className,
    ).toBe('status-first_frame_empty');
    expect(shotGenerationBusy(shotState({ activeTaskPhase: 'FAILED' }))).toBe(false);
  });

  it('单镜头入口占线—排队或在飞才禁用；null（未载入）不禁用', () => {
    expect(shotGenerationBusy(null)).toBe(false);
    expect(shotGenerationBusy(shotState({ queuedInBatchId: 'batch_00000001' }))).toBe(true);
    expect(shotGenerationBusy(shotState({ activeTaskPhase: 'SUBMITTED' }))).toBe(true);
    expect(shotGenerationBusy(shotState({ currentGenSucceededCount: 4 }))).toBe(false);
  });

  it('轮询停启—RUNNING 批次或任一在飞任务才活跃；终态批次与排队镜头不触发', () => {
    const batch = (status: MediaBatchViewDto['status']): MediaBatchViewDto => ({
      batchId: 'batch_00000001',
      createdAt: NOW,
      errorCode: null,
      members: [
        { errorCode: null, phase: null, shotId: 'shot_00000001', taskId: null },
        {
          errorCode: null,
          phase: 'COMPLETED',
          shotId: 'shot_00000002',
          taskId: 'task_00000001',
        },
      ],
      skippedShotIds: [],
      status,
      updatedAt: NOW,
    });
    const statesOf = (
      batches: readonly MediaBatchViewDto[],
      shots: readonly ShotImageStateDto[],
    ): StoryboardImageStatesDto => ({ batches: [...batches], shots: [...shots] });

    expect(hasActiveImageWork(statesOf([batch('RUNNING')], []))).toBe(true);
    expect(
      hasActiveImageWork(
        statesOf([batch('PARTIAL_COMPLETED')], [shotState({ activeTaskPhase: 'POLLING' })]),
      ),
    ).toBe(true);
    // 防御：排队镜头即使批次行缺失（快照错位）也不停轮询——多轮一次无害，漏停才是错。
    expect(
      hasActiveImageWork(statesOf([], [shotState({ queuedInBatchId: 'batch_00000001' })])),
    ).toBe(true);
    expect(hasActiveImageWork(statesOf([batch('COMPLETED')], []))).toBe(false);
  });

  it('批次进度—settled/total 与失败清单由成员相位派生', () => {
    const batch: MediaBatchViewDto = {
      batchId: 'batch_00000001',
      createdAt: NOW,
      errorCode: null,
      members: [
        { errorCode: null, phase: 'COMPLETED', shotId: 'shot_00000001', taskId: 'task_00000001' },
        {
          errorCode: 'MODEL_TIMEOUT',
          phase: 'FAILED',
          shotId: 'shot_00000002',
          taskId: 'task_00000002',
        },
        { errorCode: null, phase: null, shotId: 'shot_00000003', taskId: null },
        { errorCode: null, phase: 'SUBMITTED', shotId: 'shot_00000004', taskId: 'task_00000003' },
      ],
      skippedShotIds: ['shot_00000005'],
      status: 'RUNNING',
      updatedAt: NOW,
    };
    expect(batchProgressOf(batch)).toEqual({
      failedShotIds: ['shot_00000002'],
      settled: 2,
      total: 4,
    });
    expect(MEDIA_BATCH_STATUS_LABELS.PARTIAL_COMPLETED).toBe('部分完成');
  });
});
