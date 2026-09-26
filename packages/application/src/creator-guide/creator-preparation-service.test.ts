import { describe, expect, it, vi } from 'vitest';

import type { CreatorPreparationFacts, CreatorPreparationQueryPort } from '../ports/creator-guide';
import { createCreatorPreparationService } from './creator-preparation-service';

const input = {
  episodeId: 'episode_12345678',
  operation: 'IMAGE' as const,
  projectId: 'project_12345678',
  shotIds: ['shot_12345678', 'shot_87654321'],
};
const facts = (overrides: Partial<CreatorPreparationFacts> = {}): CreatorPreparationFacts => ({
  consistencyMissing: [],
  estimatedDurationSec: 60,
  exportReady: false,
  imagesReady: false,
  isDemo: false,
  price: {
    currency: 'CNY',
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    max: 2,
    min: 1,
  },
  referenceLimitExceeded: false,
  serviceReady: true,
  videosReady: false,
  voiceReady: false,
  ...overrides,
});
const serviceFor = (value: CreatorPreparationFacts) => {
  const query: CreatorPreparationQueryPort = { getFacts: vi.fn(() => Promise.resolve(value)) };
  return createCreatorPreparationService(query, {
    hashPayload: () => 'a'.repeat(64),
    now: () => '2026-09-21T00:00:00.000Z',
  });
};

describe('creator preparation service', () => {
  it('缺服务、画风、角色且引用超限—一次聚合全部阻断与修复动作', async () => {
    const result = await serviceFor(
      facts({
        consistencyMissing: ['STYLE', 'CHARACTER'],
        referenceLimitExceeded: true,
        serviceReady: false,
      }),
    ).getPreparation(input, 'trace-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canProceed).toBe(false);
    expect(
      result.data.items.filter((item) => item.status === 'BLOCK').map((item) => item.code),
    ).toEqual([
      'SERVICE_NOT_READY',
      'STYLE_REFERENCE_MISSING',
      'CHARACTER_REFERENCE_MISSING',
      'REFERENCE_LIMIT_EXCEEDED',
    ]);
  });

  it('演示模式—无需凭据且参考成本明确零真实费用—不显示可用真实价格', async () => {
    const result = await serviceFor(
      facts({ isDemo: true, price: null, serviceReady: false }),
    ).getPreparation(input, 'trace-2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canProceed).toBe(true);
    expect(result.data.cost.status).toBe('UNKNOWN');
    expect(result.data.items).toContainEqual(
      expect.objectContaining({ code: 'DEMO_ZERO_COST', status: 'READY' }),
    );
  });

  it('真实项目价格有效—按镜头数计算区间；过期价格只告警且不伪装可用', async () => {
    const available = await serviceFor(facts()).getPreparation(input, 'trace-3');
    expect(available.ok && available.data.cost).toMatchObject({
      min: 2,
      max: 4,
      status: 'AVAILABLE',
    });

    const stale = await serviceFor(
      facts({
        price: {
          currency: 'CNY',
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-02-01T00:00:00.000Z',
          max: 2,
          min: 1,
        },
      }),
    ).getPreparation(input, 'trace-4');
    expect(stale.ok && stale.data.cost.status).toBe('STALE');
    expect(stale.ok && stale.data.items).toContainEqual(
      expect.objectContaining({ code: 'REFERENCE_COST_STALE', status: 'WARN' }),
    );
  });

  it('数据库日期型参考价格—输出为带时区的 ISO 日期以满足 IPC 契约', async () => {
    const result = await serviceFor(
      facts({
        price: {
          currency: 'CNY',
          effectiveAt: '2026-08-22',
          expiresAt: '9999-12-31',
          max: 2,
          min: 1,
        },
      }),
    ).getPreparation(input, 'trace-date-only-price');
    expect(result.ok && result.data.cost.effectiveAt).toBe('2026-08-22T00:00:00.000Z');
  });

  it('真实项目没有参考价格—明确未知而非零成本', async () => {
    const result = await serviceFor(facts({ price: null })).getPreparation(
      input,
      'trace-unknown-price',
    );
    expect(result.ok && result.data.cost).toMatchObject({
      currency: null,
      max: null,
      min: null,
      status: 'UNKNOWN',
    });
    expect(result.ok && result.data.items).toContainEqual(
      expect.objectContaining({ code: 'REFERENCE_COST_UNKNOWN', status: 'WARN' }),
    );
  });

  it('视频与合成前置媒体缺失—阻断而非静默使用过期候选', async () => {
    const video = await serviceFor(facts({ imagesReady: false })).getPreparation(
      { ...input, operation: 'VIDEO' },
      'trace-video',
    );
    expect(video.ok && video.data.items).toContainEqual(
      expect.objectContaining({ code: 'IMAGE_CANDIDATE_REQUIRED', status: 'BLOCK' }),
    );

    const exportResult = await serviceFor(
      facts({ videosReady: false, voiceReady: false }),
    ).getPreparation({ ...input, operation: 'EXPORT' }, 'trace-export');
    expect(exportResult.ok && exportResult.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'VIDEO_CANDIDATE_REQUIRED', status: 'BLOCK' }),
        expect.objectContaining({ code: 'VOICE_REQUIRED', status: 'BLOCK' }),
      ]),
    );
  });
});
