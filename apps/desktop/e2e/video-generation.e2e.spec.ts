import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
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

const desktopRoot = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (managedRoot: string, videoSteps = ''): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_VIDEO_STEPS: videoSteps,
    },
  });

const repeat = (token: string, count: number): string[] =>
  Array.from({ length: count }, () => token);

const openStoryboard = async (page: Page, name: string): Promise<void> => {
  await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: name }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

/** 直接经受限 image IPC 准备所有首帧；此辅助不接触路径、数据库或 Provider。 */
const prepareSelectedFirstFrames = async (
  page: Page,
  projectId: string,
  selectedCount: number,
): Promise<readonly string[]> =>
  page.evaluate(
    async ({ count, pid }) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
      if (!workspace.ok) throw new Error(workspace.error.code);
      const shotIds = workspace.data.storyboard.shots.map((shot) => shot.shotId);
      for (const shotId of shotIds.slice(0, count)) {
        const generated = await window.jingxu.image.generateCandidates({
          projectId: pid,
          requestId: `image_${crypto.randomUUID()}`,
          shotId,
        });
        if (!generated.ok) throw new Error(generated.error.code);
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const task = await window.jingxu.image.getMediaTask({
            projectId: pid,
            taskId: generated.data.id,
          });
          if (!task.ok) throw new Error(task.error.code);
          if (task.data.phase === 'COMPLETED') break;
          if (task.data.phase === 'FAILED' || task.data.phase === 'CANCELLED') {
            throw new Error(task.data.errorCode ?? task.data.phase);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const candidates = await window.jingxu.image.listCandidates({ projectId: pid, shotId });
        if (!candidates.ok) throw new Error(candidates.error.code);
        const first = candidates.data.find((candidate) => candidate.status === 'SUCCEEDED');
        if (first === undefined) throw new Error('NO_FIRST_FRAME');
        const selected = await window.jingxu.image.selectCandidate({
          candidateId: first.id,
          projectId: pid,
          requestId: `select_${crypto.randomUUID()}`,
        });
        if (!selected.ok) throw new Error(selected.error.code);
      }
      return shotIds;
    },
    { count: selectedCount, pid: projectId },
  );

