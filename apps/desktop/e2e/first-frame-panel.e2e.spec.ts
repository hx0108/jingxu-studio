import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { seedStoryboardReady } from './support/storyboard-seeding';

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

/** 等待面板内全部候选 <img> 真实解码（正向取图：jingxu://media 必须回真字节）。 */
const waitForDecodedImages = async (page: Page, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>('#first-frame-panel .candidate-grid img'),
      );
      return images.length > 0 && images.every((image) => image.naturalWidth > 0);
    },
    undefined,
    { timeout },
  );

test('§5.3 逐镜头首帧面板—生成/选择/参考图升版 STALE 与受影响镜头清单（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-first-frame-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();

    // 播种：五阶段 READY → 整集分镜 READY（共享助手，v8 起的通用通道）。
    const seeded = await seedStoryboardReady(page, '首帧闭环');
    // 资产 v1：生成前上传，使首轮候选的 generation_input_hash 绑定 v1。
    const assetV1 = await page.evaluate(async (projectId: string) => {
      const uploaded = await window.jingxu.image.uploadAssetReference({
        assetType: 'SCENE',
        bibleRefId: 'scene_train',
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
        description: null,
        displayName: '午夜列车',
        mimeType: 'image/png',
        projectId,
        requestId: `asset-v1_${crypto.randomUUID()}`,
      });
      if (!uploaded.ok) throw new Error(`asset:${uploaded.error.code}`);
      return uploaded.data.version.versionNo;
    }, seeded.projectId);

    expect(seeded.shotCount).toBe(6);
    expect(assetV1).toBe(1);

    // UI happy path：重载后从项目列表走真实入口进分镜工作区。
    await page.reload();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
    await page.locator('.project-card-main', { hasText: '首帧闭环' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
    await page.locator('.shot-card', { hasText: '#1' }).click();

    // 首帧面板：READY 整集下可生成；候选经受限取图协议真实解码。
    const panel = page.locator('#first-frame-panel');
    await expect(panel.getByRole('heading', { name: '首帧候选 · 镜头 #1' })).toBeVisible();
    await expect(panel.getByText('该镜头尚未生成首帧候选。')).toBeVisible();
    await panel.getByRole('button', { name: '生成首帧候选' }).click();
    await expect(panel.getByText('任务状态：COMPLETED')).toBeVisible({ timeout: 30_000 });
    await waitForDecodedImages(page);
    await expect(panel.locator('.candidate-card')).toHaveCount(4);
    await expect(panel.locator('.candidate-grid img')).toHaveCount(4);
    await expect(panel.getByText('当前输入世代')).toBeVisible();

    // 当前世代内比较与人工选择。
    await panel.getByRole('button', { name: '设为当前首帧' }).first().click();
    await expect(panel.locator('.selection-badge')).toHaveText('当前首帧');
    await expect(panel.getByRole('button', { name: '设为当前首帧' })).toHaveCount(3);

    // 参考图升版 v2：旧世代候选全员 STALE_INPUT + 受影响镜头清单。
    await page.getByLabel('圣经引用 ID（char_*/scene_*）').fill('scene_train');
    await page.getByLabel('资产显示名称').fill('午夜列车');
    await page.locator('#reference-upload-form input[type="file"]').setInputFiles({
      buffer: Buffer.from([4, 5, 6]),
      mimeType: 'image/png',
      name: 'scene-train-v2.png',
    });
    await page.getByRole('button', { name: '上传参考图' }).click();
    await expect(panel.getByText('参考图已上传为版本 v2')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('受影响镜头（候选已标记失效，需重新生成）：')).toBeVisible();
    await expect(panel.locator('.affected-shot-list li')).toHaveCount(1);
    await expect(panel.locator('.affected-shot-list li')).toContainText(
      `${seeded.shotId}（4 张候选）`,
    );

    // STALE 展示：历史世代只读追溯、旧选择标注失效、失效候选仍可读图、无选择入口。
    await expect(panel.getByText('历史输入世代（输入已变化，仅供追溯）')).toBeVisible();
    await expect(panel.getByText('当前选择（已失效）')).toBeVisible();
    await expect(panel.getByText('当前输入世代')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '设为当前首帧' })).toHaveCount(0);
    await expect(panel.locator('.candidate-card.candidate-stale')).toHaveCount(4);
    await waitForDecodedImages(page);

    // 红线：API Key 或路径细节不进入 Renderer 页面。
    const html = await page.content();
    expect(html).not.toContain('e2e-mock-key-not-a-real-secret');
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('file://');
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
