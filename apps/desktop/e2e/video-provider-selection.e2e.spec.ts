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

const launch = async (
  managedRoot: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      ...extraEnv,
    },
  });

const openStoryboard = async (page: Page, name: string) => {
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: name }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await page.locator('.creator-stage-progress').getByText('分镜设计', { exact: true }).click();
  await expect(page.locator('.media-page-title')).toHaveText('分镜设计');
};

/** 经受限 image IPC 准备并选中首帧（Mock；不接触路径/数据库/Provider 原文）。 */
const prepareSelectedFirstFrames = async (
  page: Page,
  projectId: string,
  selectedCount: number,
): Promise<void> => {
  await page.evaluate(
    async ({ count, pid }) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
      if (!workspace.ok) throw new Error(workspace.error.code);
      const shotIds = workspace.data.storyboard.shots.map((shot) => shot.shotId);
      for (const shotId of shotIds.slice(0, count)) {
        const created = await window.jingxu.image.generateCandidates({
          projectId: pid,
          requestId: `e2e-vpsel-img-${shotId}`,
          shotId,
        });
        if (!created.ok) throw new Error(created.error.code);
        // Mock 图片为快速路径，但仍轮询到 SUCCEEDED（避免与启动期调度竞态）。
        let done: { id: string } | undefined;
        for (let attempt = 0; attempt < 100 && done === undefined; attempt += 1) {
          const list = await window.jingxu.image.listCandidates({ projectId: pid, shotId });
          if (!list.ok) throw new Error(list.error.code);
          done = list.data.find((candidate) => candidate.status === 'SUCCEEDED');
          if (done === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (done === undefined) throw new Error('FIRST_FRAME_NOT_READY');
        const selected = await window.jingxu.image.selectCandidate({
          candidateId: done.id,
          projectId: pid,
          requestId: `e2e-vpsel-sel-${shotId}`,
        });
        if (!selected.ok) throw new Error(selected.error.code);
      }
    },
    { count: selectedCount, pid: projectId },
  );
};

test.describe('AGNES 视频 Provider 固定路由', () => {
  test('设置页只展示 AGNES 视频服务—无 Seedance 切换入口—Mock 任务保持明确标识', async () => {
    test.setTimeout(420_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-vpsel-t1-'));
    const managedRoot = path.join(root, 'managed');
    const application = await launch(managedRoot);
    try {
      const page = await application.firstWindow();
      const seeded = await seedStoryboardReady(page, '视频偏好切换');
      await prepareSelectedFirstFrames(page, seeded.projectId, 1);
      await page.reload();
      await openProjectsList(page);
      await openStoryboard(page, '视频偏好切换');

      // 设置页：不暴露联调标记，只保留 AGNES 视频卡。
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('menuitem', { name: '设置', exact: true }).click();
      await expect(page.getByText('联调模拟（Mock）')).toHaveCount(0);
      await page.getByRole('button', { name: '管理', exact: true }).nth(2).click();
      const agnesCard = page.locator('details.model-service-card', {
        has: page.locator('#video-provider-title-agnes'),
      });
      await expect(agnesCard).toHaveCount(1);
      await expect(page.getByText('火山方舟视频服务', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '设为当前视频档' })).toHaveCount(0);
      await agnesCard.locator('summary').click();
      await expect(agnesCard).toContainText('阿格尼斯视频 2.5 极速版');
      await expect(agnesCard.locator('.model-current-provider-badge')).toHaveText('固定视频服务');

      // 回到工作台：Mock 链不受偏好影响——候选成功并带 6.4 模拟标识（零网络）。
      // 设置页不保留剧本区上下文，经项目列表重进剧本工作区。
      await page.getByRole('button', { name: '我的作品' }).click();
      await openStoryboard(page, '视频偏好切换');
      await page.locator('.creator-stage-progress').getByText('视频生成', { exact: true }).click();
      await page.locator('.shot-card', { hasText: '#1' }).click();
      const panel = page.locator('#video-panel');
      await panel.getByRole('button', { name: '生成视频候选' }).click();
      await expect(panel.getByText('视频任务状态：已完成')).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText('模拟生成 · 不计费').first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(panel.getByText('来源 阿格尼斯视频服务（模拟）').first()).toBeVisible({
        timeout: 20_000,
      });

      // 重启（同一受管根）：API 缺省固定 AGNES，Mock 生成继续零网络成功。
      await application.close();
      const relaunched = await launch(managedRoot);
      try {
        const nextPage = await relaunched.firstWindow();
        await openProjectsList(nextPage);
        const selection = await nextPage.evaluate(async () => {
          const result = await window.jingxu.provider.getVideoProviderSelection({
            requestId: 'e2e-vpsel-restart-get',
          });
          if (!result.ok) throw new Error(result.error.code);
          return result.data;
        });
        expect(selection).toMatchObject({
          mode: 'AGNES',
          providerProfileId: 'profile-video-agnes-primary',
        });
        await openStoryboard(nextPage, '视频偏好切换');
        await nextPage
          .locator('.creator-stage-progress')
          .getByText('视频生成', { exact: true })
          .click();
        await nextPage.locator('.shot-card', { hasText: '#1' }).click();
        const nextPanel = nextPage.locator('#video-panel');
        // 重启后新发起一轮 Mock 生成（偏好已 AGNES，但 Mock 链不受影响、零串线）。
        await nextPanel.getByRole('button', { name: '生成视频候选' }).click();
        await expect(nextPanel.getByText('视频任务状态：已完成')).toBeVisible({
          timeout: 60_000,
        });
        await expect(nextPanel.getByText('模拟生成 · 不计费').first()).toBeVisible();
      } finally {
        await relaunched.close();
      }
    } finally {
      await application.close().catch(() => undefined);
      await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
    }
  });

  test('正式真实档缺凭据—生成稳定失败 MODEL_CREDENTIAL_INVALID—不产生任何模拟成功候选（零网络回退）', async () => {
    test.setTimeout(180_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-vpsel-t2-'));
    // 仅视频特性关闭 Mock（main.ts E2E 逃生门）；图片/文本仍 Mock，全程零外网。
    const application = await launch(path.join(root, 'managed'), {
      JINGXU_E2E_VIDEO_REAL: '1',
      JINGXU_VIDEO_PROVIDER: 'AGNES',
      JINGXU_VIDEO_REAL_PROVIDER: '1',
    });
    try {
      const page = await application.firstWindow();
      const seeded = await seedStoryboardReady(page, '视频真实档缺凭据');
      await prepareSelectedFirstFrames(page, seeded.projectId, 1);
      await page.reload();
      await openProjectsList(page);
      await openStoryboard(page, '视频真实档缺凭据');
      await page.locator('.creator-stage-progress').getByText('视频生成', { exact: true }).click();
      await page.locator('.shot-card', { hasText: '#1' }).click();
      const panel = page.locator('#video-panel');
      await panel.getByRole('button', { name: '生成视频候选' }).click();

      // 稳定失败：指向视频配置入口的凭据错误（MODEL_CREDENTIAL_INVALID 的用户面
      // 文案）；绝不回退 Mock。
      await expect(panel.locator('.field-error')).toContainText('服务密钥校验未通过', {
        timeout: 30_000,
      });
      await expect(panel.locator('.field-error')).toContainText(
        '设置页的视频生成卡片中保存服务密钥',
      );
      // 不生成任何模拟成功候选：无视频元素、无候选卡成功态。
      await expect(panel.locator('video')).toHaveCount(0);
      await expect(panel.locator('.candidate-card')).toHaveCount(0);
      await expect(panel.getByText('模拟生成 · 不计费')).toHaveCount(0);
    } finally {
      await application.close();
      await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
    }
  });
});
