import { describe, expect, it } from 'vitest';

import { parseStoryBibleDescriptions } from './story-bible-descriptions';

const data = {
  characters: { char_lead: { appearance: '黑色风衣，旧怀表', name: '林夜' } },
  scenes: { scene_train: { description: '穿行夜色的旧列车', name: '午夜列车' } },
};

describe('parseStoryBibleDescriptions', () => {
  it('正式 STORY_BIBLE 信封—读取 data.characters/scenes', () => {
    const result = parseStoryBibleDescriptions(
      JSON.stringify({ data, schema_version: '1.0.0', stage: 'STORY_BIBLE' }),
    );
    expect(result).toEqual({ descriptions: data, kind: 'ok' });
  });

  it('历史裸 data—保持兼容读取', () => {
    expect(parseStoryBibleDescriptions(JSON.stringify(data))).toEqual({
      descriptions: data,
      kind: 'ok',
    });
  });

  it.each([
    ['非法 JSON', '{'],
    ['错误 stage', JSON.stringify({ data, stage: 'SCENE_SCRIPT' })],
    ['正式信封缺 data', JSON.stringify({ schema_version: '1.0.0', stage: 'STORY_BIBLE' })],
  ])('%s—返回 invalid 而非空描述', (_name, document) => {
    expect(parseStoryBibleDescriptions(document)).toEqual({ kind: 'invalid' });
  });
});
