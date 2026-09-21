import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { _electron as electron, test } from '@playwright/test';

// 临时收官探针：对已生成视频的项目执行 选择→时间线→导出，并复制 MP4 证据。
// 门控：JINGXU_REAL_FULL_CHAIN=1 + JINGXU_DATA_ROOT_OVERRIDE（指向保留数据根）。
const desktopRoot = path.resolve(__dirname, '..');
const gated = process.env.JINGXU_REAL_FULL_CHAIN === '1';
const dataRoot = process.env.JINGXU_DATA_ROOT_OVERRIDE ?? '';
const projectId = process.env.JINGXU_DEBUG_PROJECT_ID ?? '';
const shotId = process.env.JINGXU_DEBUG_SHOT_IDS?.split(',')[0] ?? '';
const candidateId = process.env.JINGXU_DEBUG_CANDIDATE_ID ?? '';
const ffmpegDirectory = path.join(desktopRoot, 'resources', 'ffmpeg');

/** 512×512 纯色 PNG（参考图资产占位；真实生成为 Seedream 输出）。 */
const REFERENCE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIElEQVR4nO3VMQ0AMAzAsKEbnGEq1MHoEUsGkC/nvgEg6KwXALDCAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAGCaPqfBT7EgPK29AAAAAElFTkSuQmCC';

