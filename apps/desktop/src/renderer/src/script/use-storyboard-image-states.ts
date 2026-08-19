import { useCallback, useEffect, useState } from 'react';

import type { AppErrorDto, StoryboardImageStatesDto } from '@jingxu/contracts';

import { getImageClient, rendererTransportError } from './script-api';
import { hasActiveImageWork } from './storyboard-image-state-policy';

const STORYBOARD_IMAGE_POLL_INTERVAL_MS = 1_000;

export interface StoryboardImageStatesHandle {
  readonly error: AppErrorDto | null;
  /** 立即拉取一次；发起/取消/重试批次后调用，轮询停启按结果自动重估。 */
  readonly refresh: () => Promise<void>;
  readonly states: StoryboardImageStatesDto | null;
}

/**
 * 列表级首帧状态轮询（batch-first-frame-generation design D5）：
 * 1 秒有界轮询，document.visibilityState 守卫沿用单镜头任务轮询节奏；
 * 存在 RUNNING 批次或在飞任务才持续，终态即停。
 */
export const useStoryboardImageStates = (projectId: string): StoryboardImageStatesHandle => {
  const [states, setStates] = useState<StoryboardImageStatesDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);

  const refresh = useCallback((): Promise<void> => {
    return getImageClient()
      .listStoryboardImageStates({ projectId })
      .then((result) => {
        if (result.ok) {
          setStates(result.data);
          setError(null);
        } else setError(result.error);
      })
      .catch(() => {
        setError(rendererTransportError());
      });
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // active 翻转即启停轮询：观察不到活跃工作时 cleanup 清掉挂起定时器。
  const active = states !== null && hasActiveImageWork(states);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), STORYBOARD_IMAGE_POLL_INTERVAL_MS);
        return;
      }
      await refresh();
      if (!live) return;
      timer = setTimeout(() => void poll(), STORYBOARD_IMAGE_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), STORYBOARD_IMAGE_POLL_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, refresh]);

  return { error, refresh, states };
};
