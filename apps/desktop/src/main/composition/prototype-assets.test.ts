import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const assetDirectory = path.resolve(import.meta.dirname, '../../renderer/src/assets/prototype');

describe('十页原型本地视觉资源', () => {
  it('所有 WebP 都由统一资源清单静态导入，构建器不会遗漏未引用文件', async () => {
    const files = (await readdir(assetDirectory)).filter((name) => name.endsWith('.webp')).sort();
    const manifest = await readFile(path.join(assetDirectory, 'prototype-assets.ts'), 'utf8');

    expect(files).toHaveLength(22);
    for (const file of files) {
      expect(manifest).toContain(`'./${file}'`);
    }
  });

  it('来源清单明确本地边界且不包含外部图片地址', async () => {
    const sourceNote = await readFile(path.join(assetDirectory, 'SOURCES.md'), 'utf8');
    const manifest = await readFile(path.join(assetDirectory, 'prototype-assets.ts'), 'utf8');

    expect(sourceNote).toContain('用户提供');
    expect(sourceNote).toContain('网络依赖：无');
    expect(`${sourceNote}\n${manifest}`).not.toMatch(/https?:\/\//u);
  });
});
