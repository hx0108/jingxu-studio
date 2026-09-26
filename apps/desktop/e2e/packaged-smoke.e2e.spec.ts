import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

import { prepareDemoMediaTimeline } from './support/storyboard-seeding';

// Throwaway packaged-binary smoke. Launches the built jingxu-studio.exe and asserts it boots
// to the project UI (heading visible) rather than a READ_ONLY_FAULT page. Run only when the
// package exists at apps/desktop/out/.

const exePath = path.resolve(__dirname, '..', 'out', '镜序 Studio-win32-x64', 'jingxu-studio.exe');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

test('packaged smoke—应用启动且随包演示资源可离线初始化', async () => {
  test.skip(!existsSync(exePath), 'packaged exe not built (run package:win first)');
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-pkg-smoke-'));
  try {
    const application = await electron.launch({
      executablePath: exePath,
      env: {
        ...environment(),
        JINGXU_E2E: '1',
        JINGXU_E2E_DATA_ROOT: path.join(root, 'managed'),
        JINGXU_E2E_VIDEO_STEPS: Array.from({ length: 12 }, () => 'A:P0').join(','),
      },
    });
    try {
      const page = await application.firstWindow();
      await expect(
        page.getByRole('heading', { name: '把一个想法，变成一部好故事', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.global-sidebar')).toHaveCount(0);
      const projectsNav = page
        .locator('nav[aria-label="全局导航"]')
        .getByRole('button', { name: '我的作品', exact: true });
      await expect(projectsNav).toBeVisible({ timeout: 20_000 });
      await projectsNav.click();
      await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole('button', { name: '返回镜序首页' }).click();
      await page.getByRole('button', { name: '开始创作', exact: true }).click();
      await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();
      await expect(page.getByText(/演示结果.*不会产生真实费用/u)).toBeVisible({
        timeout: 90_000,
      });
      await page.reload();
      await expect(
        page.getByRole('heading', { name: '把一个想法，变成一部好故事', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await page
        .locator('nav[aria-label="全局导航"]')
        .getByRole('button', { name: '我的作品', exact: true })
        .click();
      await expect(page.locator('.project-list-head')).toContainText('当前阶段');
      await expect(page.locator('.project-list-head')).toContainText('完成进度');
      await expect(page.locator('.project-card-stage')).not.toContainText('正在读取阶段');
      await expect(page.locator('.project-card-progress progress')).toHaveCount(1);
      const demoProjectId = await page.evaluate(async () => {
        const projects = await window.jingxu.project.list({
          cursor: null,
          limit: 20,
          scope: 'ACTIVE',
          search: null,
        });
        if (!projects.ok) throw new Error(projects.error.code);
        for (const summary of projects.data.items) {
          const detail = await window.jingxu.project.get({
            projectId: summary.id,
            scope: 'ACTIVE',
          });
          if (detail.ok && detail.data.experienceMode === 'DEMO') return detail.data.id;
        }
        throw new Error('PACKAGED_DEMO_PROJECT_MISSING');
      });
      await prepareDemoMediaTimeline(page, demoProjectId);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: '把一个想法，变成一部好故事', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await page
        .locator('nav[aria-label="全局导航"]')
        .getByRole('button', { name: '我的作品', exact: true })
        .click();
      await page.locator('.project-card').click();
      await page.getByRole('button', { name: '进入剧本工作区', exact: true }).click();
      const creatorNavigation = page.locator('nav[aria-label="六步创作流程"]');
      await expect(creatorNavigation).toBeVisible();
      const compositionStep = creatorNavigation.locator('button').filter({ hasText: '合成导出' });
      await expect(compositionStep).toHaveCount(1);
      await compositionStep.click();
      const editor = page.getByRole('region', { name: '可剪辑时间线' });
      await expect(editor.getByRole('group', { name: '画面轨' })).toBeVisible();
      await expect(editor.getByRole('group', { name: '对白轨' })).toBeVisible();
      await expect(editor.getByRole('group', { name: '配乐轨' })).toBeVisible();
      await page.locator('.creator-more-button').click();
      await page.getByRole('menuitem', { name: '质量操作', exact: true }).click();
      await expect(page.getByRole('heading', { name: '质量评测', exact: true })).toBeVisible();
      await expect(page.locator('.approved-evaluation-layout')).toBeVisible();
      await expect(page.locator('.evaluation-dataset-details')).toBeVisible();
      await expect
        .poll(() =>
          page
            .getByRole('img', { name: '镜头 2 预览' })
            .evaluate((image) => (image instanceof HTMLImageElement ? image.naturalWidth : 0)),
        )
        .toBeGreaterThanOrEqual(650);
      await page
        .locator('nav[aria-label="全局导航"]')
        .getByRole('button', { name: '设置', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
      await expect(page.locator('.approved-service-list .service-icon')).toHaveCount(4);
      await expect(page.locator('.approved-service-manage')).toHaveCount(4);
      await expect(page.locator('.approved-service-details')).not.toBeVisible();
    } finally {
      await application.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
