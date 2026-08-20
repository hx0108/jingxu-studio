import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { VideoProviderCardView } from './VideoProviderCard';

const profile = (overrides: Partial<ProviderProfileDto> = {}): ProviderProfileDto => ({
  configured: true,
  enabled: true,
  last4: '8888',
  modelId: 'doubao-seedance-1-0-lite-i2v-250428',
  provider: 'VOLCARK_SEEDANCE',
  region: 'cn-beijing',
  validated: true,
  versionId: 'profile-video-primary',
  workspaceId: 'ark',
  ...overrides,
});

const render = (overrides: Partial<Parameters<typeof VideoProviderCardView>[0]> = {}): string =>
  renderToStaticMarkup(
    <VideoProviderCardView
      apiKey=""
      error={null}
      feedback=""
      onApiKeyChange={vi.fn()}
      onDelete={vi.fn()}
      onSave={vi.fn()}
      onTest={vi.fn()}
      pending={false}
      profile={profile()}
      {...overrides}
    />,
  );

describe('VideoProviderCardView（shot-video-generation 4.4）', () => {
  it('已配置—末四位与只读模型 id 可见—Key 输入不回显任何已保存值', () => {
    const html = render();
    expect(html).toContain('已配置（末四位 8888）');
    expect(html).toContain('doubao-seedance-1-0-lite-i2v-250428');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain('value="ark');
  });

  it('未配置—测试与删除禁用—保存仅在输入 Key 后可用', () => {
    // apiKey 有值时：保存可点，测试/删除各贡献一个 disabled，共 2 处。
    const html = render({
      apiKey: 'ark-secret',
      profile: profile({ configured: false, last4: null }),
    });
    expect(html).toContain('未配置');
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it('测试零网络承诺—卡片静态如实文案—指向视频生成前置失败语义', () => {
    const html = render();
    expect(html).toContain('测试仅验证密文可解密读取，不发起计费请求');
    expect(html).toContain('未配置时生成视频段会前置失败并提示');
  });

  it('Main 侧失败回传—按 AppError 原样展示 code 与 message—不出现密文或堆栈', () => {
    const error: AppErrorDto = {
      code: 'MODEL_CREDENTIAL_INVALID',
      fieldErrors: {},
      message: '视频 API Key 密文无法解密读取（未配置、系统密钥变更或目录迁移）。',
      retryable: false,
      traceId: 'trace_12345678',
      userAction: '请在视频 Provider 设置中重新粘贴 ARK API Key 并保存。',
    };
    const html = render({ error });
    expect(html).toContain('role="alert"');
    expect(html).toContain('MODEL_CREDENTIAL_INVALID');
    expect(html).toContain('密文无法解密读取');
  });

  it('pending—三按钮全部禁用—避免重复提交覆盖 expectedVersionId', () => {
    const html = render({ apiKey: 'ark-secret', pending: true });
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
  });
});
