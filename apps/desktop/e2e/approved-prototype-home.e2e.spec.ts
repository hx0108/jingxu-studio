import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');

test('原型首页—三档视口与百分之一百二十五缩放下完整留在首屏', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-approved-home-'));
  const application = await electron.launch({
    args: [desktopRoot],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
        ),
      ),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: path.join(root, 'managed'),
    },
  });
  try {
    const page = await application.firstWindow();
    for (const viewport of [
      { height: 1080, label: '1920x1080', width: 1920, zoom: 1 },
      { height: 900, label: '1440x900', width: 1440, zoom: 1 },
      { height: 800, label: '1280x800-缩放125', width: 1280, zoom: 1.25 },
    ]) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await application.evaluate(({ BrowserWindow }, zoom) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom);
      }, viewport.zoom);
      await expect(page.getByRole('heading', { name: /把一个想法，变成一部/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /AI漫剧/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /AI短剧/ })).toBeVisible();
      await expect(page.getByRole('button', { name: '开始创作', exact: true })).toBeVisible();
      const layout = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell');
        const header = document.querySelector('.global-header');
        const content = document.querySelector('.app-content');
        if (
          !(shell instanceof HTMLElement) ||
          !(header instanceof HTMLElement) ||
          !(content instanceof HTMLElement)
        )
          throw new Error('首页壳层缺失');
        return {
          background: getComputedStyle(shell).backgroundImage,
          contentFits: content.scrollHeight <= content.clientHeight + 1,
          headerHeight: header.getBoundingClientRect().height,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          shellRight: shell.getBoundingClientRect().right,
          viewportWidth: innerWidth,
        };
      });
      await page.screenshot({ path: testInfo.outputPath(`approved-home-${viewport.label}.png`) });
      expect(layout.headerHeight).toBe(64);
      expect(layout.horizontalOverflow).toBe(false);
      expect(layout.contentFits, `${viewport.label} 首页内容超出首屏`).toBe(true);
      expect(layout.shellRight).toBeCloseTo(layout.viewportWidth, 0);
      expect(layout.background).toContain('cinematic-train-background');
    }
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
