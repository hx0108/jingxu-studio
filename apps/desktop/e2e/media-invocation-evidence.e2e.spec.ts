import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { seedStoryboardReady } from './support/storyboard-seeding';

const execFileAsync = promisify(execFile);

const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

/** 图片 Mock 步骤经 JINGXU_E2E_IMAGE_STEPS 注入（组合根 useE2eMock 专用解析）。 */
const launch = async (managedRoot: string, imageSteps?: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      ...(imageSteps === undefined ? {} : { JINGXU_E2E_IMAGE_STEPS: imageSteps }),
    },
  });

const repeat = (token: string, count: number): string[] =>
  Array.from({ length: count }, () => token);

/** 重载后从项目列表走真实入口进分镜工作台（复用 batch-first-frame E2E 驱动路径）。 */
const openStoryboard = async (page: Page, projectName: string): Promise<void> => {
  await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

test('§6.2-T5 调用证据—批跑后 SUBMIT 行数=候选数、ref 可 JOIN、失败原文落 blob（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-media-evidence-'));
  const managedRoot = path.join(root, 'managed');
  // 镜头1 成功；镜头2 四候选全 E:MODEL_RATE_LIMITED（错误原文入 blob）；镜头3-6 成功。
  const steps = [...repeat('S', 4), ...repeat('E:MODEL_RATE_LIMITED', 4), ...repeat('S', 16)].join(
    ',',
  );
  const application = await launch(managedRoot, steps);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '证据留档');
    expect(seeded.shotCount).toBe(6);
    await page.reload();
    await openStoryboard(page, '证据留档');

    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    await expect(page.locator('#batch-progress')).toContainText(
      '首帧批次部分完成 · 进度 6/6 · 失败 1',
      { timeout: 60_000 },
    );
  } finally {
    await application.close();
  }
  try {
    // 关进程释放库句柄后以纯 node 只读断言证据行（Playwright loader 不支持 node:sqlite）。
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-media-evidence.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    console.log(stdout.trim());
    // 24 候选（20 成功 + 4 失败）：SUBMIT 24 / DOWNLOAD 20 / 失败 SUBMIT 4。
    expect(stdout).toContain('MEDIA_EVIDENCE_OK');
    expect(stdout).toContain('"candidates":24');
    expect(stdout).toContain('"submitRows":24');
    expect(stdout).toContain('"downloadRows":20');
    expect(stdout).toContain('"failedSubmits":4');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
