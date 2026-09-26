import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PreparationDialog } from './PreparationDialog';

describe('preparation dialog', () => {
  it('一次展示服务、参考图、预计时长、成本和全部阻断项—只有一个主操作', () => {
    const html = renderToStaticMarkup(
      <PreparationDialog
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onFix={vi.fn()}
        pending={false}
        preparation={{
          canProceed: false,
          cost: { currency: null, effectiveAt: null, max: null, min: null, status: 'UNKNOWN' },
          estimatedDurationSec: 60,
          isDemo: false,
          items: [
            {
              code: 'SERVICE_NOT_READY',
              detail: '尚未配置',
              fixAction: 'OPEN_GENERATION_SERVICES',
              label: '生成服务',
              status: 'BLOCK',
            },
            {
              code: 'STYLE_REFERENCE_MISSING',
              detail: '缺少画风',
              fixAction: 'ADD_STYLE_REFERENCE',
              label: '画风图',
              status: 'BLOCK',
            },
            {
              code: 'CHARACTER_REFERENCE_MISSING',
              detail: '缺少角色',
              fixAction: 'ADD_CHARACTER_REFERENCE',
              label: '角色图',
              status: 'BLOCK',
            },
          ],
          operation: 'IMAGE',
          preparationRevision: 'a'.repeat(64),
          projectId: 'project_12345678',
          shotIds: ['shot_12345678'],
        }}
      />,
    );
    for (const text of ['生成服务', '画风图', '角色图', '预计时长：60 秒', '参考成本：暂不可用']) {
      expect(html).toContain(text);
    }
    expect(html.match(/去处理/g)).toHaveLength(3);
    expect(html.match(/data-primary-action/g) ?? []).toHaveLength(1);
    for (const forbidden of ['Provider', 'profile-', 'workspaceId', 'API Key'])
      expect(html).not.toContain(forbidden);
  });

  it('演示模式—醒目标注零真实费用', () => {
    const html = renderToStaticMarkup(
      <PreparationDialog
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onFix={vi.fn()}
        pending={false}
        preparation={{
          canProceed: true,
          cost: { currency: null, effectiveAt: null, max: null, min: null, status: 'UNKNOWN' },
          estimatedDurationSec: 60,
          isDemo: true,
          items: [
            {
              code: 'DEMO_ZERO_COST',
              detail: '不会产生真实费用',
              fixAction: null,
              label: '参考成本',
              status: 'READY',
            },
          ],
          operation: 'IMAGE',
          preparationRevision: 'b'.repeat(64),
          projectId: 'project_12345678',
          shotIds: ['shot_12345678'],
        }}
      />,
    );
    expect(html).toContain('演示结果 · 不会产生真实费用');
    expect(html).toContain('参考成本：零真实费用');
  });
});
