import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CREATOR_PREFERENCES,
  readCreatorPreferences,
  saveCreatorPreferences,
} from './creator-preferences';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('创作偏好本机保存', () => {
  it('没有已保存偏好时读取默认值', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(readCreatorPreferences()).toEqual(DEFAULT_CREATOR_PREFERENCES);
  });

  it('保存漫剧与横屏后，新建项目可读取相同偏好', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    expect(saveCreatorPreferences({ defaultType: '漫剧', defaultAspect: '横屏' })).toBe(true);
    expect(readCreatorPreferences()).toEqual({ defaultType: '漫剧', defaultAspect: '横屏' });
  });

  it('本机存储含非法选项时回退到安全默认值', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ defaultType: '未知', defaultAspect: '横屏' }),
    });
    expect(readCreatorPreferences()).toEqual(DEFAULT_CREATOR_PREFERENCES);
  });

  it('存储写入失败时明确返回失败，不显示伪成功', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('存储不可写');
      },
    });
    expect(saveCreatorPreferences(DEFAULT_CREATOR_PREFERENCES)).toBe(false);
    expect(readCreatorPreferences()).toEqual(DEFAULT_CREATOR_PREFERENCES);
  });
});
