import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';

import { prepareDemoMediaTimeline } from './support/storyboard-seeding';

const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const expectViewportAligned = async (
  page: Page,
  options: { readonly allowVerticalScroll?: boolean } = {},
): Promise<void> => {
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.app-content');
    const flow = document.querySelector('.creator-stage-bar');
    const inspector = document.querySelector(
      '.workspace-inspector, .prototype-tip-panel, .scene-script-check, .approved-evaluation-results',
    );
    if (!(content instanceof HTMLElement)) throw new Error('页面内容容器缺失');
    return {
      contentClientHeight: content.clientHeight,
      contentFits: content.scrollHeight <= content.clientHeight + 1,
      contentScrollHeight: content.scrollHeight,
      documentHeightOverflow: document.documentElement.scrollHeight - innerHeight,
      flowBottom: flow?.getBoundingClientRect().bottom ?? 0,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      inspectorRight: inspector?.getBoundingClientRect().right ?? 0,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  });
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(layout.flowBottom).toBeLessThan(layout.viewportHeight);
  expect(layout.inspectorRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  if (options.allowVerticalScroll !== true) {
    expect(layout.contentFits, JSON.stringify(layout)).toBe(true);
    expect(layout.documentHeightOverflow).toBeLessThanOrEqual(1);
  }
};

