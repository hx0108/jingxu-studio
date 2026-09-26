import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovedSettingsWorkspace } from './ApprovedSettingsWorkspace';

vi.mock('./ProviderSettings', () => ({
  ProviderSettings: () => <p>服务配置内容</p>,
}));

describe('ApprovedSettingsWorkspace — 已批准设置页结构', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
    });
  });

  it('默认首屏展示创作偏好、四类服务、隐私与唯一保存主操作', () => {
    const html = renderToStaticMarkup(<ApprovedSettingsWorkspace onBack={vi.fn()} />);

    for (const expected of [
      '← 返回',
      '创作偏好',
      '文字创作服务',
      '画面生成服务',
      '视频生成服务',
      '语音与配乐服务',
      '数据与隐私',
      '保存设置',
    ]) {
      expect(html).toContain(expected);
    }
    expect(html.match(/class="service-icon"/g) ?? []).toHaveLength(5);
    expect(html.match(/class="approved-service-manage"/g) ?? []).toHaveLength(4);
    expect(html).not.toContain('创作偏好与服务');
  });

  it('默认偏好只有当前选项处于选中状态且高级服务保持收起', () => {
    const html = renderToStaticMarkup(<ApprovedSettingsWorkspace />);

    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(2);
    expect(html).toContain('<details class="approved-service-details">');
    expect(html).not.toContain('<details class="approved-service-details" open="">');
  });
});
