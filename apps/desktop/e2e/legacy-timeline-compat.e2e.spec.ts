import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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

import { openProjectsList } from './support/app-navigation';
import { seedStoryboardReady } from './support/storyboard-seeding';

// 旧项目/旧时间线兼容（Change 任务 9.3）：先由当前版本创建真实项目与时间线，
// 用 0027 逆操作把库降回 v26 形状，再让应用首启迁移 0027，验证读取、编辑、导出全链。
// 打包版通过 JINGXU_E2E_EXECUTABLE 复跑同一流程，同时验证包内素材与 FFmpeg 可用。

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(__dirname, '..');
const ffmpegDirectory = path.join(desktopRoot, 'resources', 'ffmpeg');
const downgraderScript = path.join(__dirname, 'support', 'downgrade-timeline-to-v26.mjs');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (
  managedRoot: string,
  exportDirectory: string,
): Promise<ElectronApplication> => {
  const packagedExecutable = process.env.JINGXU_E2E_EXECUTABLE;
  return electron.launch({
    args: packagedExecutable === undefined ? [desktopRoot] : [],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: exportDirectory,
      JINGXU_E2E_VIDEO_STEPS: Array.from({ length: 12 }, () => 'A:P0').join(','),
      ...(packagedExecutable === undefined
        ? {
            JINGXU_FFMPEG_PATH: path.join(ffmpegDirectory, 'ffmpeg.exe'),
            JINGXU_FFPROBE_PATH: path.join(ffmpegDirectory, 'ffprobe.exe'),
          }
        : {}),
    },
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
  });
};

