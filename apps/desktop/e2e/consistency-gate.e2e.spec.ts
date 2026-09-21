// E2E（enforce-character-style-consistency 5.4）：单镜头与整集批量的一致性
// 门禁可见性——缺失项、禁用生成、去重汇总与修复后恢复。
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';

import { openProjectsList } from './support/app-navigation';
import { seedStoryboardReady } from './support/storyboard-seeding';

const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const openStoryboard = async (page: Page, projectName: string): Promise<void> => {
  await page.reload();
  await openProjectsList(page);
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

test('§5.4 一致性门禁—缺失项可见、生成禁用、批量去重汇总、补齐后恢复（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-consistency-'));
  const application = await electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: path.join(root, 'managed'),
    },
  });
  try {
    const page = await application.firstWindow();
    // 关键：关闭播种内的一致性资产，复现旧项目缺失锚点态。
    const seeded = await seedStoryboardReady(page, '一致性门禁', undefined, {
      consistencyAssets: false,
    });
    expect(seeded.shotCount).toBe(6);
    await openStoryboard(page, '一致性门禁');

    // 批量入口（分镜 tab）：按钮禁用 + 去重汇总（6 镜头重复引用也只各一条）。
    const batchButton = page.getByRole('button', { name: '为整集生成首帧' });
    await expect(batchButton).toBeDisabled();
    const batchStatus = page.locator('.consistency-status', {
      hasText: '整集一致性预检未通过',
    });
    await expect(batchStatus.getByText('整集一致性预检未通过，请先补齐：')).toBeVisible();
    // 去重语义：画风至多一条，缺失清单整体无重复项。
    const batchMissing = await batchStatus.locator('li').allTextContents();
    expect(batchMissing.filter((text) => text.includes('画风锚点'))).toHaveLength(1);
    expect(new Set(batchMissing).size).toBe(batchMissing.length);

    // 切到画面生成 tab：单镜头面板未就绪 + 缺失清单 + 按钮可见但禁用。
    await page.getByRole('button', { name: '画面生成', exact: true }).first().click();
    const panel = page.locator('#first-frame-panel');
    await expect(panel.getByText('一致性输入未就绪')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('缺少画风锚点：项目画风')).toBeVisible();
    await expect(panel.getByText('缺少角色参考图：林夜')).toBeVisible();
    const generate = panel.getByRole('button', { name: '生成首帧候选' });
    await expect(generate).toBeVisible();
    await expect(generate).toBeDisabled();

    // 经真实 IPC 上传补齐画风与出场角色；预检轮询后按钮恢复可用。
    await page.evaluate(async (projectId: string) => {
      const style = await window.jingxu.image.uploadAssetReference({
        assetType: 'STYLE',
        bibleRefId: 'project-style',
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
        description: 'E2E 补齐画风',
        displayName: '项目画风',
        mimeType: 'image/png',
        projectId,
        requestId: `gate-style_${crypto.randomUUID()}`,
      });
      if (!style.ok) throw new Error(style.error.code);
      const character = await window.jingxu.image.uploadAssetReference({
        assetType: 'CHARACTER',
        bibleRefId: 'char_lead',
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
        description: null,
        displayName: '林夜',
        mimeType: 'image/png',
        projectId,
        requestId: `gate-char_${crypto.randomUUID()}`,
      });
      if (!character.ok) throw new Error(character.error.code);
    }, seeded.projectId);
    await expect(generate).toBeEnabled({ timeout: 15_000 });
    await expect(batchButton).toBeEnabled({ timeout: 15_000 });
    await expect(panel.getByText('一致性输入已就绪')).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});
