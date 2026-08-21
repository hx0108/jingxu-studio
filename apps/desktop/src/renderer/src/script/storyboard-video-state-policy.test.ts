import { describe, expect, it } from 'vitest';

import type { ShotVideoStateDto, StoryboardVideoStatesDto } from '@jingxu/contracts';

import { hasActiveVideoWork, shotVideoBadge } from './storyboard-video-state-policy';

const state = (overrides: Partial<ShotVideoStateDto>): ShotVideoStateDto => ({
  activeTaskPhase: null,
  currentGenSucceededCount: 0,
  latestTaskErrorCode: null,
  queuedInBatchId: null,
  shotId: 'shot_00000001',
  ...overrides,
});

describe('视频镜头徽标优先级', () => {
  it('排队优先于生成中、就绪和失败', () => {
    expect(
      shotVideoBadge(
        state({
          activeTaskPhase: 'SUBMITTED',
          currentGenSucceededCount: 2,
          latestTaskErrorCode: 'MODEL_TIMEOUT',
          queuedInBatchId: 'batch_00000001',
        }),
      ).label,
    ).toBe('视频排队中');
  });

  it('活跃批次或在飞镜头才继续轮询', () => {
    const idle: StoryboardVideoStatesDto = { batches: [], shots: [state({})] };
    expect(hasActiveVideoWork(idle)).toBe(false);
    expect(hasActiveVideoWork({ ...idle, shots: [state({ activeTaskPhase: 'POLLING' })] })).toBe(
      true,
    );
    expect(
      hasActiveVideoWork({
        ...idle,
        batches: [
          {
            batchId: 'batch_00000001',
            createdAt: '2026-08-21T00:00:00.000Z',
            errorCode: null,
            members: [{ errorCode: null, phase: null, shotId: 'shot_00000001', taskId: null }],
            skippedShotIds: [],
            status: 'RUNNING',
            updatedAt: '2026-08-21T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(true);
  });
});
