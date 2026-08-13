import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { OriginalInput } from './OriginalInput';
import { ProviderSettings } from './ProviderSettings';

describe('Staged Script Renderer 可观察基线', () => {
  it('原创初始化—显示字符边界、数据处理确认与明确非目标', () => {
    const html = renderToStaticMarkup(
      <OriginalInput
        onDirtyChange={vi.fn()}
        onInitialized={vi.fn()}
        projectId="project_12345678"
      />,
    );
    expect(html).toContain('0/2,000 个 Unicode 字符');
    expect(html).toContain('最少 20 个');
    expect(html).toContain('第三方 Qwen Provider');
    expect(html).toContain('文件导入、授权改编和 AI 优化尚未开放');
    expect(html).toContain('disabled=""');
  });

  it('Provider 设置—首次加载不回显 Key 或伪装已验证', () => {
    const html = renderToStaticMarkup(<ProviderSettings onReadyChange={vi.fn()} />);
    expect(html).toContain('正在加载 Qwen 设置');
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('已验证');
  });
});
