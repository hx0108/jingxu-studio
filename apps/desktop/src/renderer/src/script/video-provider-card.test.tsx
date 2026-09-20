import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import {
  AGNES_VIDEO_CARD_VARIANT,
  MockVideoNotice,
  SEEDANCE_VIDEO_CARD_VARIANT,
  VideoProviderCardView,
} from './VideoProviderCard';

const profile = (overrides: Partial<ProviderProfileDto> = {}): ProviderProfileDto => ({
  configured: true,
  enabled: true,
  last4: '8888',
  modelId: 'doubao-seedance-2-0-260128',
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
      isCurrentProvider={false}
      modelId="doubao-seedance-2-0-260128"
      onApiKeyChange={vi.fn()}
      onDelete={vi.fn()}
      onModelChange={vi.fn()}
      onModelSave={vi.fn()}
      onSave={vi.fn()}
      onSetCurrent={null}
      onTest={vi.fn()}
      pending={false}
      profile={profile()}
      variant={SEEDANCE_VIDEO_CARD_VARIANT}
      {...overrides}
    />,
  );

describe('VideoProviderCardView（shot-video-generation 4.4）', () => {
  it('已配置—三个受限模型可见—Key 输入不回显任何已保存值', () => {
    const html = render();
    expect(html).toContain('已配置（末四位 8888）');
    expect(html).toContain('Seedance-2.0-mini');
    expect(html).toContain('Seedance-2.0');
    expect(html).toContain('Seedance-2.5');
    expect(html).not.toContain('value="ark');
  });

  it('未配置—测试与删除禁用—保存仅在输入 Key 后可用', () => {
    // apiKey 有值时：保存可点，测试/删除各贡献一个 disabled，共 2 处。
    const html = render({
      apiKey: 'ark-secret',
      profile: profile({ configured: false, last4: null }),
    });
    expect(html).toContain('未配置');
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
  });

  it('首次读取 Profile 失败—仍允许选择模型并保存输入的 Key', () => {
    const html = render({ apiKey: 'ark-secret', profile: null });

    expect(html).toContain('Seedance-2.5');
    expect(html).not.toContain('<select disabled=""');
    // 测试/删除没有已保存密文时仍禁用；模型和凭据的首次保存必须可用。
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it('测试零网络承诺—卡片静态如实文案—指向视频生成前置失败语义', () => {
    const html = render();
    expect(html).toContain('测试仅验证密文可解密读取，不发起计费请求');
    expect(html).toContain('也不代表模型已开通');
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

  it('pending—模型与凭据操作均禁用—避免重复提交覆盖 expectedVersionId', () => {
    const html = render({ apiKey: 'ark-secret', pending: true });
    expect(html.match(/disabled=""/gu)).toHaveLength(5);
  });
});

describe('VideoProviderCardView—Agnes 低价档（low-cost 6.3）', () => {
  it('两档受限模型可见—徽标仅当前档显示—免费/限流提示在卡内', () => {
    const html = render({ variant: AGNES_VIDEO_CARD_VARIANT, modelId: 'agnes-video-v2.0' });
    expect(html).toContain('Agnes Video V2.0');
    expect(html).toContain('Agnes Video 2.5 Flash');
    expect(html).toContain('Agnes AI');
    expect(html).toContain('$0/秒');
    expect(html).toContain('每分钟限 1 个任务');
    expect(html).not.toContain('model-current-provider-badge');
  });

  it('isCurrentProvider—显示当前视频档徽标且设为按钮进入禁用态', () => {
    const html = render({
      isCurrentProvider: true,
      onSetCurrent: vi.fn(),
      variant: AGNES_VIDEO_CARD_VARIANT,
    });
    expect(html).toContain('当前视频档');
    expect(html).toContain('已是当前视频档');
  });

  it('onSetCurrent 为 null—不渲染设为按钮（偏好未载入时）', () => {
    const html = render({ variant: SEEDANCE_VIDEO_CARD_VARIANT });
    expect(html).not.toContain('设为当前视频档');
  });
});

describe('Mock 标记（low-cost 6.3）', () => {
  it('Mock 醒目标记—声明零网络/不计费/不读密钥且不可在页面选择', () => {
    const html = renderToStaticMarkup(<MockVideoNotice />);
    expect(html).toContain('联调模拟（Mock）');
    expect(html).toContain('零网络 Mock');
    expect(html).toContain('不计费');
    expect(html).toContain('不能在此页面选择或关闭');
    expect(html).toContain('JINGXU_VIDEO_PROVIDER=MOCK');
  });
});
