import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { confirmGenerationPreparation, openProjectsList } from './support/app-navigation';

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(__dirname, '..');
const ffmpegDirectory = path.join(desktopRoot, 'resources', 'ffmpeg');

const sqliteGet = async <T>(databasePath: string, sql: string): Promise<T> => {
  const script =
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const row=db.prepare(process.argv[2]).get();db.close();process.stdout.write(JSON.stringify(row));";
  const { stdout } = await execFileAsync(process.execPath, ['-e', script, databasePath, sql]);
  return JSON.parse(stdout) as T;
};

const sqliteRun = async (databasePath: string, sql: string, parameter: string): Promise<void> => {
  const script =
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare(process.argv[2]).run(process.argv[3]);db.close();";
  await execFileAsync(process.execPath, ['-e', script, databasePath, sql, parameter]);
};

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (
  managedRoot: string,
  audioFile: string,
  exportDirectory: string,
  ffmpegPathOverride?: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<ElectronApplication> => {
  const packagedExecutable = process.env.JINGXU_E2E_EXECUTABLE;
  return electron.launch({
    args: packagedExecutable === undefined ? [desktopRoot] : [],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: exportDirectory,
      JINGXU_E2E_VIDEO_AUDIO_FILE: audioFile,
      JINGXU_E2E_VIDEO_STEPS: Array.from({ length: 12 }, () => 'A:P0').join(','),
      ...(packagedExecutable === undefined
        ? {
            JINGXU_FFMPEG_PATH: path.join(ffmpegDirectory, 'ffmpeg.exe'),
            JINGXU_FFPROBE_PATH: path.join(ffmpegDirectory, 'ffprobe.exe'),
          }
        : {}),
      ...(ffmpegPathOverride === undefined ? {} : { JINGXU_FFMPEG_PATH: ffmpegPathOverride }),
      ...extraEnvironment,
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
        requestId: `composition_image_${crypto.randomUUID()}`,
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
      if (selected === undefined) throw new Error('E2E_FIRST_FRAME_MISSING');
      const result = await window.jingxu.image.selectCandidate({
        candidateId: selected.id,
        projectId: pid,
        requestId: `composition_select_image_${crypto.randomUUID()}`,
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
        requestId: `composition_video_batch_${crypto.randomUUID()}`,
        shotIds: selectedShotIds,
      });
      if (!batch.ok) throw new Error(batch.error.code);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const state = await window.jingxu.video.listStoryboardVideoStates({ projectId: pid });
        if (!state.ok) throw new Error(state.error.code);
        if (state.data.batches[0]?.status === 'COMPLETED') break;
        if (state.data.batches[0]?.status === 'CANCELLED') {
          throw new Error(`E2E_VIDEO_BATCH_${state.data.batches[0].status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const shotId of selectedShotIds) {
        const candidates = await window.jingxu.video.listVideoCandidates({
          projectId: pid,
          shotId,
        });
        if (!candidates.ok) throw new Error(candidates.error.code);
        const candidate = candidates.data.find((item) => item.status === 'SUCCEEDED');
        if (candidate === undefined) throw new Error('E2E_VIDEO_CANDIDATE_MISSING');
        const selected = await window.jingxu.video.selectVideoCandidate({
          candidateId: candidate.id,
          projectId: pid,
          requestId: `composition_select_video_${crypto.randomUUID()}`,
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
        requestId: `composition_voice_batch_${crypto.randomUUID()}`,
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
            requestId: `composition_select_voice_${crypto.randomUUID()}`,
          });
          if (!result.ok) throw new Error(result.error.code);
          selected = true;
        }
        if (!selected) throw new Error(`COMPOSITION_VOICE_CANDIDATE_TIMEOUT:${shotId}`);
      }
    },
    { pid: projectId, selectedShotIds: [...shotIds] },
  );
};

const createTimelineForProject = async (page: Page, projectId: string) =>
  page.evaluate(async (pid) => {
    const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
    if (!workspace.ok || workspace.data.storyboard.current === null)
      throw new Error('WORKSPACE_NOT_READY');
    const created = await window.jingxu.video.createTimeline({
      episodeId: workspace.data.episode.id,
      expectedEpisodeVersionId: workspace.data.storyboard.current.id,
      projectId: pid,
      requestId: `composition_matrix_timeline_${crypto.randomUUID()}`,
    });
    if (!created.ok) throw new Error(created.error.code);
    return { episodeId: workspace.data.episode.id, timelineVersionId: created.data.id };
  }, projectId);

const startAndWaitForExport = async (
  page: Page,
  projectId: string,
  episodeId: string,
  timelineVersionId: string,
) =>
  page.evaluate(
    async ({ eid, pid, timelineId }) => {
      const started = await window.jingxu.video.startExport({
        episodeId: eid,
        projectId: pid,
        requestId: `composition_matrix_export_${crypto.randomUUID()}`,
        timelineVersionId: timelineId,
      });
      if (!started.ok) throw new Error(started.error.code);
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const current = await window.jingxu.video.getExportJob({
          exportJobId: started.data.id,
          projectId: pid,
        });
        if (!current.ok) throw new Error(current.error.code);
        if (['FAILED', 'CANCELLED', 'SUCCEEDED'].includes(current.data.status)) return current.data;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('E2E_EXPORT_TERMINAL_TIMEOUT');
    },
    { eid: episodeId, pid: projectId, timelineId: timelineVersionId },
  );

const compositionE2eName =
  process.env.JINGXU_E2E_EXECUTABLE === undefined
    ? 'E2E-V2-VIDEO-COMPOSE-SUCCESS—真实 FFmpeg 合成、Main 音乐导入、原子 MP4、哈希与受限预览'
    : 'E2E-V2-VIDEO-COMPOSE-PACKAGED—Windows 成品离线 Mock 合成与包内 FFmpeg/FFprobe 验证';

test('E2E-V2-VIDEO-TIMELINE-UI—三轨剪辑、撤销重做、保存与刷新恢复', async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-timeline-ui-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  const audioFile = path.join(root, 'background.wav');
  await mkdir(exportDirectory, { recursive: true });
  await execFileAsync(path.join(ffmpegDirectory, 'ffmpeg.exe'), [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '2',
    '-c:a',
    'pcm_s16le',
    audioFile,
  ]);

  const application = await launch(managedRoot, audioFile, exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '三轨剪辑界面闭环');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);

    await openProjectsList(page);
    await page.locator('.project-card-main', { hasText: '三轨剪辑界面闭环' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.locator('.creator-stage-progress').getByText('合成导出', { exact: true }).click();

    await page.getByRole('button', { name: '生成时间线', exact: true }).click();
    const editor = page.getByRole('region', { name: '可剪辑时间线' });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('group', { name: '画面轨' })).toBeVisible();
    await expect(editor.getByRole('group', { name: '对白轨' })).toBeVisible();
    await expect(editor.getByRole('group', { name: '配乐轨' })).toBeVisible();

    const videoClips = editor.getByRole('button', { name: /^画面片段 / });
    await expect(videoClips).toHaveCount(shotIds.length);
    const firstClipBox = await videoClips.first().boundingBox();
    const videoLaneBox = await editor
      .getByRole('group', { name: '画面轨' })
      .locator('.composition-track-lane')
      .boundingBox();
    if (firstClipBox === null || videoLaneBox === null)
      throw new Error('TIMELINE_DRAG_TARGET_MISSING');
    await videoClips.first().dispatchEvent('pointerdown', {
      clientX: firstClipBox.x + firstClipBox.width / 2,
      clientY: firstClipBox.y + firstClipBox.height / 2,
      pointerId: 1,
    });
    await page.evaluate(
      ({ x, y }) => {
        window.dispatchEvent(
          new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1 }),
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 1 }),
        );
      },
      {
        x: videoLaneBox.x + videoLaneBox.width * 0.2,
        y: firstClipBox.y + firstClipBox.height / 2,
      },
    );
    await videoClips.first().dispatchEvent('click');
    const startInput = editor.getByLabel('起点（毫秒）').first();
    await expect(startInput).not.toHaveValue('0');
    await startInput.fill('0');
    await editor.getByLabel('素材入点（毫秒）').first().fill('100');
    const outInput = editor.getByLabel('素材出点（毫秒）').first();
    await outInput.fill('900');
    const startMs = Number(await startInput.inputValue());
    const outMs = Number(await outInput.inputValue());
    const splitAtMs = startMs + Math.max(100, Math.floor(outMs / 200) * 100);
    await editor.getByLabel('播放头位置').fill(String(splitAtMs));
    await editor.getByRole('button', { name: '在播放头处分割' }).click();
    await expect(videoClips).toHaveCount(shotIds.length + 1);
    await expect(editor.getByText('有未保存修改')).toBeVisible();

    await editor.getByRole('button', { name: '撤销' }).click();
    await expect(videoClips).toHaveCount(shotIds.length);
    await editor.getByRole('button', { name: '重做' }).click();
    await expect(videoClips).toHaveCount(shotIds.length + 1);
    await videoClips.last().click();
    await editor.getByRole('button', { name: '复制到末尾' }).click();
    await expect(videoClips).toHaveCount(shotIds.length + 2);
    await videoClips.last().click();
    await editor.getByRole('button', { name: '删除片段' }).click();
    await expect(videoClips).toHaveCount(shotIds.length + 1);

    await page.getByRole('button', { name: '导入背景音乐', exact: true }).click();
    await expect(page.getByText(/已导入背景音乐/)).toBeVisible();
    await editor.getByLabel('配乐静音').check();
    await editor.getByLabel('对白轨静音').check();
    await editor.getByLabel('配乐音量').fill('0.35');
    await editor.getByLabel('淡入（毫秒）').fill('500');
    await editor.getByLabel('淡出（毫秒）').fill('700');

    await page.getByRole('button', { name: '保存时间线', exact: true }).click();
    await expect(page.getByText('时间线已保存为新版本。')).toBeVisible();
    await expect(page.getByText('第 2 版', { exact: true })).toBeVisible();
    await expect(editor.getByText('有未保存修改')).toHaveCount(0);

    await page.waitForTimeout(500);
    await page.reload();
    await openProjectsList(page);
    await page.locator('.project-card-main', { hasText: '三轨剪辑界面闭环' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.locator('.creator-stage-progress').getByText('合成导出', { exact: true }).click();

    const restoredEditor = page.getByRole('region', { name: '可剪辑时间线' });
    await expect(restoredEditor).toBeVisible();
    await expect(page.getByText('第 2 版', { exact: true })).toBeVisible();
    await expect(restoredEditor.getByLabel('配乐静音')).toBeChecked();
    await expect(restoredEditor.getByLabel('对白轨静音')).toBeChecked();
    await expect(restoredEditor.getByLabel('配乐音量')).toHaveValue('0.35');
    await expect(restoredEditor.getByLabel('淡入（毫秒）')).toHaveValue('500');
    await expect(restoredEditor.getByLabel('淡出（毫秒）')).toHaveValue('700');
    await expect(restoredEditor.getByRole('button', { name: /^画面片段 / })).toHaveCount(
      shotIds.length + 1,
    );
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1') {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test('E2E-V2-VIDEO-TIMELINE-UNSAVED—未保存三轨草稿禁止创建导出任务', async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-timeline-unsaved-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  const audioFile = path.join(root, 'background.wav');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(managedRoot, audioFile, exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '未保存导出阻断');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    await prepareSelectedVoiceCandidates(page, seeded.projectId, shotIds);

    await openProjectsList(page);
    await page.locator('.project-card-main', { hasText: '未保存导出阻断' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.locator('.creator-stage-progress').getByText('合成导出', { exact: true }).click();
    await page.getByRole('button', { name: '生成时间线', exact: true }).click();

    const editor = page.getByRole('region', { name: '可剪辑时间线' });
    await expect(editor).toBeVisible();
    await editor.getByLabel('配乐音量').fill('0.4');
    await expect(editor.getByText('有未保存修改')).toBeVisible();
    const databasePath = path.join(managedRoot, 'data', 'jingxu.sqlite');
    const before = await sqliteGet<{ count: number }>(
      databasePath,
      `SELECT count(*) AS count FROM video_export_jobs`,
    );

    await page.getByRole('button', { name: '生成成片', exact: true }).click();
    const preparation = page.getByRole('dialog', { name: '确认本次生成准备' });
    await expect(preparation.getByRole('button', { name: '确认并开始' })).toBeEnabled();
    await confirmGenerationPreparation(page);
    const unsavedDialog = page.getByRole('dialog', { name: '时间线有未保存修改' });
    await expect(unsavedDialog).toBeVisible();
    const after = await sqliteGet<{ count: number }>(
      databasePath,
      `SELECT count(*) AS count FROM video_export_jobs`,
    );
    expect(after.count).toBe(before.count);
    await unsavedDialog.getByRole('button', { name: '取消', exact: true }).click();
    await editor.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(editor.getByText('有未保存修改')).toHaveCount(0);
    await page.locator('.creator-stage-progress').getByText('视频生成', { exact: true }).click();
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1') {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test(compositionE2eName, async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-success-'));
  if (process.env.JINGXU_KEEP_E2E_ARTIFACTS === '1') console.info(`VIDEO_COMPOSE_E2E_ROOT=${root}`);
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  const audioFile = path.join(root, 'background.wav');
  await mkdir(exportDirectory, { recursive: true });
  await execFileAsync(path.join(ffmpegDirectory, 'ffmpeg.exe'), [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '2',
    '-c:a',
    'pcm_s16le',
    audioFile,
  ]);

  const application = await launch(managedRoot, audioFile, exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 真实视频合成');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);

    const result = await page.evaluate(
      async ({ projectId }) => {
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok || workspace.data.storyboard.current === null)
          throw new Error('WORKSPACE_NOT_READY');
        const episodeId = workspace.data.episode.id;
        const created = await window.jingxu.video.createTimeline({
          episodeId,
          expectedEpisodeVersionId: workspace.data.storyboard.current.id,
          projectId,
          requestId: `composition_timeline_${crypto.randomUUID()}`,
        });
        if (!created.ok) throw new Error(created.error.code);
        const audio = await window.jingxu.video.importBackgroundMusic({
          projectId,
          requestId: `composition_audio_${crypto.randomUUID()}`,
        });
        if (!audio.ok) throw new Error(audio.error.code);
        const reordered = [...created.data.items].reverse().map((item, position) => ({
          ...item,
          enabled: position < 2,
          position,
          trimInMs: 0,
          trimOutMs: position < 2 ? 500 : item.trimOutMs,
        }));
        const saved = await window.jingxu.video.updateTimeline({
          audioAssetId: audio.data.id,
          audioVolume: 0.2,
          episodeId,
          expectedVersionId: created.data.id,
          items: reordered,
          projectId,
          requestId: `composition_timeline_save_${crypto.randomUUID()}`,
          subtitleItems: [],
          voiceItems: [],
        });
        if (!saved.ok) throw new Error(saved.error.code);
        const started = await window.jingxu.video.startExport({
          episodeId,
          projectId,
          requestId: `composition_export_${crypto.randomUUID()}`,
          timelineVersionId: saved.data.id,
        });
        if (!started.ok) throw new Error(started.error.code);
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const current = await window.jingxu.video.getExportJob({
            exportJobId: started.data.id,
            projectId,
          });
          if (!current.ok) throw new Error(current.error.code);
          if (current.data.status === 'SUCCEEDED') return current.data;
          if (current.data.status === 'FAILED' || current.data.status === 'CANCELLED') {
            throw new Error(current.data.errorCode ?? current.data.status);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('E2E_EXPORT_TIMEOUT');
      },
      { projectId: seeded.projectId },
    );

    expect(result.mediaUrl).toMatch(/^jingxu:\/\/media\/video-export\//u);
    expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.byteSize).toBeGreaterThan(0);
    await page.reload();
    await page.waitForFunction(() => typeof window.jingxu.video.getTimeline === 'function');
    const recovered = await page.evaluate(async (projectId) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId });
      if (!workspace.ok) throw new Error(workspace.error.code);
      return window.jingxu.video.getTimeline({
        episodeId: workspace.data.episode.id,
        projectId,
        timelineVersionId: null,
      });
    }, seeded.projectId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.code);
    expect(recovered.data.id).toBe(result.timelineVersionId);
    expect(recovered.data.versionNo).toBe(2);
    const outputPath = path.join(exportDirectory, `jingxu-video-${result.id}.mp4`);
    const output = await readFile(outputPath);
    expect(createHash('sha256').update(output).digest('hex')).toBe(result.fileSha256);
    expect(output.byteLength).toBe(result.byteSize);
    const { stdout } = await execFileAsync(path.join(ffmpegDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height,avg_frame_rate',
      '-show_entries',
      'format=duration,format_name',
      '-of',
      'json',
      outputPath,
    ]);
    const probe = JSON.parse(stdout) as {
      format: { duration: string; format_name: string };
      streams: unknown[];
    };
    expect(probe.format.format_name).toContain('mp4');
    expect(Number(probe.format.duration)).toBeGreaterThan(0);
    expect(probe.streams).toHaveLength(2);
  } finally {
    await application.close();
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1') {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—FFmpeg 缺失时无假成功或部分 MP4', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-failure-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(
    managedRoot,
    path.join(root, 'unused.wav'),
    exportDirectory,
    path.join(root, 'missing-ffmpeg.exe'),
  );
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 视频合成失败');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    const failed = await page.evaluate(
      async ({ projectId }) => {
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok || workspace.data.storyboard.current === null)
          throw new Error('WORKSPACE_NOT_READY');
        const created = await window.jingxu.video.createTimeline({
          episodeId: workspace.data.episode.id,
          expectedEpisodeVersionId: workspace.data.storyboard.current.id,
          projectId,
          requestId: `composition_failure_timeline_${crypto.randomUUID()}`,
        });
        if (!created.ok) throw new Error(created.error.code);
        const invalidTimeline = await window.jingxu.video.updateTimeline({
          audioAssetId: null,
          audioVolume: 0.2,
          episodeId: workspace.data.episode.id,
          expectedVersionId: created.data.id,
          items: created.data.items.map((item) => ({ ...item, trimInMs: 500, trimOutMs: 500 })),
          projectId,
          requestId: `composition_failure_trim_${crypto.randomUUID()}`,
          subtitleItems: [],
          voiceItems: [],
        });
        if (invalidTimeline.ok || invalidTimeline.error.code !== 'VIDEO_TRIM_INVALID')
          throw new Error('E2E_INVALID_TRIM_NOT_BLOCKED');
        const started = await window.jingxu.video.startExport({
          episodeId: workspace.data.episode.id,
          projectId,
          requestId: `composition_failure_export_${crypto.randomUUID()}`,
          timelineVersionId: created.data.id,
        });
        if (!started.ok) throw new Error(started.error.code);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const current = await window.jingxu.video.getExportJob({
            exportJobId: started.data.id,
            projectId,
          });
          if (!current.ok) throw new Error(current.error.code);
          if (current.data.status === 'FAILED') return current.data;
          if (current.data.status === 'SUCCEEDED') throw new Error('UNEXPECTED_EXPORT_SUCCESS');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('E2E_FAILURE_EXPORT_TIMEOUT');
      },
      { projectId: seeded.projectId },
    );
    expect(failed.errorCode).toBe('FFMPEG_NOT_AVAILABLE');
    expect(failed.fileSha256).toBeNull();
    expect(failed.mediaUrl).toBeNull();
    expect(
      (await readFile(path.join(managedRoot, 'data', 'jingxu.sqlite'))).byteLength,
    ).toBeGreaterThan(0);
    const files = await readdir(exportDirectory);
    expect(files).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—不可解码背景音乐在 Main 边界拒绝且不留下资产', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-bad-audio-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  const audioFile = path.join(root, 'invalid.wav');
  await mkdir(exportDirectory, { recursive: true });
  await writeFile(audioFile, Uint8Array.from([0, 1, 2, 3]));
  const application = await launch(managedRoot, audioFile, exportDirectory);
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async () =>
      window.jingxu.video.importBackgroundMusic({
        projectId: 'project_00000001',
        requestId: `composition_bad_audio_${crypto.randomUUID()}`,
      }),
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_AUDIO_INVALID' }, ok: false });
    const audioRoot = path.join(managedRoot, 'projects', 'project_00000001', 'audio');
    await expect(readdir(audioRoot, { recursive: true })).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—STALE 与损坏候选整单失败且无部分 MP4', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-source-failure-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(managedRoot, path.join(root, 'unused.wav'), exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 视频源失败矩阵');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    const timeline = await createTimelineForProject(page, seeded.projectId);
    const databasePath = path.join(managedRoot, 'data', 'jingxu.sqlite');
    const selected = await sqliteGet<{ id: string; storage_rel_path: string }>(
      databasePath,
      'SELECT id, storage_rel_path FROM video_candidates WHERE selected_at IS NOT NULL ORDER BY id LIMIT 1',
    );
    await sqliteRun(
      databasePath,
      "UPDATE video_candidates SET status='STALE_INPUT' WHERE id=?",
      selected.id,
    );
    const stale = await startAndWaitForExport(
      page,
      seeded.projectId,
      timeline.episodeId,
      timeline.timelineVersionId,
    );
    expect(stale).toMatchObject({ errorCode: 'VIDEO_SOURCE_STALE', status: 'FAILED' });

    await sqliteRun(
      databasePath,
      "UPDATE video_candidates SET status='SUCCEEDED' WHERE id=?",
      selected.id,
    );
    await writeFile(
      path.join(managedRoot, ...selected.storage_rel_path.split('/')),
      Uint8Array.from([0, 1, 2, 3]),
    );
    const corrupted = await startAndWaitForExport(
      page,
      seeded.projectId,
      timeline.episodeId,
      timeline.timelineVersionId,
    );
    expect(corrupted).toMatchObject({ errorCode: 'VIDEO_SOURCE_CORRUPTED', status: 'FAILED' });
    expect(await readdir(exportDirectory)).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—FFmpeg 非零退出保留失败 Job 且无输出', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-nonzero-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(
    managedRoot,
    path.join(root, 'unused.wav'),
    exportDirectory,
    path.join(ffmpegDirectory, 'ffprobe.exe'),
  );
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 FFmpeg 非零');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    const timeline = await createTimelineForProject(page, seeded.projectId);
    const failed = await startAndWaitForExport(
      page,
      seeded.projectId,
      timeline.episodeId,
      timeline.timelineVersionId,
    );
    expect(failed).toMatchObject({ errorCode: 'FFMPEG_FAILED', status: 'FAILED' });
    expect(await readdir(exportDirectory)).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—取消与迟到执行不可覆盖 CANCELLED', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-cancel-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(
    managedRoot,
    path.join(root, 'unused.wav'),
    exportDirectory,
    undefined,
    { JINGXU_E2E_VIDEO_COMPOSE_DELAY_MS: '3000' },
  );
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 导出取消');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    const timeline = await createTimelineForProject(page, seeded.projectId);
    const cancelled = await page.evaluate(
      async ({ eid, pid, timelineId }) => {
        const started = await window.jingxu.video.startExport({
          episodeId: eid,
          projectId: pid,
          requestId: `cancel_${crypto.randomUUID()}`,
          timelineVersionId: timelineId,
        });
        if (!started.ok) throw new Error(started.error.code);
        const result = await window.jingxu.video.cancelExport({
          exportJobId: started.data.id,
          projectId: pid,
          requestId: `cancel_command_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(result.error.code);
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const late = await window.jingxu.video.getExportJob({
          exportJobId: started.data.id,
          projectId: pid,
        });
        if (!late.ok) throw new Error(late.error.code);
        return late.data;
      },
      { eid: timeline.episodeId, pid: seeded.projectId, timelineId: timeline.timelineVersionId },
    );
    expect(cancelled).toMatchObject({ errorCode: 'VIDEO_EXPORT_CANCELLED', status: 'CANCELLED' });
    expect(cancelled.fileSha256).toBeNull();
    expect(await readdir(exportDirectory)).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-V2-VIDEO-COMPOSE-FAILURE—崩溃重启把未完成 Job 标记未知结果且不重跑', async () => {
  test.skip(process.env.JINGXU_E2E_EXECUTABLE !== undefined, '失败矩阵只在开发 E2E 注入失败路径。');
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-video-compose-recovery-'));
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  let application = await launch(
    managedRoot,
    path.join(root, 'unused.wav'),
    exportDirectory,
    undefined,
    { JINGXU_E2E_VIDEO_COMPOSE_DELAY_MS: '10000' },
  );
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 导出崩溃恢复');
    const shotIds = await prepareSelectedFirstFrames(page, seeded.projectId);
    await prepareSelectedVideoCandidates(page, seeded.projectId, shotIds);
    const timeline = await createTimelineForProject(page, seeded.projectId);
    const exportJobId = await page.evaluate(
      async ({ eid, pid, timelineId }) => {
        const started = await window.jingxu.video.startExport({
          episodeId: eid,
          projectId: pid,
          requestId: `crash_${crypto.randomUUID()}`,
          timelineVersionId: timelineId,
        });
        if (!started.ok) throw new Error(started.error.code);
        return started.data.id;
      },
      { eid: timeline.episodeId, pid: seeded.projectId, timelineId: timeline.timelineVersionId },
    );
    await application.close();
    application = await launch(managedRoot, path.join(root, 'unused.wav'), exportDirectory);
    const recoveredPage = await application.firstWindow();
    await expect
      .poll(
        async () =>
          recoveredPage.evaluate(
            async ({ id, pid }) =>
              window.jingxu.video.getExportJob({ exportJobId: id, projectId: pid }),
            { id: exportJobId, pid: seeded.projectId },
          ),
        { timeout: 15_000 },
      )
      .toMatchObject({
        data: { errorCode: 'VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME', status: 'FAILED' },
        ok: true,
      });
    expect(await readdir(exportDirectory)).toEqual([]);
  } finally {
    await application.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});