test('十页正式工作台—从示例项目逐页可达且全部使用中文页名', async ({}, testInfo) => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-approved-navigation-'));
  const application = await electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: path.join(root, 'managed'),
      JINGXU_E2E_VIDEO_STEPS: Array.from({ length: 12 }, () => 'A:P0').join(','),
    },
  });

  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ height: 900, width: 1440 });
    const capture = (name: string): Promise<Buffer> =>
      page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

    await expect(page.getByRole('heading', { name: /把一个想法，变成一部/ })).toBeVisible();
    await capture('01-开始创作');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();
    await expect(page.getByText(/演示结果.*不会产生真实费用/u)).toBeVisible({ timeout: 90_000 });
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
      throw new Error('DEMO_PROJECT_MISSING');
    });

    const globalNavigation = page.locator('nav[aria-label="全局导航"]');
    await page.getByRole('button', { name: '返回作品' }).click();
    await page.getByRole('button', { name: '返回镜序首页' }).click();
    await globalNavigation.getByRole('button', { name: '我的作品', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible();
    await expect(page.locator('.project-card-cover')).toHaveCount(1);
    await expect(page.locator('.project-list-head')).toContainText('当前阶段');
    await expect(page.locator('.project-list-head')).toContainText('完成进度');
    await expect(page.locator('.project-card-stage')).not.toContainText('正在读取阶段');
    await expect(page.locator('.project-card-progress progress')).toHaveCount(1);
    await expectViewportAligned(page);
    await capture('02-我的作品');

    await page.getByRole('button', { name: '返回镜序首页' }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    const creatorNavigation = page.locator('nav[aria-label="六步创作流程"]');

    await creatorNavigation.getByRole('button', { name: '故事构思' }).click();
    await expect(page.getByRole('heading', { name: '创作故事梗概', exact: true })).toBeVisible();
    await expectViewportAligned(page);
    await capture('03-故事构思');

    await creatorNavigation.getByRole('button', { name: '剧本完善' }).click();
    await page
      .locator('nav[aria-label="剧本完善环节"]')
      .getByRole('button', { name: '场景剧本' })
      .click();
    await expect(page.getByRole('heading', { name: '剧本完善', exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: '场景正文编辑' }).getByRole('heading', { name: '场景1' }),
    ).toBeVisible();
    await page
      .getByRole('complementary', { name: '场景目录' })
      .getByRole('button', { name: /场景2/u })
      .click();
    await expect(
      page.getByRole('region', { name: '场景正文编辑' }).getByRole('heading', { name: '场景2' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '场景正文编辑' }).getByLabel('场景设定'),
    ).toHaveValue(/scene_/u);
    await expect(
      page.getByRole('region', { name: '场景正文编辑' }).getByText('阿澄', { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole('complementary', { name: '场景目录' })
      .getByRole('button', { name: /场景1/u })
      .click();
    await expect(
      page.getByRole('region', { name: '场景正文编辑' }).getByRole('heading', { name: '场景1' }),
    ).toBeVisible();
    await expectViewportAligned(page);
    await capture('04-剧本完善');

    for (const pageName of ['分镜设计', '画面生成', '视频生成', '合成导出']) {
      await page.locator('.creator-stage-progress').getByText(pageName, { exact: true }).click();
      await expect(page.locator('.media-page-title')).toHaveText(pageName);
      if (pageName === '分镜设计') {
        await expect
          .poll(() =>
            page
              .locator('.shot-card-visual')
              .evaluateAll((images) =>
                images.every(
                  (image) =>
                    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        const storyboardBounds = await page
          .locator('.media-step-storyboard > .shot-detail')
          .evaluate((element) => ({
            bottom: element.getBoundingClientRect().bottom,
            height: innerHeight,
          }));
        expect(storyboardBounds.bottom).toBeLessThanOrEqual(storyboardBounds.height);
      }
      if (pageName === '画面生成' || pageName === '视频生成') {
        const panel = pageName === '画面生成' ? '#first-frame-panel' : '#video-panel';
        const lastCandidate = page
          .locator(
            `${panel} .candidate-grid img, ${panel} .candidate-grid video, ${panel} .prototype-candidate-strip img`,
          )
          .last();
        await lastCandidate.scrollIntoViewIfNeeded();
        await expect(lastCandidate).toBeVisible();
        await page.getByRole('region', { name: '页面内容' }).evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      if (pageName === '合成导出') {
        const recentExports = page.getByRole('heading', { name: '最近导出记录' });
        await recentExports.scrollIntoViewIfNeeded();
        await expect(recentExports).toBeVisible();
        await page.getByRole('region', { name: '页面内容' }).evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      const index = ['分镜设计', '画面生成', '视频生成', '合成导出'].indexOf(pageName) + 5;
      await expectViewportAligned(page, { allowVerticalScroll: pageName !== '分镜设计' });
      await capture(`${String(index).padStart(2, '0')}-${pageName}`);
      if (pageName === '分镜设计') {
        await page.locator('.creator-more-button').click();
        await page.getByRole('menuitem', { name: '版本管理', exact: true }).click();
        const storyboardHistory = page.locator('.storyboard-history');
        await expect(storyboardHistory).toBeVisible();
        await storyboardHistory.locator('summary').click();
        await expect(storyboardHistory).not.toBeVisible();
        const imageField = page.locator('.shot-structured-fields').getByLabel('画面内容');
        const editedValue = `${await imageField.inputValue()} 镜头光线更柔和`;
        await imageField.fill(editedValue);
        await creatorNavigation.getByRole('button', { name: '画面生成' }).click();
        const leaveDialog = page.getByRole('dialog', { name: '创作设定尚未保存' });
        await expect(leaveDialog).toBeVisible();
        await leaveDialog.getByRole('button', { name: '取消' }).click();
        await expect(imageField).toHaveValue(editedValue);
        await creatorNavigation.getByRole('button', { name: '画面生成' }).click();
        await leaveDialog.getByRole('button', { name: '放弃修改' }).click();
        await prepareDemoMediaTimeline(page, demoProjectId);
        await page.reload();
        await page.getByRole('button', { name: '继续', exact: true }).click();
      }
    }
    const scrollRegions = await page.evaluate(() => {
      const appContent = document.querySelector('.app-content');
      const shotList = document.querySelector('.media-workspace > .shot-card-list');
      const contextPanel = document.querySelector('.media-context-panel');
      if (!(appContent instanceof HTMLElement)) throw new Error('工作区滚动容器缺失');
      return {
        contextOverflow: contextPanel === null ? null : getComputedStyle(contextPanel).overflowY,
        pageCanScroll: appContent.scrollHeight >= appContent.clientHeight,
        shotOverflow: shotList === null ? null : getComputedStyle(shotList).overflowY,
      };
    });
    expect(scrollRegions).toEqual({
      contextOverflow: 'visible',
      pageCanScroll: true,
      shotOverflow: 'visible',
    });
    const appContent = page.getByRole('region', { name: '页面内容' });
    await appContent.evaluate((element) => {
      element.scrollTop = 0;
    });
    if (await appContent.evaluate((element) => element.scrollHeight > element.clientHeight + 1)) {
      await appContent.focus();
      await page.keyboard.press('PageDown');
      await expect
        .poll(() => appContent.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }

    await page.locator('.creator-more-button').click();
    await page.getByRole('menuitem', { name: '质量操作' }).click();
    await expect(page.getByRole('heading', { name: '质量评测', exact: true })).toBeVisible();
    const evaluationWorkspace = page.locator('.evaluation-workspace');
    const evaluationReport = page.locator('.evaluation-dataset-details');
    await expect(evaluationReport).toBeVisible();
    const evaluationBounds = await evaluationWorkspace.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      documentOverflow: document.documentElement.scrollHeight - innerHeight,
      height: innerHeight,
      reportBottom:
        document.querySelector('.evaluation-dataset-details')?.getBoundingClientRect().bottom ??
        Number.POSITIVE_INFINITY,
    }));
    expect(evaluationBounds.bottom).toBeLessThanOrEqual(evaluationBounds.height + 1);
    expect(evaluationBounds.reportBottom).toBeLessThanOrEqual(evaluationBounds.height + 1);
    expect(evaluationBounds.documentOverflow).toBeLessThanOrEqual(1);

    const selectedHeading = page.locator('.evaluation-preview-heading h2');
    await expect(selectedHeading).toContainText('镜头 2 / 6');
    await page.getByRole('button', { name: '下一个镜头', exact: true }).click();
    await expect(selectedHeading).toContainText('镜头 3 / 6');
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await expect(page.getByRole('heading', { name: '镜头列表（6）' })).toBeVisible();

    const currentProjectType = (
      await page.locator('.evaluation-results-heading h2').textContent()
    )?.includes('漫剧')
      ? '漫剧'
      : '短剧';
    const otherProjectType = currentProjectType === '漫剧' ? '短剧' : '漫剧';
    await page.getByRole('button', { name: otherProjectType, exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前类型没有演示作品' })).toBeVisible();
    await page.getByRole('button', { name: currentProjectType, exact: true }).click();
    await expect(page.getByRole('heading', { name: '镜头列表（6）' })).toBeVisible();
    await page.locator('.approved-evaluation-shots > button').nth(1).click();
    await expect(selectedHeading).toContainText('镜头 2 / 6');
    await expect
      .poll(() =>
        page
          .getByRole('img', { name: '镜头 2 预览' })
          .evaluate((image) => (image instanceof HTMLImageElement ? image.naturalWidth : 0)),
      )
      .toBeGreaterThanOrEqual(650);
    await expectViewportAligned(page);
    await capture('09-质量评测');

    await globalNavigation.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '← 返回' })).toBeVisible();
    await expect(page.locator('.approved-service-list .service-icon')).toHaveCount(4);
    await expect(page.locator('.approved-service-manage')).toHaveCount(4);
    await expect(page.locator('.approved-service-details')).not.toBeVisible();
    const settingsBounds = await page.locator('.approved-settings-page').evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      height: innerHeight,
      overflow: document.documentElement.scrollHeight - innerHeight,
    }));
    expect(settingsBounds.bottom).toBeLessThanOrEqual(settingsBounds.height + 1);
    expect(settingsBounds.overflow).toBeLessThanOrEqual(1);
    await expectViewportAligned(page);
    await capture('10-设置');
    await page.getByRole('button', { name: '横屏', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('创作偏好已保存在本机');

    await globalNavigation.getByRole('button', { name: '我的作品', exact: true }).click();
    await page.locator('.project-card').click();
    await page.getByRole('button', { name: '进入剧本工作区', exact: true }).click();
    const responsiveCreatorNavigation = page.locator('nav[aria-label="六步创作流程"]');
    for (const viewport of [
      { height: 1080, width: 1920, zoom: 1 },
      { height: 900, width: 1440, zoom: 1 },
      { height: 800, width: 1280, zoom: 1.25 },
    ]) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await application.evaluate(({ BrowserWindow }, zoom) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom);
      }, viewport.zoom);

      await responsiveCreatorNavigation.getByRole('button', { name: '故事构思' }).click();
      await expect(page.getByRole('heading', { name: '创作故事梗概', exact: true })).toBeVisible();
      await expectViewportAligned(page);

      await responsiveCreatorNavigation.getByRole('button', { name: '剧本完善' }).click();
      await page
        .locator('nav[aria-label="剧本完善环节"]')
        .getByRole('button', { name: '场景剧本' })
        .click();
      await expect(page.getByRole('heading', { name: '剧本完善', exact: true })).toBeVisible();
      await expectViewportAligned(page);

      await responsiveCreatorNavigation.getByRole('button', { name: '分镜设计' }).click();
      await expect(page.locator('.media-page-title')).toHaveText('分镜设计');
      await expectViewportAligned(page);
    }
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
