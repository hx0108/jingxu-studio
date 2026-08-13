import { describe, expect, it } from 'vitest';

import type { JobSummaryDto, ProviderProfileDto } from '@jingxu/contracts';

import {
  countUnicodeCharacters,
  episodeScopeForStage,
  isOriginalCreativeValid,
  isProviderReadyForGeneration,
  isTerminalJob,
} from './script-ui-policy';

const profile: ProviderProfileDto = {
  configured: true,
  enabled: true,
  last4: '1234',
  modelId: 'qwen3.7-plus-2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  validated: true,
  versionId: 'profile_12345678',
  workspaceId: 'workspace-1',
};

const job = (status: JobSummaryDto['status']): JobSummaryDto => ({
  errorCode: null,
  id: 'job_12345678',
  projectId: 'project_12345678',
  status,
  versionId: 'version_12345678',
});

describe('Script Renderer 确定性 UI policy', () => {
  it.each([
    [19, false],
    [20, true],
    [2_000, true],
    [2_001, false],
  ])('原创输入 %i 个 Unicode 字符—边界校验为 %s', (length, expected) => {
    const value = '剧'.repeat(length);
    expect(countUnicodeCharacters(value)).toBe(length);
    expect(isOriginalCreativeValid(value)).toBe(expected);
  });

  it('代理生成门—配置、启用、持久验证和非占位 Workspace 缺一不可', () => {
    expect(isProviderReadyForGeneration(profile)).toBe(true);
    expect(isProviderReadyForGeneration({ ...profile, configured: false })).toBe(false);
    expect(isProviderReadyForGeneration({ ...profile, validated: false })).toBe(false);
    expect(isProviderReadyForGeneration({ ...profile, workspaceId: 'placeholder' })).toBe(false);
  });

  it('五阶段 scope—项目级不带 episode—集级必须带 episode', () => {
    expect(episodeScopeForStage('CONCEPT', 'episode_12345678')).toBeNull();
    expect(episodeScopeForStage('STORY_BIBLE', 'episode_12345678')).toBeNull();
    expect(episodeScopeForStage('EPISODE_OUTLINE', 'episode_12345678')).toBe('episode_12345678');
    expect(episodeScopeForStage('BEAT_SHEET', 'episode_12345678')).toBe('episode_12345678');
    expect(episodeScopeForStage('SCENE_SCRIPT', 'episode_12345678')).toBe('episode_12345678');
  });

  it('轮询终止策略—仅 SUCCEEDED/FAILED/CANCELLED 停止', () => {
    for (const status of ['DRAFT', 'QUEUED', 'RUNNING', 'VALIDATING'] as const) {
      expect(isTerminalJob(job(status))).toBe(false);
    }
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminalJob(job(status))).toBe(true);
    }
  });
});
