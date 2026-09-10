import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (managedRoot: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
    },
  });

test('批准原型布局—真实创作工作区与模型服务保持可读三栏和左对齐宽卡', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-prototype-ui-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '创建第一个项目' })).toBeVisible();
    await page.getByRole('button', { name: '创建第一个项目' }).click();
    await page.getByLabel('项目名称').fill('大富翁的每一天');
    await page.getByRole('button', { name: '保存项目' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page
      .getByLabel('创意内容')
      .fill('一个隐形富豪每天收到神秘转账，并在追查金钱来源时发现自己正被精密系统观察。');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '创建剧本工作区' }).click();

    await expect(page.locator('.guided-workspace')).toBeVisible();
    await expect(page.getByText('六阶段创作流程')).toBeVisible();
    await expect(page.locator('.production-phase')).toHaveCount(6);
    await page.setViewportSize({ height: 1064, width: 1728 });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => {
      const rect = (selector: string): DOMRect => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return element.getBoundingClientRect();
      };
      const fontSize = (selector: string): string => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).fontSize;
      };
      return {
        flowWidth: Math.round(rect('.workspace-flow').width),
        inspectorFontSize: fontSize('.workspace-inspector'),
        inspectorWidth: Math.round(rect('.workspace-inspector').width),
        navFontSize: fontSize('.global-nav-item'),
        pillBorderRadius: getComputedStyle(
          document.querySelector('.status-pill') ?? document.body,
        ).borderRadius,
        sidebarWidth: Math.round(rect('.global-sidebar').width),
        topbarText: document.querySelector('.workspace-topbar')?.textContent ?? '',
      };
    });
    expect(metrics).toMatchObject({
      flowWidth: 264,
      inspectorFontSize: '13px',
      inspectorWidth: 360,
      navFontSize: '13px',
      pillBorderRadius: '0px',
      sidebarWidth: 208,
    });
    expect(metrics.topbarText).not.toContain('项目进度自动保存');
    expect(metrics.topbarText).not.toContain('最近保存于刚刚');
    await expect
      .poll(() => page.evaluate(() => ({ height: innerHeight, width: innerWidth })))
      .toEqual({ height: 1064, width: 1728 });
    await page.screenshot({
      path: testInfo.outputPath('implementation-script.png'),
    });

    await page.getByRole('button', { name: '设置', exact: true }).click({ force: true });
    await expect(page.getByRole('heading', { name: '模型服务', exact: true })).toBeVisible();
    await expect(page.locator('.model-service-card')).toHaveCount(4);
    const settingsMetrics = await page.evaluate(() => {
      const pageElement = document.querySelector('.model-services-page');
      const status = document.querySelector('.model-configuration-status');
      if (!(pageElement instanceof HTMLElement) || !(status instanceof HTMLElement)) {
        throw new Error('missing model service layout');
      }
      const pageRect = pageElement.getBoundingClientRect();
      const statusStyle = getComputedStyle(status);
      return {
        contentLeft: Math.round(pageRect.left),
        statusBorder: statusStyle.borderTopStyle,
        statusMarkWidth: getComputedStyle(status, '::before').width,
      };
    });
    expect(settingsMetrics).toMatchObject({
      contentLeft: 208,
      statusBorder: 'none',
      statusMarkWidth: '6px',
    });
    await page.screenshot({
      path: testInfo.outputPath('implementation-settings.png'),
    });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
