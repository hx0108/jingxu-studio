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

/** 重载后从项目列表走真实入口进分镜工作台（复用 first-frame E2E 驱动路径）。 */
const openStoryboard = async (page: Page, projectName: string): Promise<void> => {
  await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

const shotBadge = (page: Page, sequence: number) =>
  page
    .locator('.shot-card', { hasText: `#${String(sequence)}` })
    .locator('.shot-first-frame-badge');

test('§6.2-T1 整集批量首帧—排队/生成中徽标流转至 COMPLETED，全镜头就绪（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-batch-t1-'));
  // 24 × S:600：6 镜头 × 4 候选，全慢步骤拉开在飞窗口供中态断言。
  const application = await launch(path.join(root, 'managed'), repeat('S:600', 24).join(','));
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '批次全量');
    expect(seeded.shotCount).toBe(6);
    await page.reload();
    await openStoryboard(page, '批次全量');

    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    // 中态：进度行进入「进行中」，取消入口可见，未轮到的镜头呈排队徽标。
    await expect(page.locator('#batch-progress')).toContainText('首帧批次进行中', {
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: '取消剩余镜头' })).toBeVisible();
    await expect(
      page.locator('.shot-first-frame-badge', { hasText: '首帧排队中' }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    // 终态：COMPLETED 6/6，无失败；六个镜头全部「就绪 4 张」。
    await expect(page.locator('#batch-progress')).toContainText('首帧批次已完成 · 进度 6/6', {
      timeout: 90_000,
    });
    await expect(page.locator('#batch-progress')).not.toContainText('失败');
    await expect(page.locator('.shot-first-frame-badge', { hasText: '首帧就绪 4 张' })).toHaveCount(
      6,
    );
    await expect(page.getByRole('button', { name: '取消剩余镜头' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试失败镜头（新批次）' })).toHaveCount(0);

    // 红线：Key 与路径细节不进入 Renderer。
    const html = await page.content();
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('file://');
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§6.2-T2 失败注入—候选级全败派生 PARTIAL，重试失败镜头走新批次（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-batch-t2-'));
  // 镜头1 成功；镜头2 四候选全 E:MODEL_TIMEOUT（任务 COMPLETED、同轮零成功）；镜头3-6 成功；
  // 末尾 4×S 供重试新批次消费。
  const steps = [...repeat('S', 4), ...repeat('E:MODEL_TIMEOUT', 4), ...repeat('S', 20)].join(',');
  const application = await launch(path.join(root, 'managed'), steps);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '批次失败重试');
    expect(seeded.shotCount).toBe(6);
    await page.reload();
    await openStoryboard(page, '批次失败重试');

    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    // 终态：失败隔离后收尾 PARTIAL，失败清单恰为镜头2（候选级失败按 FAILED 呈报）。
    await expect(page.locator('#batch-progress')).toContainText(
      '首帧批次部分完成 · 进度 6/6 · 失败 1',
      { timeout: 60_000 },
    );
    await expect(shotBadge(page, 2)).toContainText('首帧失败');
    await expect(page.locator('.shot-first-frame-badge', { hasText: '首帧就绪 4 张' })).toHaveCount(
      5,
    );
    await expect(page.getByRole('button', { name: '取消剩余镜头' })).toHaveCount(0);

    // 重试失败镜头 = 仅含失败镜头的新批次；成功后镜头2 转就绪。
    await page.getByRole('button', { name: '重试失败镜头（新批次）' }).click();
    await expect(page.locator('#batch-progress')).toContainText('首帧批次已完成 · 进度 1/1', {
      timeout: 60_000,
    });
    await expect(shotBadge(page, 2)).toContainText('首帧就绪 4 张');
    await expect(page.locator('.shot-first-frame-badge', { hasText: '首帧就绪 4 张' })).toHaveCount(
      6,
    );
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§6.2-T3 取消剩余—批次 CANCELLED，在飞成员跑完，未建档镜头不再消费（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-batch-t3-'));
  // 镜头1 四候选各 2.5s（约 10s 在飞窗口）；后续步骤仅供意外兜底。
  const steps = [...repeat('S:2500', 4), ...repeat('S', 8)].join(',');
  const application = await launch(path.join(root, 'managed'), steps);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '批次取消');
    expect(seeded.shotCount).toBe(6);
    await page.reload();
    await openStoryboard(page, '批次取消');

    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    await expect(shotBadge(page, 1)).toContainText('首帧生成中', { timeout: 15_000 });

    // 取消剩余：批次 CANCELLED，队列不再消费；在飞任务不被中断。
    await page.getByRole('button', { name: '取消剩余镜头' }).click();
    await expect(page.locator('#batch-progress')).toContainText('首帧批次已取消', {
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: '取消剩余镜头' })).toHaveCount(0);
    // 在飞成员自然终态：镜头1 就绪；未建档的 2-6 保持「未生成首帧」。
    await expect(shotBadge(page, 1)).toContainText('首帧就绪 4 张', { timeout: 40_000 });
    await expect(page.locator('#batch-progress')).toContainText('进度 1/6');
    await expect(page.locator('.shot-first-frame-badge', { hasText: '未生成首帧' })).toHaveCount(5);
    await expect(page.getByRole('button', { name: '重试失败镜头（新批次）' })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§6.2-T4 重启恢复—在飞任务标 INTERRUPTED 待人工，剩余队列继续至 PARTIAL（E2E Mock）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-batch-t4-'));
  const managedRoot = path.join(root, 'managed');
  // 首轮：镜头1 即刻成功；镜头2 四候选各 15s（约 60s 在飞窗口）供中途退出——
  // 窗口须盖过徽标轮询与关闭延迟，防止首个候选已落成导致徽标翻「就绪」。
  const firstRunSteps = [...repeat('S', 4), ...repeat('S:15000', 4), ...repeat('S', 16)].join(',');

  const first = await launch(managedRoot, firstRunSteps);
  try {
    const page = await first.firstWindow();
    const seeded = await seedStoryboardReady(page, '批次重启');
    expect(seeded.shotCount).toBe(6);
    await page.reload();
    await openStoryboard(page, '批次重启');
    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    // 等到镜头2 在飞（无 provider 证据的 SUBMITTED）后硬退出。
    await expect(shotBadge(page, 2)).toContainText('首帧生成中', { timeout: 20_000 });
  } finally {
    await first.close();
  }

  // 重启（同数据根；步骤回落全 SYNC 预算）：在飞任务被标 MEDIA_TASK_INTERRUPTED
  // 待人工（不重发），批次恢复继续消费镜头 3-6，最终 PARTIAL 6/6 失败 1。
  const second = await launch(managedRoot);
  try {
    const page = await second.firstWindow();
    await openStoryboard(page, '批次重启');
    await expect(page.locator('#batch-progress')).toContainText(
      '首帧批次部分完成 · 进度 6/6 · 失败 1',
      { timeout: 90_000 },
    );
    await expect(shotBadge(page, 2)).toContainText('首帧失败');
    await expect(page.locator('.shot-first-frame-badge', { hasText: '首帧就绪 4 张' })).toHaveCount(
      5,
    );
    await expect(page.getByRole('button', { name: '重试失败镜头（新批次）' })).toBeVisible();
    // 不重发红线：被打断的镜头2 四候选停留 PENDING（尚未出图、零终态推进），
    // 恢复未重发也未补提交——任务级 FAILED（INTERRUPTED）+ 候选原地不动。
    await page.locator('.shot-card', { hasText: '#2' }).click();
    await expect(page.getByRole('heading', { name: '首帧候选 · 镜头 #2' })).toBeVisible();
    await expect(page.locator('#first-frame-panel .candidate-card')).toHaveCount(4);
    await expect(page.locator('#first-frame-panel .candidate-placeholder')).toHaveCount(4);
  } finally {
    await second.close();
    await rm(root, { force: true, recursive: true });
  }
});
