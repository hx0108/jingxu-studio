import type {
  AppResultDto,
  CreatorPreparationResultDto,
  GetCreatorPreparationInputDto,
} from '@jingxu/contracts';

import type { CreatorPreparationQueryPort } from '../ports/creator-guide';

export interface CreatorPreparationService {
  getPreparation(
    input: GetCreatorPreparationInputDto,
    traceId: string,
  ): Promise<AppResultDto<CreatorPreparationResultDto>>;
}

const failure = (traceId: string): AppResultDto<CreatorPreparationResultDto> => ({
  ok: false,
  error: {
    code: 'CREATOR_GUIDE_PROJECT_NOT_FOUND',
    fieldErrors: null,
    message: '作品不存在或当前范围已变化',
    retryable: true,
    traceId,
    userAction: '返回作品后重新检查',
  },
});

const toIsoDateTime = (value: string): string | null => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export const createCreatorPreparationService = (
  query: CreatorPreparationQueryPort,
  dependencies: {
    readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
    readonly now: () => string;
  },
): CreatorPreparationService => ({
  async getPreparation(input, traceId) {
    const facts = await query.getFacts(input);
    if (facts === null) return failure(traceId);
    const items: CreatorPreparationResultDto['items'] = [];
    items.push({
      code: facts.serviceReady ? 'SERVICE_READY' : 'SERVICE_NOT_READY',
      detail: facts.isDemo
        ? '体验模式使用内置模拟生成，不需要配置服务。'
        : facts.serviceReady
          ? '本次操作所需生成服务已配置。'
          : '尚未完成本次操作所需的生成服务配置。',
      fixAction: facts.serviceReady ? null : 'OPEN_GENERATION_SERVICES',
      label: '生成服务',
      status: facts.serviceReady || facts.isDemo ? 'READY' : 'BLOCK',
    });
    if (input.operation === 'IMAGE') {
      const missingStyle = facts.consistencyMissing.includes('STYLE');
      const missingCharacter = facts.consistencyMissing.includes('CHARACTER');
      items.push({
        code: missingStyle ? 'STYLE_REFERENCE_MISSING' : 'STYLE_REFERENCE_READY',
        detail: missingStyle ? '缺少本集画风参考图。' : '画风参考图已准备。',
        fixAction: missingStyle ? 'ADD_STYLE_REFERENCE' : null,
        label: '画风图',
        status: missingStyle ? 'BLOCK' : 'READY',
      });
      items.push({
        code: missingCharacter ? 'CHARACTER_REFERENCE_MISSING' : 'CHARACTER_REFERENCE_READY',
        detail: missingCharacter ? '有出场角色缺少参考图。' : '出场角色参考图已准备。',
        fixAction: missingCharacter ? 'ADD_CHARACTER_REFERENCE' : null,
        label: '角色图',
        status: missingCharacter ? 'BLOCK' : 'READY',
      });
      if (facts.referenceLimitExceeded) {
        items.push({
          code: 'REFERENCE_LIMIT_EXCEEDED',
          detail: '部分镜头的必需参考图超过当前生成服务上限。',
          fixAction: 'RETURN_TO_WORKSPACE',
          label: '参考图数量',
          status: 'BLOCK',
        });
      }
    }
    if (input.operation === 'VIDEO') {
      items.push({
        code: facts.imagesReady ? 'IMAGE_CANDIDATES_READY' : 'IMAGE_CANDIDATE_REQUIRED',
        detail: facts.imagesReady ? '每个镜头都已选好画面。' : '有镜头尚未选择可用画面。',
        fixAction: facts.imagesReady ? null : 'SELECT_IMAGE_CANDIDATE',
        label: '镜头画面',
        status: facts.imagesReady ? 'READY' : 'BLOCK',
      });
    }
    if (input.operation === 'VOICE' || input.operation === 'EXPORT') {
      items.push({
        code: facts.videosReady ? 'VIDEO_CANDIDATES_READY' : 'VIDEO_CANDIDATE_REQUIRED',
        detail: facts.videosReady ? '每个镜头都已选好视频片段。' : '有镜头尚未选择可用视频片段。',
        fixAction: facts.videosReady ? null : 'SELECT_VIDEO_CANDIDATE',
        label: '视频片段',
        status: facts.videosReady ? 'READY' : 'BLOCK',
      });
    }
    if (input.operation === 'EXPORT') {
      items.push({
        code: facts.voiceReady ? 'VOICE_READY' : 'VOICE_REQUIRED',
        detail: facts.voiceReady ? '需要配音的镜头均已准备。' : '本集配音尚未准备完整。',
        fixAction: facts.voiceReady ? null : 'CONFIGURE_VOICE',
        label: '配音',
        status: facts.voiceReady ? 'READY' : 'BLOCK',
      });
    }
    items.push({
      code: 'ESTIMATED_DURATION',
      detail:
        facts.estimatedDurationSec === null
          ? '暂时无法估算本次生成时长。'
          : `本集预计 ${String(facts.estimatedDurationSec)} 秒。`,
      fixAction: null,
      label: '预计时长',
      status: facts.estimatedDurationSec === null ? 'WARN' : 'READY',
    });

    const current = Date.parse(dependencies.now());
    const effectiveAt = facts.price === null ? null : toIsoDateTime(facts.price.effectiveAt);
    const expiresAt = facts.price === null ? null : Date.parse(facts.price.expiresAt);
    const priceStatus: CreatorPreparationResultDto['cost']['status'] =
      facts.isDemo ||
      facts.price === null ||
      effectiveAt === null ||
      expiresAt === null ||
      !Number.isFinite(expiresAt)
        ? 'UNKNOWN'
        : expiresAt <= current
          ? 'STALE'
          : 'AVAILABLE';
    const cost =
      priceStatus === 'AVAILABLE' && facts.price !== null
        ? {
            currency: facts.price.currency,
            effectiveAt,
            max: facts.price.max * input.shotIds.length,
            min: facts.price.min * input.shotIds.length,
            status: priceStatus,
          }
        : { currency: null, effectiveAt: null, max: null, min: null, status: priceStatus };
    items.push({
      code: facts.isDemo
        ? 'DEMO_ZERO_COST'
        : priceStatus === 'AVAILABLE'
          ? 'REFERENCE_COST_AVAILABLE'
          : priceStatus === 'STALE'
            ? 'REFERENCE_COST_STALE'
            : 'REFERENCE_COST_UNKNOWN',
      detail: facts.isDemo
        ? '体验模式不会产生真实费用。'
        : priceStatus === 'AVAILABLE'
          ? '参考成本已按本次镜头范围估算，实际费用以服务商为准。'
          : priceStatus === 'STALE'
            ? '参考价格已过期，实际费用需以服务商为准。'
            : '当前没有可用参考价格，实际费用需以服务商为准。',
      fixAction: null,
      label: '参考成本',
      status: priceStatus === 'AVAILABLE' || facts.isDemo ? 'READY' : 'WARN',
    });
    const preparationRevision = dependencies.hashPayload({ facts, input });
    return {
      ok: true,
      data: {
        canProceed: !items.some((item) => item.status === 'BLOCK'),
        cost,
        estimatedDurationSec: facts.estimatedDurationSec,
        isDemo: facts.isDemo,
        items,
        operation: input.operation,
        preparationRevision,
        projectId: input.projectId,
        shotIds: input.shotIds,
      },
    };
  },
});
