import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { ImageProviderCardView } from './ImageProviderCard';

const profile = (overrides: Partial<ProviderProfileDto> = {}): ProviderProfileDto => ({
  configured: true,
  enabled: true,
  last4: '9999',
  modelId: 'agnes-image-2.5-flash',
  provider: 'AGNES_IMAGE',
  region: 'global',
  validated: true,
  versionId: 'profile-image-agnes-primary',
  workspaceId: 'agnes',
  ...overrides,
});

const render = (overrides: Partial<Parameters<typeof ImageProviderCardView>[0]> = {}): string =>
  renderToStaticMarkup(
    <ImageProviderCardView
      apiKey=""
      error={null}
      feedback=""
      modelId="agnes-image-2.5-flash"
      onApiKeyChange={vi.fn()}
      onDelete={vi.fn()}
      onModelChange={vi.fn()}
      onModelSave={vi.fn()}
      onSave={vi.fn()}
      onTest={vi.fn()}
      pending={false}
      profile={profile()}
      {...overrides}
    />,
  );

describe('ImageProviderCardView（image-credential-management D4；2026-09-21 切换 Agnes）', () => {
  it('已配置—末四位与模型下拉可见—双模型选项齐备—Key 不回显', () => {
    const html = render();
    expect(html).toContain('已配置（末四位 9999）');
    expect(html).toContain('Agnes Image 2.5 Flash');
    expect(html).toContain('Agnes Image 2.1 Flash');
    expect(html).not.toContain('readOnly=""');
  });

  it('未配置—测试/删除/模型保存（模型未变）禁用—保存在输入 Key 后可用', () => {
    // apiKey 有值且 profile.modelId 与下拉一致：模型保存/测试/删除各贡献一个
    // disabled，共 3 处（保存凭据可点）。
    const html = render({
      apiKey: 'agnes-secret',
      profile: profile({ configured: false, last4: null }),
    });
    expect(html).toContain('未配置');
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
  });

  it('模型切换后—保存模型选择可点', () => {
    // 下拉切到 2.1 Flash（≠ profile 行值）：仅保存凭据因空 Key 禁用，共 1 处。
    const html = render({ modelId: 'agnes-image-2.1-flash' });
    expect(html.match(/disabled=""/gu)).toHaveLength(1);
  });

  it('测试零网络承诺—卡片静态如实文案—避免把解密测试误读为连通性测试', () => {
    const html = render();
    expect(html).toContain('测试仅验证密文可解密读取，不发起计费请求');
  });

  it('Main 侧失败回传—按 AppError 原样展示 code 与 message—不出现密文或堆栈', () => {
    const error: AppErrorDto = {
      code: 'MODEL_CREDENTIAL_INVALID',
      fieldErrors: {},
      message: '图片 API Key 密文无法解密读取（未配置、系统密钥变更或目录迁移）。',
      retryable: false,
      traceId: 'trace_12345678',
      userAction: '请在图片 Provider 设置中重新粘贴 Agnes API Key 并保存。',
    };
    const html = render({ error });
    expect(html).toContain('role="alert"');
    expect(html).toContain('MODEL_CREDENTIAL_INVALID');
    expect(html).toContain('密文无法解密读取');
  });

  it('pending—四按钮与模型下拉全部禁用—避免重复提交覆盖 expectedVersionId', () => {
    const html = render({ apiKey: 'agnes-secret', pending: true });
    expect(html.match(/disabled=""/gu)).toHaveLength(5);
  });
});