const prepareSelectedFirstFrames = async (
  page: Page,
  projectId: string,
): Promise<readonly string[]> =>
  page.evaluate(async (pid) => {
    const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
    if (!workspace.ok) throw new Error(workspace.error.code);
    const shotIds = workspace.data.storyboard.shots.map((shot) => shot.shotId);
    for (const shotId of shotIds) {
      const generated = await window.jingxu.image.generateCandidates({
        projectId: pid,
        requestId: `legacy_image_${crypto.randomUUID()}`,
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
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const candidates = await window.jingxu.image.listCandidates({ projectId: pid, shotId });
      if (!candidates.ok) throw new Error(candidates.error.code);
      const selected = candidates.data.find((candidate) => candidate.status === 'SUCCEEDED');
      if (selected === undefined) throw new Error('LEGACY_FIRST_FRAME_MISSING');
      const result = await window.jingxu.image.selectCandidate({
        candidateId: selected.id,
        projectId: pid,
        requestId: `legacy_select_image_${crypto.randomUUID()}`,
      });
      if (!result.ok) throw new Error(result.error.code);
    }
    return shotIds;
  }, projectId);

const prepareSelectedVideoCandidates = async (
  page: Page,
  projectId: string,
  shotIds: readonly string[],
): Promise<void> => {
  await page.evaluate(
    async ({ pid, selectedShotIds }) => {
      const batch = await window.jingxu.video.generateVideosForShots({
        projectId: pid,
        requestId: `legacy_video_batch_${crypto.randomUUID()}`,
        shotIds: selectedShotIds,
      });
      if (!batch.ok) throw new Error(batch.error.code);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const state = await window.jingxu.video.listStoryboardVideoStates({ projectId: pid });
        if (!state.ok) throw new Error(state.error.code);
        if (state.data.batches[0]?.status === 'COMPLETED') break;
        if (state.data.batches[0]?.status === 'CANCELLED') {
          throw new Error(`LEGACY_VIDEO_BATCH_${state.data.batches[0].status}`);
        }
        if (attempt === 239) throw new Error('LEGACY_VIDEO_BATCH_TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const shotId of selectedShotIds) {
        const candidates = await window.jingxu.video.listVideoCandidates({
          projectId: pid,
          shotId,
        });
        if (!candidates.ok) throw new Error(candidates.error.code);
        const candidate = candidates.data.find((item) => item.status === 'SUCCEEDED');
        if (candidate === undefined) throw new Error('LEGACY_VIDEO_CANDIDATE_MISSING');
        const selected = await window.jingxu.video.selectVideoCandidate({
          candidateId: candidate.id,
          projectId: pid,
          requestId: `legacy_select_video_${crypto.randomUUID()}`,
        });
        if (!selected.ok) throw new Error(selected.error.code);
      }
    },
    { pid: projectId, selectedShotIds: [...shotIds] },
  );
};

const prepareSelectedVoiceCandidates = async (
  page: Page,
  projectId: string,
  shotIds: readonly string[],
): Promise<void> => {
  await page.evaluate(
    async ({ pid, selectedShotIds }) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
      if (!workspace.ok) throw new Error(workspace.error.code);
      const batch = await window.jingxu.voice.generateForEpisode({
        episodeId: workspace.data.episode.id,
        projectId: pid,
        requestId: `legacy_voice_batch_${crypto.randomUUID()}`,
        shotIds: selectedShotIds,
      });
      if (!batch.ok) throw new Error(batch.error.code);
      for (const shotId of batch.data.targetShotIds) {
        let selected = false;
        for (let attempt = 0; attempt < 120 && !selected; attempt += 1) {
          const generations = await window.jingxu.voice.getGenerations({
            projectId: pid,
            shotId,
          });
          if (!generations.ok) throw new Error(generations.error.code);
          const candidate = generations.data.find((item) => item.status === 'SUCCEEDED');
          if (candidate === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          const result = await window.jingxu.voice.selectCandidate({
            candidateId: candidate.id,
            projectId: pid,
            requestId: `legacy_select_voice_${crypto.randomUUID()}`,
          });
          if (!result.ok) throw new Error(result.error.code);
          selected = true;
        }
        if (!selected) throw new Error(`LEGACY_VOICE_CANDIDATE_TIMEOUT:${shotId}`);
      }
    },
    { pid: projectId, selectedShotIds: [...shotIds] },
  );
};

const openCompositionStep = async (page: Page, projectName: string): Promise<void> => {
  await openProjectsList(page);
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await page.locator('.creator-stage-progress').getByText('合成导出', { exact: true }).click();
};

test('旧版时间线兼容—v26 库迁移 0027 后可读取、编辑并导出真实成片', async () => {
  test.setTimeout(600_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-legacy-compat-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  const databasePath = path.join(managedRoot, 'data', 'jingxu.sqlite');
  const projectName = '旧版时间线兼容项目';
  await mkdir(exportDirectory, { recursive: true });

  // —— 阶段 A：当前版本创建真实项目（剧本 READY、首帧/视频/配音已选、时间线 v1）。
  let shotCount = 0;
  let projectId = '';
  let application = await launch(managedRoot, exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, projectName);
    projectId = seeded.projectId;
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    await prepareSelectedVoiceCandidates(page, seeded.projectId, shotIds);
    await openCompositionStep(page, projectName);
    await page.getByRole('button', { name: '生成时间线', exact: true }).click();
    const editor = page.getByRole('region', { name: '可剪辑时间线' });
    await expect(editor.getByRole('group', { name: '画面轨' })).toBeVisible();
    await expect(editor.getByRole('button', { name: /^画面片段 / })).toHaveCount(shotIds.length);
    shotCount = shotIds.length;
  } finally {
    await application.close();
  }
  expect(shotCount).toBeGreaterThan(0);

  // —— 阶段 B：0027 逆操作降回 v26 旧库（删新增列/回执与迁移账本第 27 行）。
  const downgrade = JSON.parse(
    (await execFileAsync(process.execPath, [downgraderScript, databasePath])).stdout,
  ) as {
    counts: { items: number; receipts: number; versions: number; voiceItems: number };
    droppedReceipts: number;
    headAfter: number;
  };
  expect(downgrade.headAfter).toBe(26);
  // createTimeline 不写 UPDATE_VIDEO_TIMELINE 回执（仅 updateTimeline 写），droppedReceipts=0 是忠实形态。
  expect(downgrade.counts.items).toBe(shotCount);
  expect(downgrade.counts.voiceItems).toBeGreaterThanOrEqual(1);

  // —— 阶段 C：应用首启迁移 0027 → 旧项目可读取、可编辑、可导出。
  application = await launch(managedRoot, exportDirectory);
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole('heading', { name: '把一个想法，变成一部好故事', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => window.jingxu.runtime.getStartupStatus()), {
        timeout: 30_000,
      })
      .toMatchObject({ state: 'READY', writeEnabled: true });

    await openCompositionStep(page, projectName);
    const editor = page.getByRole('region', { name: '可剪辑时间线' });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('group', { name: '画面轨' })).toBeVisible();
    await expect(editor.getByRole('group', { name: '对白轨' })).toBeVisible();
    await expect(editor.getByRole('group', { name: '配乐轨' })).toBeVisible();
    await expect(editor.getByRole('button', { name: /^画面片段 / })).toHaveCount(shotCount);

    // 在迁移回填的数据上编辑并保存为新版本（ exercising voice_track_muted/bgm 写路径）。
    await editor.getByLabel('配乐音量').fill('0.5');
    await expect(editor.getByText('有未保存修改')).toBeVisible();
    await page.getByRole('button', { name: '保存时间线', exact: true }).click();
    await expect(page.getByText('时间线已保存为新版本。')).toBeVisible();
    await expect(page.getByText('第 2 版', { exact: true })).toBeVisible();

    // 导出迁移后的当前版本 → 真实本地 FFmpeg 成片。
    const exportJob = await page.evaluate(async (pid) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
      if (!workspace.ok) throw new Error(workspace.error.code);
      const episodeId = workspace.data.episode.id;
      const timeline = await window.jingxu.video.getTimeline({
        episodeId,
        projectId: pid,
        timelineVersionId: null,
      });
      if (!timeline.ok) throw new Error(timeline.error.code);
      const started = await window.jingxu.video.startExport({
        episodeId,
        projectId: pid,
        requestId: `legacy_export_${crypto.randomUUID()}`,
        timelineVersionId: timeline.data.id,
      });
      if (!started.ok) throw new Error(started.error.code);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const job = await window.jingxu.video.getExportJob({
          exportJobId: started.data.id,
          projectId: pid,
        });
        if (!job.ok) throw new Error(job.error.code);
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.data.status)) {
          return { status: job.data.status, errorCode: job.data.errorCode ?? null };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('LEGACY_EXPORT_TIMEOUT');
    }, projectId);
    expect(exportJob).toMatchObject({ status: 'SUCCEEDED', errorCode: null });

    const exportFiles = (await readdir(exportDirectory)).filter((name) => name.endsWith('.mp4'));
    expect(exportFiles.length).toBeGreaterThanOrEqual(1);
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1') {
      await rm(root, { force: true, recursive: true });
    }
  }
});