test('§6.1-T1 单镜头视频—异步生成、受限 video 比较、选择与首帧改选 STALE（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-t1-'));
  if (process.env.JINGXU_KEEP_E2E_ARTIFACTS === '1') console.info(`VIDEO_E2E_ROOT=${root}`);
  const application = await launch(path.join(root, 'managed'), 'A:P0,A:P0');
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '视频单镜头');
    await prepareSelectedFirstFrames(page, seeded.projectId, 1);
    await page.reload();
    await openStoryboard(page, '视频单镜头');
    await page.locator('.shot-card', { hasText: '#1' }).click();

    const panel = page.locator('#video-panel');
    await expect(panel.getByRole('heading', { name: '视频候选 · 镜头 #1' })).toBeVisible();
    await expect(panel.getByAltText('已选首帧缩略图')).toBeVisible();
    await panel.getByRole('button', { name: '生成视频候选' }).click();
    await expect(panel.getByText('视频任务状态：COMPLETED')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('video')).toHaveCount(2);
    // Renderer CSP deliberately has connect-src 'none'. Media is loaded by the
    // video element under media-src jingxu:, while Range/206 belongs to the
    // Main-protocol test boundary rather than a renderer fetch().
    await expect(panel.locator('video').first()).toHaveAttribute('src', /^jingxu:\/\/media\//u);
    await panel.getByRole('button', { name: '设为当前视频段' }).first().click();
    await expect(panel.locator('.selection-badge')).toHaveText('当前视频段');

    // 改选另一首帧：旧视频候选必须 STALE，且不自动生成下一轮视频。
    const secondFirstFrame = await page.evaluate(
      async ({ projectId, shotId }) => {
        const list = await window.jingxu.image.listCandidates({ projectId, shotId });
        if (!list.ok) throw new Error(list.error.code);
        const next = list.data.find(
          (candidate) => candidate.selectedAt === null && candidate.status === 'SUCCEEDED',
        );
        if (next === undefined) throw new Error('NO_ALTERNATE_FIRST_FRAME');
        const selected = await window.jingxu.image.selectCandidate({
          candidateId: next.id,
          projectId,
          requestId: `reselect_${crypto.randomUUID()}`,
        });
        if (!selected.ok) throw new Error(selected.error.code);
        return next.id;
      },
      { projectId: seeded.projectId, shotId: seeded.shotId },
    );
    expect(secondFirstFrame).toBeTruthy();
    await page.reload();
    await openStoryboard(page, '视频单镜头');
    await page.locator('.shot-card', { hasText: '#1' }).click();
    await expect(page.locator('#video-panel')).toContainText(
      '历史视频输入世代（输入已变化，仅供追溯）',
    );
    await expect(page.locator('#video-panel')).toContainText('当前选择（已失效）');
    await expect(
      page.locator('#video-panel').getByRole('button', { name: '设为当前视频段' }),
    ).toHaveCount(0);

    // 新世代视频在镜头内容编辑后同样必须失效，且不得自动重发。
    await page.locator('#video-panel').getByRole('button', { name: '生成视频候选' }).click();
    await expect(page.locator('#video-panel').getByText('视频任务状态：COMPLETED')).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(
      async ({ projectId }) => {
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok) throw new Error(workspace.error.code);
        const storyboard = workspace.data.storyboard;
        const episode = workspace.data.episode;
        const shot = storyboard.shots.find((candidate) => candidate.sequence === 1);
        if (shot === undefined || storyboard.current === null) {
          throw new Error('STORYBOARD_EDIT_CONTEXT_MISSING');
        }
        const edited = await window.jingxu.storyboard.editShot({
          document: { ...shot.document, narrative_purpose: '视频失效验证：镜头叙事目的已编辑' },
          episodeId: episode.id,
          expectedVersionId: storyboard.current.id,
          projectId,
          requestId: `video_stale_edit_${crypto.randomUUID()}`,
          shotId: shot.shotId,
          shotVersionId: shot.versionId,
        });
        if (!edited.ok) throw new Error(edited.error.code);
      },
      { projectId: seeded.projectId },
    );
    await page.reload();
    await openStoryboard(page, '视频单镜头');
    await page.locator('.shot-card', { hasText: '#1' }).click();
    await expect(page.locator('#video-panel')).toContainText(
      '历史视频输入世代（输入已变化，仅供追溯）',
    );
    await expect(
      page.locator('#video-panel').getByRole('button', { name: '设为当前视频段' }),
    ).toHaveCount(0);
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1')
      await rm(root, { force: true, recursive: true });
  }
});

test('§6.2-T3 视频证据—node:sqlite 断言 SUBMIT/POLL/DOWNLOAD 三段与下载字节零入库', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-evidence-'));
  const managedRoot = path.join(root, 'managed');
  const application = await launch(managedRoot, 'A:P0,A:P0');
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '视频证据');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId, 1);
    const shotId = shotIds[0];
    if (shotId === undefined) throw new Error('NO_SEEDED_SHOT');
    await page.evaluate(
      async ({ projectId, targetShotId }) => {
        const generated = await window.jingxu.video.generateVideoCandidates({
          projectId,
          requestId: `video_evidence_${crypto.randomUUID()}`,
          shotId: targetShotId,
        });
        if (!generated.ok) throw new Error(generated.error.code);
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const task = await window.jingxu.video.getVideoTask({
            projectId,
            taskId: generated.data.id,
          });
          if (!task.ok) throw new Error(task.error.code);
          if (task.data.phase === 'COMPLETED') return;
          if (task.data.phase === 'FAILED' || task.data.phase === 'CANCELLED') {
            throw new Error(task.data.errorCode ?? task.data.phase);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('VIDEO_TASK_TIMEOUT');
      },
      { projectId: seeded.projectId, targetShotId: shotId },
    );
  } finally {
    await application.close();
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-video-evidence.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    expect(stdout).toContain('VIDEO_EVIDENCE_OK');
    expect(stdout).toContain('"submitRows":2');
    expect(stdout).toContain('"downloadRows":2');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('§6.1-T2 整集视频批量—跳过、失败隔离 PARTIAL 与失败镜头新批次重试（E2E Mock）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-t2-'));
  if (process.env.JINGXU_KEEP_E2E_ARTIFACTS === '1') console.info(`VIDEO_E2E_ROOT=${root}`);
  // 五个有首帧镜头：L1 成功，L2 两候选失败，L3-L5 成功，重试 L2 成功；L6 无首帧跳过。
  const steps = [
    ...repeat('A:P0', 2),
    ...repeat('E:MODEL_TIMEOUT', 2),
    ...repeat('A:P0', 6),
    ...repeat('A:P0', 2),
  ].join(',');
  const application = await launch(path.join(root, 'managed'), steps);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '视频批量');
    await prepareSelectedFirstFrames(page, seeded.projectId, 5);
    await page.reload();
    await openStoryboard(page, '视频批量');

    await page.getByRole('button', { name: '为整集生成视频' }).click();
    await expect(page.locator('#video-batch-progress')).toContainText('视频批次进行中', {
      timeout: 15_000,
    });
    await expect(page.locator('#video-batch-progress')).toContainText(
      '跳过 1（无首帧或当前世代已有视频）',
    );
    await expect(page.locator('#video-batch-progress')).toContainText(
      '视频批次部分完成 · 进度 5/5 · 失败 1',
      {
        timeout: 90_000,
      },
    );
    await expect(page.getByRole('button', { name: '重试失败视频镜头（新批次）' })).toBeVisible();
    await page.getByRole('button', { name: '重试失败视频镜头（新批次）' }).click();
    await expect(page.locator('#video-batch-progress')).toContainText('视频批次已完成 · 进度 1/1', {
      timeout: 45_000,
    });
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1')
      await rm(root, { force: true, recursive: true });
  }
});

