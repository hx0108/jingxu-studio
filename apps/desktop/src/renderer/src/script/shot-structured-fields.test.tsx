import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ShotStructuredFields,
  applyShotStructuredFields,
  readShotStructuredFields,
} from './ShotStructuredFields';

const document = {
  content: { action: '她望向车窗。', emotion: '平静', spoken_text: '这里的风，真好。' },
  generation_constraints: { image_prompt: '列车窗边，午后光线。', video_prompt: '镜头缓慢推进。' },
  narrative_purpose: '建立人物状态',
};

describe('ShotStructuredFields', () => {
  it('已有镜头文档—读取四个中文可编辑字段—保持原始内容', () => {
    expect(readShotStructuredFields(document)).toEqual({
      action: '她望向车窗。',
      imagePrompt: '列车窗边，午后光线。',
      spokenText: '这里的风，真好。',
      videoPrompt: '镜头缓慢推进。',
    });
  });

  it('保存结构化字段—只替换对应镜头内容—保留其余契约字段', () => {
    const next = applyShotStructuredFields(document, {
      action: '她拿起怀表。',
      imagePrompt: '暖色调列车窗边。',
      spokenText: '',
      videoPrompt: '固定镜头。',
    });
    expect(next).toMatchObject({
      content: { action: '她拿起怀表。', emotion: '平静', spoken_text: '' },
      generation_constraints: { image_prompt: '暖色调列车窗边。', video_prompt: '固定镜头。' },
      narrative_purpose: '建立人物状态',
    });
    expect(document.content.action).toBe('她望向车窗。');
  });

  it('展示镜头字段—四项均为真正表单控件—没有内部枚举或 JSON 编辑提示', () => {
    const html = renderToStaticMarkup(
      <ShotStructuredFields
        disabled={false}
        document={document}
        onDirtyChange={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(html).toContain('画面内容');
    expect(html).toContain('人物与动作');
    expect(html).toContain('台词');
    expect(html).toContain('镜头运动');
    expect(html.match(/<textarea/gu)).toHaveLength(4);
    expect(html).not.toContain('JSON');
    expect(html).not.toContain('NARRATION_FIRST');
  });
});
