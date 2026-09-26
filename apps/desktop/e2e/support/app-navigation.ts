import { expect, type Page } from '@playwright/test';

/**
 * 从任意屏幕回到项目列表。
 *
 * 首页是默认着陆屏；既有流程（列表、详情、导入导出）经全局导航进入。
 * 启动、重启与 page.reload() 之后 Renderer 都会回到首页，旧断言需先调用本助手还原列表语境。
 */
export const openProjectsList = async (page: Page): Promise<void> => {
  await page
    .locator('nav[aria-label="全局导航"]')
    .getByRole('button', { name: '我的作品', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible();
};

/** 在首页点击唯一主操作「继续制作本集」，由服务端事实重新解析当前一步。 */
export const continueFromHome = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '继续制作本集' }).click();
};

/** 生成类主操作统一经过真实准备检查；测试显式确认，不能绕过门禁。 */
export const confirmGenerationPreparation = async (page: Page): Promise<void> => {
  const dialog = page.getByRole('dialog', { name: '确认本次生成准备' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认并开始' }).click();
};