test('§6.1-T2 视频批次取消—在飞镜头自然收口，未建档镜头不再消费（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-cancel-'));
  const application = await launch(
    path.join(root, 'managed'),
    [...repeat('A:P3', 2), ...repeat('A:P0', 10)].join(','),
  );
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '视频批次取消');
    await prepareSelectedFirstFrames(page, seeded.projectId, seeded.shotCount);
    await page.reload();
    await openStoryboard(page, '视频批次取消');

    await page.getByRole('button', { name: '为整集生成视频' }).click();
    await expect(page.locator('.shot-video-badge', { hasText: '视频生成中' })).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.getByRole('button', { name: '取消剩余视频镜头' }).click();
    await expect(page.locator('#video-batch-progress')).toContainText('视频批次已取消');
    await expect(page.getByRole('button', { name: '取消剩余视频镜头' })).toHaveCount(0);
    await expect(page.locator('.shot-video-badge', { hasText: '视频就绪 2 段' })).toHaveCount(1, {
      timeout: 45_000,
    });
    await expect(page.locator('.shot-video-badge', { hasText: '未生成视频' })).toHaveCount(
      seeded.shotCount - 1,
    );
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§6.1-T2 视频批次重启—在飞任务待人工且剩余镜头继续，零自动重发（E2E Mock）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-restart-'));
  const managedRoot = path.join(root, 'managed');
  const first = await launch(managedRoot, [...repeat('A:P0', 2), ...repeat('A:P8', 2)].join(','));
  try {
    const page = await first.firstWindow();
    const seeded = await seedStoryboardReady(page, '视频批次重启');
    await prepareSelectedFirstFrames(page, seeded.projectId, seeded.shotCount);
    await page.reload();
    await openStoryboard(page, '视频批次重启');
    await page.getByRole('button', { name: '为整集生成视频' }).click();
    await expect(
      page.locator('.shot-card', { hasText: '#2' }).locator('.shot-video-badge'),
    ).toContainText('视频生成中', { timeout: 20_000 });
  } finally {
    await first.close();
  }

  const second = await launch(managedRoot);
  try {
    const page = await second.firstWindow();
    await openStoryboard(page, '视频批次重启');
    await expect(page.locator('#video-batch-progress')).toContainText(
      '视频批次部分完成 · 进度 6/6 · 失败 1',
      { timeout: 90_000 },
    );
    await expect(
      page.locator('.shot-card', { hasText: '#2' }).locator('.shot-video-badge'),
    ).toContainText('视频失败');
    await expect(page.locator('.shot-video-badge', { hasText: '视频就绪 2 段' })).toHaveCount(5);
  } finally {
    await second.close();
    await rm(root, { force: true, recursive: true });
  }
});
