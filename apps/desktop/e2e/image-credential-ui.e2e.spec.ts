import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

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

test('§3.2 图片凭据 UI 闭环—保存→解密测试→删除：密文固定 id 落盘/清理，页面无 Key 泄漏（E2E Mock）', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-image-cred-'));
  const managed = path.join(root, 'managed');
  const application = await launch(managed);
  try {
    const page = await application.firstWindow();

    // 播种已初始化的剧本工作区，使 ProviderSettings（含图片卡片）可达。
    await seedStoryboardReady(page, '图片凭据闭环');
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await page.locator('.project-card-main', { hasText: '图片凭据闭环' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();

    const card = page.locator('details.model-service-card', {
      has: page.locator('#image-provider-title'),
    });
    await expect(card.getByRole('heading', { name: '火山方舟 ARK' })).toBeVisible();
    await card.locator('summary').click();
    // 惰性默认档：模型只读展示、未配置、验证范围如实文案。
    await expect(card.locator('input[readonly]')).toHaveValue('doubao-seedream-5-0-lite-260128');
    await expect(card.locator('.model-configuration-status')).toHaveText('未配置');
    await expect(card.getByText('测试仅验证密文可解密读取，不发起计费请求')).toBeVisible();

    // 保存：密文按固定 id 真实落盘，输入即清空，状态行只露末 4 位。
    const key = 'e2e-image-key-abcd9999';
    await card.getByLabel('ARK API Key').fill(key);
    await card.getByRole('button', { name: '保存凭据' }).click();
    await expect(card.getByText('已配置（末四位 9999）')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByLabel('ARK API Key')).toHaveValue('');
    const secretPath = path.join(managed, 'secrets', 'profile-image-primary.bin');
    const ciphertext = await readFile(secretPath);
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(ciphertext.includes(Buffer.from(key))).toBe(false);

    // 解密测试（D2：零网络）：成功反馈即密文可解。
    await card.getByRole('button', { name: '测试凭据' }).click();
    await expect(card.getByText(/· 密文可解密读取/)).toBeVisible({ timeout: 15_000 });

    // 删除：确认后行清理，密文文件清除。
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await card.getByRole('button', { name: '删除凭据' }).click();
    await expect(card.getByText('凭据已删除')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText(/已配置/)).toHaveCount(0);
    await expect
      .poll(async () =>
        (await readdir(path.dirname(secretPath))).includes('profile-image-primary.bin'),
      )
      .toBe(false);

    // 红线：完整 Key 不进入页面 DOM。
    const html = await page.content();
    expect(html).not.toContain(key);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
