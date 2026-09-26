import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { StageStructuredForm } from './StageStructuredForm';

describe('five-stage structured forms', () => {
  it.each([
    ['CONCEPT', { title: '灯塔' }, ['作品名', '核心冲突', '故事梗概']],
    [
      'STORY_BIBLE',
      { characters: {}, props: {}, scenes: {}, world_rules: [] },
      ['角色', '世界规则', '场景', '道具'],
    ],
    ['EPISODE_OUTLINE', { target_duration_sec: 60 }, ['本集目标', '高潮', '目标时长']],
    ['BEAT_SHEET', { beats: [] }, ['剧情节拍', '添加节拍']],
    ['SCENE_SCRIPT', { scenes: [] }, ['场景剧本', '新增场景']],
  ] as const)('%s 默认展示中文结构化控件，不展示 JSON', (stage, data, labels) => {
    const html = renderToStaticMarkup(
      <StageStructuredForm data={data} disabled={false} onChange={vi.fn()} stage={stage} />,
    );

    for (const label of labels) expect(html).toContain(label);
    expect(html).not.toContain('JSON');
    expect(html).not.toContain('Provider');
  });

  it('CONCEPT 字段错误—映射到对应中文控件附近—保留用户值', () => {
    const html = renderToStaticMarkup(
      <StageStructuredForm
        data={{ title: '用户尚未修完的标题' }}
        disabled={false}
        errors={{ '/data/title': '标题至少需要 2 个字符' }}
        onChange={vi.fn()}
        stage="CONCEPT"
      />,
    );
    expect(html).toContain('用户尚未修完的标题');
    expect(html).toContain('标题至少需要 2 个字符');
  });

  it('SCENE_SCRIPT 有场景—展示目录、正文和真实填写检查—保留结构化对白', () => {
    const html = renderToStaticMarkup(
      <StageStructuredForm
        data={{
          scenes: [
            {
              script_scene_id: 'script_scene_one',
              sequence: 1,
              scene_id: 'scene_one',
              character_ids: ['char_a'],
              action: '林夏走上月台',
              spoken_lines: [{ speaker_id: 'char_a', line_type: 'DIALOGUE', text: '好久不见' }],
              estimated_duration_sec: 60,
            },
          ],
        }}
        disabled={false}
        onChange={vi.fn()}
        referenceData={{
          scenes: { scene_one: { name: '车站月台' } },
          characters: { char_a: { name: '林夏' } },
        }}
        stage="SCENE_SCRIPT"
      />,
    );
    expect(html).toContain('场景目录');
    expect(html).toContain('场景正文编辑');
    expect(html).toContain('好久不见');
    expect(html).toContain('车站月台');
    expect(html).toContain('林夏');
    expect(html).toContain('1 / 1 个场景已填写动作与画面');
    expect(html).not.toContain('说话人|类型|内容');
  });
});
