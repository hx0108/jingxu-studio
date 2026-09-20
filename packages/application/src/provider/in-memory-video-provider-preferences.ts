import type {
  VideoProviderPreferencesPort,
  VideoProviderSelection,
  VideoProviderSelectionMode,
} from './provider-types';
import { VIDEO_PROVIDER_PROFILE_BY_MODE } from './provider-types';

/** 视频当前 Provider 偏好的内存实现（单测/组合根联调；启动为 null 表示尚未落行）。 */
export class InMemoryVideoProviderPreferences implements VideoProviderPreferencesPort {
  #selection: VideoProviderSelection | null = null;
  #sequence = 0;

  public get(): Promise<VideoProviderSelection | null> {
    return Promise.resolve(this.#selection === null ? null : { ...this.#selection });
  }

  public save(
    expectedUpdatedAt: string | null,
    mode: VideoProviderSelectionMode,
    savedAt: string,
  ): Promise<VideoProviderSelection> {
    const current = this.#selection;
    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) {
      return Promise.reject(new Error('VIDEO_PROVIDER_SELECTION_CONFLICT'));
    }
    this.#sequence += 1;
    this.#selection = {
      mode,
      providerProfileId: VIDEO_PROVIDER_PROFILE_BY_MODE[mode],
      updatedAt: `${savedAt}#${String(this.#sequence).padStart(4, '0')}`,
    };
    return Promise.resolve({ ...this.#selection });
  }
}
