import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VoicePanel } from './VoicePanel';

describe('VoicePanel', () => {
  it('初态—配音工作台壳可见、批量入口禁用且不出现映射保存入口', () => {
    const html = renderToStaticMarkup(
      <VoicePanel episodeId="episode_0001" projectId="project_0001" />,
    );
    expect(html).toContain('配音工作台');
    expect(html).toContain('音色白名单在服务层校验');
    // 候选与镜头列表尚未载入：批量入口禁用，映射保存入口不渲染。
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*name="generate-voice-batch"/u);
    expect(html).not.toContain('save-voice-mappings');
  });

  it('脱敏红线—初态不出现本地路径、进程或媒体文件痕迹', () => {
    const html = renderToStaticMarkup(
      <VoicePanel episodeId="episode_0001" projectId="project_0001" />,
    );
    expect(html).not.toContain('C:');
    expect(html).not.toContain('.wav');
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('--');
  });
});
