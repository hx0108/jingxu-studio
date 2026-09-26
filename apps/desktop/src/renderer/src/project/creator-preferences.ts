export interface CreatorPreferences {
  readonly defaultType: '每次询问' | '漫剧' | '短剧';
  readonly defaultAspect: '竖屏' | '横屏';
}

const STORAGE_KEY = 'jingxu.creator-preferences.v1';

export const DEFAULT_CREATOR_PREFERENCES: CreatorPreferences = {
  defaultType: '每次询问',
  defaultAspect: '竖屏',
};

export const readCreatorPreferences = (): CreatorPreferences => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CREATOR_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_CREATOR_PREFERENCES;
    const record = value as Record<string, unknown>;
    const defaultType = record.defaultType;
    const defaultAspect = record.defaultAspect;
    if (defaultType !== '每次询问' && defaultType !== '漫剧' && defaultType !== '短剧')
      return DEFAULT_CREATOR_PREFERENCES;
    if (defaultAspect !== '竖屏' && defaultAspect !== '横屏') return DEFAULT_CREATOR_PREFERENCES;
    return { defaultType, defaultAspect };
  } catch {
    return DEFAULT_CREATOR_PREFERENCES;
  }
};

export const saveCreatorPreferences = (preferences: CreatorPreferences): boolean => {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
};
