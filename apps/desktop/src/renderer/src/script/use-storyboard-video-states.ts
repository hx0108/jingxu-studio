import { useCallback, useEffect, useState } from 'react';

import type { AppErrorDto, StoryboardVideoStatesDto } from '@jingxu/contracts';

import { getVideoClient, rendererTransportError } from './script-api';
import { hasActiveVideoWork } from './storyboard-video-state-policy';

const STORYBOARD_VIDEO_POLL_INTERVAL_MS = 1_000;

export interface StoryboardVideoStatesHandle {
  readonly error: AppErrorDto | null;
  readonly refresh: () => Promise<void>;
  readonly states: StoryboardVideoStatesDto | null;
}

/** 视频列表状态与首帧使用同一有界轮询纪律：不可见暂停，终态停止。 */
export const useStoryboardVideoStates = (projectId: string): StoryboardVideoStatesHandle => {
  const [states, setStates] = useState<StoryboardVideoStatesDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const refresh = useCallback(
    (): Promise<void> =>
      getVideoClient()
        .listStoryboardVideoStates({ projectId })
        .then((result) => {
          if (result.ok) {
            setStates(result.data);
            setError(null);
          } else setError(result.error);
        })
        .catch(() => {
          setError(rendererTransportError());
        }),
    [projectId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = states !== null && hasActiveVideoWork(states);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), STORYBOARD_VIDEO_POLL_INTERVAL_MS);
        return;
      }
      await refresh();
      if (live) timer = setTimeout(() => void poll(), STORYBOARD_VIDEO_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), STORYBOARD_VIDEO_POLL_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, refresh]);

  return { error, refresh, states };
};
