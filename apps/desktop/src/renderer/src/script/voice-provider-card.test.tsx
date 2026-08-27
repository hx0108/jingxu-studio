import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { VoiceProviderCardView } from './VoiceProviderCard';

const profile = (overrides: Partial<ProviderProfileDto> = {}): ProviderProfileDto => ({
  configured: true,
  enabled: true,
  last4: '8888',
  modelId: 'qwen3-tts-instruct-flash',
  provider: 'QWEN_TTS',
  region: 'cn-beijing',
  validated: true,
  versionId: 'profile-voice-primary',
  workspaceId: 'dashscope',
  ...overrides,
});

const render = (overrides: Partial<Parameters<typeof VoiceProviderCardView>[0]> = {}): string =>
  renderToStaticMarkup(
    <VoiceProviderCardView
      apiKey=""
      error={null}
      feedback=""
      modelId="qwen3-tts-instruct-flash"
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

describe('VoiceProviderCardView（v2-voice-audio-timeline 3.1）', () => {
  it('已配置—注册表内模型可见—Key 输入不回显任何已保存值', () => {
    const html = render();
    expect(html).toContain('已配置（末四位 8888）');
    expect(html).toContain('千问3-TTS-Instruct-Flash');
    // 同 key 双档提示如实呈现：与文本档共用同一把 DashScope Key。
    expect(html).toContain('再粘贴一次');
    expect(html).not.toContain('value="dashscope');
  });

  it('未配置—测试与删除禁用—保存仅在输入 Key 后可用', () => {
    // apiKey 有值时：保存可点，测试/删除/保存模型（modelId 相同）各贡献 disabled。
    const html = render({
      apiKey: 'dashscope-secret',
      profile: profile({ configured: false, last4: null }),
    });
    expect(html).toContain('未配置');
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
  });

  it('首次读取 Profile 失败—仍允许选择模型并保存输入的 Key', () => {
    const html = render({ apiKey: 'dashscope-secret', profile: null });
    expect(html).toContain('千问3-TTS-Instruct-Flash');
    expect(html).not.toContain('<select disabled=""');
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it('测试零网络承诺—卡片静态如实文案—指向配音前置失败语义', () => {
    const html = render();
    expect(html).toContain('测试仅验证密文可解密读取，不发起计费请求');
    expect(html).toContain('也不代表模型已开通');
  });

  it('Main 侧失败回传—按 AppError 原样展示 code 与 message—不出现密文或堆栈', () => {
    const error: AppErrorDto = {
      code: 'MODEL_CREDENTIAL_INVALID',
      fieldErrors: {},
      message: '配音 API Key 密文无法解密读取（未配置、系统密钥变更或目录迁移）。',
      retryable: false,
      traceId: 'trace_12345678',
      userAction: '请在配音 Provider 设置中重新粘贴 DashScope API Key 并保存。',
    };
    const html = render({ error });
    expect(html).toContain('role="alert"');
    expect(html).toContain('MODEL_CREDENTIAL_INVALID');
    expect(html).toContain('密文无法解密读取');
  });

  it('pending—模型与凭据操作均禁用—避免重复提交覆盖 expectedVersionId', () => {
    const html = render({ apiKey: 'dashscope-secret', pending: true });
    expect(html.match(/disabled=""/gu)).toHaveLength(5);
  });
});
