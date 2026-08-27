import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const ffmpegDirectory = path.join(desktopRoot, 'resources', 'ffmpeg');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

/** Mock 视频 A:P0 快速路径（容量富余），FFmpeg 指向包内真实二进制（§6 合成必须真跑）。 */
const launch = async (managedRoot: string, exportDirectory: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: exportDirectory,
      JINGXU_E2E_VIDEO_STEPS: Array.from({ length: 12 }, () => 'A:P0').join(','),
      JINGXU_FFMPEG_PATH: path.join(ffmpegDirectory, 'ffmpeg.exe'),
      JINGXU_FFPROBE_PATH: path.join(ffmpegDirectory, 'ffprobe.exe'),
    },
  });

/** 首帧候选逐镜头生成并选中（合成与视频候选的前置）。 */
const prepareSelectedFirstFrames = async (page: Page, projectId: string): Promise<void> => {
  await page.evaluate(async (pid) => {
    const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
    if (!workspace.ok) throw new Error(workspace.error.code);
    for (const shot of workspace.data.storyboard.shots) {
      const generated = await window.jingxu.image.generateCandidates({
        projectId: pid,
        requestId: `voice_chain_image_${crypto.randomUUID()}`,
        shotId: shot.shotId,
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
      const candidates = await window.jingxu.image.listCandidates({
        projectId: pid,
        shotId: shot.shotId,
      });
      if (!candidates.ok) throw new Error(candidates.error.code);
      const succeeded = candidates.data.find((candidate) => candidate.status === 'SUCCEEDED');
      if (succeeded === undefined) throw new Error('VOICE_CHAIN_FIRST_FRAME_MISSING');
      const selected = await window.jingxu.image.selectCandidate({
        candidateId: succeeded.id,
        projectId: pid,
        requestId: `voice_chain_select_image_${crypto.randomUUID()}`,
      });
      if (!selected.ok) throw new Error(selected.error.code);
    }
  }, projectId);
};

/** 整集视频候选批跑并为每镜头选中一个 SUCCEEDED；返回全部镜头 ID。 */
const prepareSelectedVideoCandidates = async (
  page: Page,
  projectId: string,
): Promise<readonly string[]> => {
  const shotIds = await page.evaluate(async (pid) => {
    const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
    if (!workspace.ok) throw new Error(workspace.error.code);
    return workspace.data.storyboard.shots.map((shot) => shot.shotId);
  }, projectId);
  await page.evaluate(
    async ({ pid, allShotIds }) => {
      const batch = await window.jingxu.video.generateVideosForShots({
        projectId: pid,
        requestId: `voice_chain_video_batch_${crypto.randomUUID()}`,
        shotIds: allShotIds,
      });
      if (!batch.ok) throw new Error(batch.error.code);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const state = await window.jingxu.video.listStoryboardVideoStates({ projectId: pid });
        if (!state.ok) throw new Error(state.error.code);
        if (state.data.batches[0]?.status === 'COMPLETED') break;
        if (state.data.batches[0]?.status === 'CANCELLED') {
          throw new Error(`VOICE_CHAIN_VIDEO_BATCH_CANCELLED`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const shotId of allShotIds) {
        const candidates = await window.jingxu.video.listVideoCandidates({
          projectId: pid,
          shotId,
        });
        if (!candidates.ok) throw new Error(candidates.error.code);
        const succeeded = candidates.data.find((item) => item.status === 'SUCCEEDED');
        if (succeeded === undefined) throw new Error('VOICE_CHAIN_VIDEO_CANDIDATE_MISSING');
        const selected = await window.jingxu.video.selectVideoCandidate({
          candidateId: succeeded.id,
          projectId: pid,
          requestId: `voice_chain_select_video_${crypto.randomUUID()}`,
        });
        if (!selected.ok) throw new Error(selected.error.code);
      }
    },
    { allShotIds: [...shotIds], pid: projectId },
  );
  return shotIds;
};

interface VoiceChainSummary {
  readonly mappingRows: number;
  readonly skippedCount: number;
  readonly targetCount: number;
}

/** 配音阶段：映射白名单 → 整集批量 → 逐镜头等待并选择 SUCCEEDED 候选。 */
const runVoiceChain = async (
  page: Page,
  projectId: string,
  shotIds: readonly string[],
): Promise<VoiceChainSummary> =>
  page.evaluate(
    async ({ allShotIds, pid }) => {
      const voice = window.jingxu.voice;
      const initialMappings = await voice.getMappings({ projectId: pid });
      if (!initialMappings.ok) throw new Error(initialMappings.error.code);
      const narratorRow = initialMappings.data.find((row) => row.speakerId === 'narrator');
      if (narratorRow?.voiceId !== 'Neil') {
        throw new Error('VOICE_MAPPING_NARRATOR_DEFAULT_MISSING');
      }
      // narrator 固定音色：提交注册表内但非默认的值一律拒绝且不改行（组合根 R1）。
      const rejected = await voice.saveMapping({
        mappings: [{ speakerId: 'narrator', voiceId: 'Cherry' }],
        projectId: pid,
        requestId: `voice_chain_mapping_bad_${crypto.randomUUID()}`,
      });
      if (rejected.ok || rejected.error.code !== 'IPC_INVALID_REQUEST') {
        throw new Error('VOICE_MAPPING_WHITELIST_NOT_ENFORCED');
      }

      const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
      if (!workspace.ok || workspace.data.storyboard.current === null) {
        throw new Error('WORKSPACE_NOT_READY');
      }
      const batch = await voice.generateForEpisode({
        episodeId: workspace.data.episode.id,
        projectId: pid,
        requestId: `voice_chain_batch_${crypto.randomUUID()}`,
        shotIds: allShotIds,
      });
      if (!batch.ok) throw new Error(batch.error.code);
      // Mock 契约：每第 3 镜头（index%3===2）无台词，其余全部旁白目标。
      if (batch.data.targetShotIds.length + batch.data.skippedShots.length !== allShotIds.length) {
        throw new Error('VOICE_BATCH_PARTITION_BROKEN');
      }
      if (batch.data.skippedShots.some((skip) => skip.reason !== 'NOT_VOICE_TARGET')) {
        throw new Error('VOICE_BATCH_UNEXPECTED_SKIP_REASON');
      }

      for (const shotId of batch.data.targetShotIds) {
        let selected = false;
        for (let attempt = 0; attempt < 120 && !selected; attempt += 1) {
          const generations = await voice.getGenerations({ projectId: pid, shotId });
          if (!generations.ok) throw new Error(generations.error.code);
          const succeeded = generations.data.find((row) => row.status === 'SUCCEEDED');
          if (succeeded === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          if (!succeeded.mediaUrl?.startsWith('jingxu://media/')) {
            throw new Error('VOICE_CANDIDATE_URL_NOT_RESTRICTED');
          }
          const chosen = await voice.selectCandidate({
            candidateId: succeeded.id,
            projectId: pid,
            requestId: `voice_chain_select_${crypto.randomUUID()}`,
          });
          if (!chosen.ok) throw new Error(chosen.error.code);
          selected = true;
        }
        if (!selected) throw new Error(`VOICE_CANDIDATE_TIMEOUT:${shotId}`);
      }
      return {
        mappingRows: initialMappings.data.length,
        skippedCount: batch.data.skippedShots.length,
        targetCount: batch.data.targetShotIds.length,
      };
    },
    { allShotIds: [...shotIds], pid: projectId },
  );

test('E2E-V2-VOICE-FULL-CHAIN—映射→整集生成→候选选择→时间线编辑→对齐→含配音字幕导出→审计', async () => {
  test.setTimeout(420_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-voice-full-chain-'));
  if (process.env.JINGXU_KEEP_E2E_ARTIFACTS === '1') console.info(`VOICE_CHAIN_E2E_ROOT=${root}`);
  const managedRoot = path.join(root, 'managed');
  const exportDirectory = path.join(root, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const application = await launch(managedRoot, exportDirectory);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, 'V2 配音全链');
    // Mock 分镜契约恒定：6 镜头、台词均在旁白、每第 3 镜头无台词。
    expect(seeded.shotCount).toBe(6);

    await prepareSelectedFirstFrames(page, seeded.projectId);
    const shotIds = await prepareSelectedVideoCandidates(page, seeded.projectId);

    const voiceSummary = await runVoiceChain(page, seeded.projectId, shotIds);
    expect(voiceSummary.targetCount).toBe(4);
    expect(voiceSummary.skippedCount).toBe(2);

    // ── 时间线阶段：创建派生两轨与对齐，回存一次产生第二版本 ──
    const timeline = await page.evaluate(
      async ({ pid }) => {
        const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
        if (!workspace.ok || workspace.data.storyboard.current === null) {
          throw new Error('WORKSPACE_NOT_READY');
        }
        const created = await window.jingxu.video.createTimeline({
          episodeId: workspace.data.episode.id,
          expectedEpisodeVersionId: workspace.data.storyboard.current.id,
          projectId: pid,
          requestId: `voice_chain_timeline_${crypto.randomUUID()}`,
        });
        if (!created.ok) throw new Error(created.error.code);
        return { data: created.data, episodeId: workspace.data.episode.id };
      },
      { pid: seeded.projectId },
    );
    expect(timeline.data.items).toHaveLength(6);
    expect(timeline.data.voiceItems).toHaveLength(4);
    expect(timeline.data.subtitleItems).toHaveLength(4);
    expect(timeline.data.alignmentItems).toHaveLength(4);
    // Mock 确定性：2600ms 配音 vs 1000ms 镜头 → SLIGHTLY_LONG/FREEZE_EXTEND 无回退。
    for (const row of timeline.data.alignmentItems) {
      expect(row.category).toBe('SLIGHTLY_LONG');
      expect(row.strategy).toBe('FREEZE_EXTEND');
      expect(row.dialogueComplete).toBe(true);
      expect(row.storyboardFallback).toBe(false);
      expect(row.manualOverride).toBeNull();
      expect(row.audioDurationMs).toBeGreaterThan(0);
      expect(row.extendedMs).toBeGreaterThan(0);
    }

    const saved = await page.evaluate(
      async ({ eid, fd, pid }) => {
        const result = await window.jingxu.video.updateTimeline({
          audioAssetId: null,
          audioVolume: 0.35,
          episodeId: eid,
          expectedVersionId: fd.id,
          items: fd.items,
          projectId: pid,
          requestId: `voice_chain_timeline_save_${crypto.randomUUID()}`,
          subtitleItems: fd.subtitleItems,
          voiceItems: fd.voiceItems,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.data;
      },
      {
        eid: timeline.episodeId,
        fd: {
          id: timeline.data.id,
          items: timeline.data.items,
          subtitleItems: timeline.data.subtitleItems,
          voiceItems: timeline.data.voiceItems,
        },
        pid: seeded.projectId,
      },
    );
    expect(saved.versionNo).toBe(timeline.data.versionNo + 1);

    // ── 导出阶段：含配音与烧录字幕的真实 FFmpeg 合成 ──
    const exported = await page.evaluate(
      async ({ eid, pid, timelineVersionId }) => {
        const started = await window.jingxu.video.startExport({
          episodeId: eid,
          projectId: pid,
          requestId: `voice_chain_export_${crypto.randomUUID()}`,
          timelineVersionId,
        });
        if (!started.ok) throw new Error(started.error.code);
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const current = await window.jingxu.video.getExportJob({
            exportJobId: started.data.id,
            projectId: pid,
          });
          if (!current.ok) throw new Error(current.error.code);
          if (current.data.status === 'SUCCEEDED') return current.data;
          if (current.data.status === 'FAILED' || current.data.status === 'CANCELLED') {
            throw new Error(current.data.errorCode ?? current.data.status);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('VOICE_CHAIN_EXPORT_TIMEOUT');
      },
      { eid: timeline.episodeId, pid: seeded.projectId, timelineVersionId: saved.id },
    );
    expect(exported.mediaUrl).toMatch(/^jingxu:\/\/media\/video-export\//u);
    expect(exported.fileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(exported.byteSize).toBeGreaterThan(0);
    const outputPath = path.join(exportDirectory, `jingxu-video-${exported.id}.mp4`);
    const output = await readFile(outputPath);
    expect(createHash('sha256').update(output).digest('hex')).toBe(exported.fileSha256);
    expect(output.byteLength).toBe(exported.byteSize);
    const { stdout } = await execFileAsync(path.join(ffmpegDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type',
      '-show_entries',
      'format=duration,format_name',
      '-of',
      'json',
      outputPath,
    ]);
    const probe = JSON.parse(stdout) as {
      format: { duration: string; format_name: string };
      streams: { codec_type: string }[];
    };
    expect(probe.format.format_name).toContain('mp4');
    // 冻结延展只落在 4 个有配音的镜头（无台词镜头无对齐行不延展）：
    // 4 ×（镜头 1000ms + FREEZE_EXTEND 1600ms）+ 2 × 1000ms = 12.4s。
    expect(Number(probe.format.duration)).toBeGreaterThan(11);
    expect(Number(probe.format.duration)).toBeLessThan(14);
    // 配音轨存在 → 一条混音音频流 + 一条视频流（无 BGM 也必须有音轨）。
    expect(probe.streams.map((stream) => stream.codec_type).sort()).toEqual(['audio', 'video']);
  } finally {
    await application.close().catch(() => undefined);
  }

  try {
    // 关进程释放库句柄后以纯 node 只读断言审计留痕（红线：台词明文不落任何留痕列）。
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-voice-timeline-audit.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    console.log(stdout.trim());
    expect(stdout).toContain('VOICE_AUDIT_OK');
    expect(stdout).toContain('"targets":4');
    expect(stdout).toContain('"selected":4');
    expect(stdout).toContain('"candidates":4');
    expect(stdout).toContain('"jobs":1');
    expect(stdout).toContain('"exportJobs":1');
  } finally {
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1') {
      await rm(root, { force: true, recursive: true });
    }
  }
});