test('真实收官——选择视频→时间线→FFmpeg 导出 MP4', async () => {
  test.setTimeout(2_400_000);
  test.skip(
    !gated || dataRoot === '' || projectId === '' || shotId === '' || candidateId === '',
    '需要 FULL_CHAIN 门控与项目/镜头/候选 id',
  );
  const application = await electron.launch({
    args: [desktopRoot, '--no-proxy-server'],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined &&
            name !== 'ELECTRON_RUN_AS_NODE' &&
            name !== 'ELECTRON_FORCE_IS_PACKAGED',
        ),
      ),
      LOCALAPPDATA: dataRoot,
      JINGXU_FFMPEG_PATH: path.join(ffmpegDirectory, 'ffmpeg.exe'),
      JINGXU_FFPROBE_PATH: path.join(ffmpegDirectory, 'ffprobe.exe'),
    },
  });
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(
      async ({ candidateId, projectId, referencePngBase64 }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok) return { step: 'workspace', errorCode: workspace.error.code };
        const episodeId = workspace.data.episode.id;
        const currentStoryboard = workspace.data.storyboard.current;
        if (currentStoryboard === null) return { step: 'storyboard-null' };
        const picked = await window.jingxu.video.selectVideoCandidate({
          candidateId,
          projectId,
          requestId: requestId('select'),
        });
        if (!picked.ok) return { step: 'select', errorCode: picked.error.code };

        // 一致性前置：预检驱动——missingItems 精确给出缺的 STYLE/CHARACTER，
        // 循环上传参考图至 ready=true（最多 3 轮）。Renderer 无 Node Buffer：atob 解码。
        const allShotIds = workspace.data.storyboard.shots.map((shot) => shot.shotId);
        const referenceBytes = Uint8Array.from(atob(referencePngBase64), (character) =>
          character.charCodeAt(0),
        );
        for (let round = 1; round <= 3; round += 1) {
          const preflight = await window.jingxu.image.getConsistencyPreflight({
            projectId,
            shotIds: allShotIds,
          });
          if (!preflight.ok)
            return { step: `preflight:${String(round)}`, errorCode: preflight.error.code };
          if (preflight.data.ready) break;
          const missing = preflight.data.missingItems;
          if (missing.length === 0) break;
          for (const [index, item] of missing.entries()) {
            const uploaded = await window.jingxu.image.uploadAssetReference({
              assetType: item.kind,
              bibleRefId: item.bibleRefId,
              byteSize: referenceBytes.length,
              bytes: Uint8Array.from(referenceBytes),
              description:
                item.kind === 'STYLE' ? '午夜列车悬疑：冷蓝光与车厢暖光对比，电影感构图' : null,
              displayName: item.displayName,
              mimeType: 'image/png',
              projectId,
              requestId: requestId(`asset-r${String(round)}-${String(index)}`),
            });
            if (!uploaded.ok)
              return {
                step: `asset-r${String(round)}-${String(index)}`,
                errorCode: uploaded.error.code,
              };
          }
        }
        const preflightFinal = await window.jingxu.image.getConsistencyPreflight({
          projectId,
          shotIds: allShotIds,
        });
        if (!preflightFinal.ok)
          return { step: 'preflight-final', errorCode: preflightFinal.error.code };
        if (!preflightFinal.data.ready)
          return { step: 'preflight-not-ready', warnings: preflightFinal.data.warnings };

        // 全部镜头幂等补齐（首帧→视频）；已有选择则跳过（断点续跑安全）。
        for (const shot of workspace.data.storyboard.shots) {
          // ── 首帧（真 Seedream）──
          const frames = await window.jingxu.image.listCandidates({
            projectId,
            shotId: shot.shotId,
          });
          if (!frames.ok) return { step: `frames:${shot.shotId}`, errorCode: frames.error.code };
          if (!frames.data.some((candidate) => candidate.selectedAt !== null)) {
            let frame = frames.data.find((candidate) => candidate.status === 'SUCCEEDED');
            for (let round = 1; round <= 3 && frame === undefined; round += 1) {
              const generated = await window.jingxu.image.generateCandidates({
                projectId,
                requestId: requestId(`img-${shot.shotId}-r${String(round)}`),
                shotId: shot.shotId,
              });
              if (!generated.ok)
                return {
                  step: `img-gen:${shot.shotId}:r${String(round)}`,
                  errorCode: generated.error.code,
                };
              let phase = generated.data.phase;
              for (let i = 0; i < 900 && phase !== 'COMPLETED'; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const task = await window.jingxu.image.getMediaTask({
                  projectId,
                  taskId: generated.data.id,
                });
                if (!task.ok)
                  return { step: `img-task:${shot.shotId}`, errorCode: task.error.code };
                phase = task.data.phase;
              }
              const listed = await window.jingxu.image.listCandidates({
                projectId,
                shotId: shot.shotId,
              });
              if (!listed.ok)
                return { step: `img-list:${shot.shotId}`, errorCode: listed.error.code };
              frame = listed.data.find((candidate) => candidate.status === 'SUCCEEDED');
            }
            if (frame === undefined) return { step: `no-frame:${shot.shotId}`, projectId };
            const framePick = await window.jingxu.image.selectCandidate({
              candidateId: frame.id,
              projectId,
              requestId: requestId(`img-sel-${shot.shotId}`),
            });
            if (!framePick.ok)
              return { step: `img-sel:${shot.shotId}`, errorCode: framePick.error.code };
          }

          // ── 视频（真 Agnes，1 RPM 轮间 65s，最多 3 轮）──
          const existing = await window.jingxu.video.listVideoCandidates({
            projectId,
            shotId: shot.shotId,
          });
          if (!existing.ok) return { step: `list:${shot.shotId}`, errorCode: existing.error.code };
          if (!existing.data.some((candidate) => candidate.selectedAt !== null)) {
            let usable = existing.data.find((candidate) => candidate.status === 'SUCCEEDED');
            for (let round = 1; round <= 3 && usable === undefined; round += 1) {
              if (round > 1) await new Promise((resolve) => setTimeout(resolve, 65_000));
              const priorList = await window.jingxu.video.listVideoCandidates({
                projectId,
                shotId: shot.shotId,
              });
              if (!priorList.ok)
                return { step: `prior:${shot.shotId}`, errorCode: priorList.error.code };
              const priorIds = new Set(priorList.data.map((candidate) => candidate.id));
              const generated = await window.jingxu.video.generateVideoCandidates({
                projectId,
                requestId: requestId(`vid-${shot.shotId}-r${String(round)}`),
                shotId: shot.shotId,
              });
              if (!generated.ok)
                return {
                  step: `gen:${shot.shotId}:r${String(round)}`,
                  errorCode: generated.error.code,
                };
              let phase = generated.data.phase;
              for (let i = 0; i < 600 && phase !== 'COMPLETED'; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const task = await window.jingxu.video.getVideoTask({
                  projectId,
                  taskId: generated.data.id,
                });
                if (!task.ok) return { step: `task:${shot.shotId}`, errorCode: task.error.code };
                phase = task.data.phase;
                if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(phase)) break;
              }
              const listed = await window.jingxu.video.listVideoCandidates({
                projectId,
                shotId: shot.shotId,
              });
              if (!listed.ok) return { step: `list2:${shot.shotId}`, errorCode: listed.error.code };
              usable = listed.data.find(
                (candidate) => !priorIds.has(candidate.id) && candidate.status === 'SUCCEEDED',
              );
            }
            if (usable === undefined) return { step: `no-video:${shot.shotId}`, projectId };
            const selected = await window.jingxu.video.selectVideoCandidate({
              candidateId: usable.id,
              projectId,
              requestId: requestId(`sel-${shot.shotId}`),
            });
            if (!selected.ok) return { step: `sel:${shot.shotId}`, errorCode: selected.error.code };
          }
        }
        const timeline = await window.jingxu.video.createTimeline({
          episodeId,
          expectedEpisodeVersionId: currentStoryboard.id,
          projectId,
          requestId: requestId('timeline'),
        });
        if (!timeline.ok) return { step: 'timeline', errorCode: timeline.error.code };
        const started = await window.jingxu.video.startExport({
          episodeId,
          projectId,
          requestId: requestId('export'),
          timelineVersionId: timeline.data.id,
        });
        if (!started.ok) return { step: 'export.start', errorCode: started.error.code };
        let job = started.data;
        for (let attempt = 0; attempt < 300 && job.status !== 'SUCCEEDED'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const current = await window.jingxu.video.getExportJob({
            exportJobId: job.id,
            projectId,
          });
          if (!current.ok) return { step: 'export.get', errorCode: current.error.code };
          job = current.data;
          if (['FAILED', 'CANCELLED'].includes(job.status))
            return { step: 'export.terminal', status: job.status, errorCode: job.errorCode };
        }
        return {
          byteSize: job.byteSize,
          fileSha256: job.fileSha256,
          mediaUrl: job.mediaUrl,
          status: job.status,
          timelineVersionId: job.timelineVersionId,
          totalDurationMs: job.totalDurationMs,
        };
      },
      { candidateId, projectId, referencePngBase64: REFERENCE_PNG_BASE64 },
    );
    console.log(`REAL_EXPORT_RESULT ${JSON.stringify(result)}`);
    const ok = result as { mediaUrl?: string | null; fileSha256?: string };
    if (ok.mediaUrl) {
      // mediaUrl = jingxu://media/video-export/<exportJobId>；MP4 在导出记录的
      // 内容寻址路径下。整个 projects 树里找最新 mp4 复制留档。
      const artifacts = path.resolve(__dirname, '../../../..', 'jingxu-tools');
      const projectsRoot = path.join(dataRoot, 'JingxuStudio', 'projects');
      let latest = { file: '', mtime: 0 };
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = path.join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else if (name.endsWith('.mp4') && st.mtimeMs > latest.mtime)
            latest = { file: full, mtime: st.mtimeMs };
        }
      };
      walk(projectsRoot);
      if (latest.file !== '') {
        await mkdir(artifacts, { recursive: true });
        const destination = path.join(artifacts, `full-chain-export-${String(Date.now())}.mp4`);
        await copyFile(latest.file, destination);
        const bytes = await readFile(destination);
        console.info(
          `[export-proof] bytes=${String(bytes.length)} · sha256=${createHash('sha256').update(bytes).digest('hex')} · saved=${destination}`,
        );
      }
    }
  } finally {
    await application.close();
  }
});
