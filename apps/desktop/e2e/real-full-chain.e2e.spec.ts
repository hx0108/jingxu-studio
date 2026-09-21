import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, test, type ElectronApplication } from '@playwright/test';

// 真实全链探针（low-cost 收尾后端到端实地验证；临时文件，测完删除）：
// 剧本（真 Qwen 六阶段）→ 画风/角色参考上传（预检驱动）→ 首帧（真 Seedream）→
// 切 Agnes 档生成视频（真 Adapter）→ 人工选择 → 时间线 → FFmpeg 导出 MP4。
// - 不设 JINGXU_E2E → 全部真实 Adapter
// - LOCALAPPDATA 覆盖到临时目录 = 隔离数据根（fresh DB 自动迁移 head 24，不触真库）
// - 门控：JINGXU_REAL_FULL_CHAIN=1 且三把 Key 文件齐备才运行；否则 skip 零网络
const desktopRoot = path.resolve(__dirname, '..');
const gated = process.env.JINGXU_REAL_FULL_CHAIN === '1';
const qwenKeyFile = process.env.JINGXU_QWEN_KEY_FILE ?? '';
const agnesKeyFile = process.env.JINGXU_AGNES_KEY_FILE ?? '';
const workspaceId = process.env.JINGXU_REAL_WORKSPACE_ID ?? 'jingxu';
const ffmpegDirectory = path.join(desktopRoot, 'resources', 'ffmpeg');

const readKey = async (file: string): Promise<string> =>
  file === '' ? '' : (await readFile(file, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');

/** 512×512 纯色 PNG（参考图资产占位；真实生成为 Seedream 输出）。 */
const REFERENCE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIElEQVR4nO3VMQ0AMAzAsKEbnGEq1MHoEUsGkC/nvgEg6KwXALDCAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAGCaPqfBT7EgPK29AAAAAElFTkSuQmCC';

test('真实全链——剧本→首帧→视频→导出 MP4', async () => {
  test.setTimeout(1_800_000);
  test.skip(!gated, '需要 JINGXU_REAL_FULL_CHAIN=1；未配置的 Provider 将在剧本前置失败');
  const qwenKey = await readKey(qwenKeyFile);
  const agnesKey = await readKey(agnesKeyFile);
  const isolatedData = await mkdtemp(path.join(os.tmpdir(), 'jingxu-full-chain-'));

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
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
        LOCALAPPDATA: process.env.JINGXU_DATA_ROOT_OVERRIDE ?? isolatedData,
        JINGXU_FFMPEG_PATH: path.join(ffmpegDirectory, 'ffmpeg.exe'),
        JINGXU_FFPROBE_PATH: path.join(ffmpegDirectory, 'ffprobe.exe'),
      },
    });
    const page = await application.firstWindow();
    const result = await page.evaluate(
      async ({ agnesKey, qwenKey, referencePngBase64, workspaceId }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        const steps: unknown[] = [];

        // ── A. 三档 Provider 配置（正式 IPC；fresh 隔离库均未配置）─────────────
        const configureProvider = async (
          profileId: string,
          apiKey: string,
          withWorkspace: boolean,
        ): Promise<string | null> => {
          const profile = await window.jingxu.provider.getProfile({ profileId });
          if (!profile.ok) return `getProfile:${profileId}:${profile.error.code}`;
          // 已配置即复用（生产根拷贝自带当时验证过的 Key）；未配置才落新凭据。
          if (profile.data.configured) return null;
          const saved = await window.jingxu.provider.saveCredential({
            apiKey,
            expectedVersionId: profile.data.versionId,
            profileId,
            requestId: requestId(`key-${profileId}`),
          });
          if (!saved.ok) return `saveCredential:${profileId}:${saved.error.code}`;
          if (withWorkspace) {
            const savedProfile = await window.jingxu.provider.saveProfile({
              enabled: true,
              expectedVersionId: saved.data.versionId,
              profileId,
              requestId: requestId(`profile-${profileId}`),
              workspaceId,
            });
            if (!savedProfile.ok) return `saveProfile:${profileId}:${savedProfile.error.code}`;
          }
          const tested = await window.jingxu.provider.testCredential({
            expectedVersionId: saved.data.versionId,
            profileId,
            requestId: requestId(`test-${profileId}`),
          });
          if (!tested.ok) return `testCredential:${profileId}:${tested.error.code}`;
          return null;
        };
        const qwenError = await configureProvider('profile_qwen_primary', qwenKey, true);
        if (qwenError !== null) return { step: 'qwen-provider', errorCode: qwenError };
        // 2026-09-21 起图片档=Agnes Image（2.5 Flash 默认），用 Agnes Key。
        const imageError = await configureProvider('profile-image-agnes-primary', agnesKey, false);
        if (imageError !== null) return { step: 'image-provider', errorCode: imageError };
        const agnesError = await configureProvider('profile-video-agnes-primary', agnesKey, false);
        if (agnesError !== null) return { step: 'agnes-provider', errorCode: agnesError };
        steps.push({ step: 'providers-configured' });

        // 当前视频档 → AGNES（0023 单例：先取 updatedAt 再 CAS 保存）
        const current = await window.jingxu.provider.getVideoProviderSelection({
          requestId: requestId('selection-get'),
        });
        if (!current.ok) return { step: 'selection-get', errorCode: current.error.code };
        const selected = await window.jingxu.provider.saveVideoProviderSelection({
          expectedUpdatedAt: current.data.updatedAt,
          mode: 'AGNES',
          requestId: requestId('selection-save'),
        });
        if (!selected.ok) return { step: 'selection-save', errorCode: selected.error.code };

        // ── B. 剧本：真 Qwen 六阶段（轮询预算 900s/阶段）──────────────────────
        const created = await window.jingxu.project.create({
          aspectRatio: '9:16',
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          genre: '悬疑',
          name: `全链实地-${String(Date.now())}`,
          requestId: requestId('project'),
          style: '二维漫剧',
          subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
        });
        if (!created.ok) return { step: 'project.create', errorCode: created.error.code };
        const projectId = created.data.id;
        const initialized = await window.jingxu.script.initializeOriginal({
          creativeText: '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客记忆的人。',
          dataProcessingConsent: true,
          projectId,
          requestId: requestId('initialize'),
        });
        if (!initialized.ok)
          return { step: 'script.initializeOriginal', errorCode: initialized.error.code };
        let workspace = initialized.data;
        const orderedStages = [
          'CONCEPT',
          'STORY_BIBLE',
          'EPISODE_OUTLINE',
          'BEAT_SHEET',
          'SCENE_SCRIPT',
        ] as const;
        const readyIds: Record<string, string> = {};
        for (const stage of orderedStages) {
          const expectedInputVersionId =
            stage === 'CONCEPT'
              ? workspace.source.id
              : stage === 'STORY_BIBLE'
                ? readyIds.CONCEPT
                : stage === 'EPISODE_OUTLINE'
                  ? readyIds.STORY_BIBLE
                  : stage === 'BEAT_SHEET'
                    ? readyIds.EPISODE_OUTLINE
                    : readyIds.BEAT_SHEET;
          if (expectedInputVersionId === undefined)
            return { step: `missing-input:${stage}`, projectId };
          // LLM 输出质量非确定性（CONTRACT_VALIDATION_FAILED 逐次波动）：
          // 每阶段最多 3 次尝试（新 idempotency key = 全新采样）。
          let finalStatus = 'NOT_RUN';
          let errorCode: string | undefined;
          let draft: { id: string; status: string } | null | undefined = undefined;
          for (let stageAttempt = 1; stageAttempt <= 3; stageAttempt += 1) {
            const queued = await window.jingxu.job.create({
              episodeId:
                stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
              expectedInputVersionId,
              idempotencyKey: requestId(`idem-${stage}-${String(stageAttempt)}`),
              operationType: 'GENERATE',
              projectId,
              requestId: requestId(`job-${stage}-${String(stageAttempt)}`),
              stage,
            });
            if (!queued.ok) return { step: `job.create:${stage}`, errorCode: queued.error.code };
            finalStatus = 'TIMEOUT_POLL';
            errorCode = undefined;
            for (let attempt = 0; attempt < 900; attempt += 1) {
              const status = await window.jingxu.job.get({ jobId: queued.data.id });
              if (!status.ok) {
                finalStatus = `job.get:${status.error.code}`;
                break;
              }
              if (['FAILED', 'CANCELLED'].includes(status.data.status)) {
                finalStatus = status.data.status;
                errorCode = status.data.errorCode ?? undefined;
                break;
              }
              if (status.data.status === 'SUCCEEDED') {
                finalStatus = status.data.status;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            const refreshed = await window.jingxu.script.getWorkspace({ projectId });
            if (!refreshed.ok)
              return { step: `workspace:${stage}`, errorCode: refreshed.error.code };
            workspace = refreshed.data;
            draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
            if (finalStatus === 'SUCCEEDED' && draft?.status === 'DRAFT') break;
            if (stageAttempt < 3) await new Promise((resolve) => setTimeout(resolve, 15_000));
          }
          if (finalStatus !== 'SUCCEEDED' || draft?.status !== 'DRAFT')
            return { step: `stage:${stage}`, finalStatus, errorCode, projectId };
          const confirmed = await window.jingxu.script.confirmVersion({
            episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
            expectedVersionId: draft.id,
            projectId,
            requestId: requestId(`confirm-${stage}`),
            stage,
            versionId: draft.id,
          });
          if (!confirmed.ok) return { step: `confirm:${stage}`, errorCode: confirmed.error.code };
          readyIds[stage] = confirmed.data.id;
          const after = await window.jingxu.script.getWorkspace({ projectId });
          if (!after.ok) return { step: `workspace-after:${stage}` };
          workspace = after.data;
        }

        // ── C. SHOT_CONTRACT 整集分镜（LLM 输出质量非确定性：失败自动重试 3 次）──
        const sceneReadyId = readyIds.SCENE_SCRIPT;
        if (sceneReadyId === undefined) return { step: 'missing-input:SHOT_CONTRACT', projectId };
        let shotStatus = 'NOT_RUN';
        for (let shotAttempt = 1; shotAttempt <= 3; shotAttempt += 1) {
          const queuedShot = await window.jingxu.job.create({
            episodeId: workspace.episode.id,
            expectedInputVersionId: sceneReadyId,
            idempotencyKey: requestId(`idem-shot-contract-${String(shotAttempt)}`),
            operationType: 'GENERATE',
            projectId,
            requestId: requestId(`job-shot-contract-${String(shotAttempt)}`),
            stage: 'SHOT_CONTRACT',
          });
          if (!queuedShot.ok)
            return {
              step: 'job.create:SHOT_CONTRACT',
              errorCode: queuedShot.error.code,
              projectId,
            };
          shotStatus = 'TIMEOUT_POLL';
          for (let attempt = 0; attempt < 900; attempt += 1) {
            const status = await window.jingxu.job.get({ jobId: queuedShot.data.id });
            if (!status.ok) {
              shotStatus = `job.get:${status.error.code}`;
              break;
            }
            if (['FAILED', 'CANCELLED'].includes(status.data.status)) {
              shotStatus = `${status.data.status}:${status.data.errorCode ?? ''}`;
              break;
            }
            if (status.data.status === 'SUCCEEDED') {
              shotStatus = status.data.status;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          const polled = await window.jingxu.script.getWorkspace({ projectId });
          if (!polled.ok)
            return { step: 'workspace:shot', errorCode: polled.error.code, projectId };
          workspace = polled.data;
          if (shotStatus === 'SUCCEEDED' && workspace.storyboard.current?.status === 'DRAFT') break;
          if (shotAttempt < 3) await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
        const storyboard = workspace.storyboard;
        if (shotStatus !== 'SUCCEEDED' || storyboard.current?.status !== 'DRAFT')
          return {
            step: 'SHOT_CONTRACT',
            shotStatus,
            readyStatus: storyboard.current?.status ?? null,
            projectId,
          };
        const confirmedShot = await window.jingxu.script.confirmVersion({
          episodeId: workspace.episode.id,
          expectedVersionId: storyboard.current.id,
          projectId,
          requestId: requestId('confirm-shot-contract'),
          stage: 'SHOT_CONTRACT',
          versionId: storyboard.current.id,
        });
        if (!confirmedShot.ok)
          return { step: 'confirm:SHOT_CONTRACT', errorCode: confirmedShot.error.code };
        const readyWorkspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!readyWorkspace.ok) return { step: 'workspace:ready' };
        workspace = readyWorkspace.data;
        if (workspace.storyboard.current?.status !== 'READY')
          return { step: 'storyboard-not-ready', projectId };
        const shotIds = workspace.storyboard.shots.map((shot) => shot.shotId).slice(0, 2);
        steps.push({
          step: 'script-ready',
          shotCount: workspace.storyboard.shots.length,
          usingShots: shotIds.length,
        });

        // ── D. 一致性前置：预检驱动——missingItems 精确给出缺的 STYLE/CHARACTER，
        // 循环上传参考图至 ready=true（最多 3 轮；门禁拒收的镜头缺什么补什么）。
        // Renderer 无 Node Buffer：atob 解码参考图 base64。
        const referenceBytes = Uint8Array.from(atob(referencePngBase64), (character) =>
          character.charCodeAt(0),
        );
        for (let round = 1; round <= 3; round += 1) {
          const preflight = await window.jingxu.image.getConsistencyPreflight({
            projectId,
            shotIds,
          });
          if (!preflight.ok)
            return {
              step: `preflight:${String(round)}`,
              errorCode: preflight.error.code,
              projectId,
              shotIds,
            };
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
                projectId,
              };
          }
        }
        const preflightFinal = await window.jingxu.image.getConsistencyPreflight({
          projectId,
          shotIds,
        });
        if (!preflightFinal.ok)
          return { step: 'preflight-final', errorCode: preflightFinal.error.code, projectId };
        if (!preflightFinal.data.ready)
          return {
            step: 'preflight-not-ready',
            projectId,
            shotIds,
            warnings: preflightFinal.data.warnings,
          };
        steps.push({ step: 'consistency-ready' });

        // ── E. 首帧：真 Seedream 逐镜头生成并选择 ─────────────────────────────
        const firstFrameByShot = new Map<string, string>();
        for (const shotId of shotIds) {
          const generated = await window.jingxu.image.generateCandidates({
            projectId,
            requestId: requestId(`img-${shotId}`),
            shotId,
          });
          if (!generated.ok)
            return { step: `image.generate:${shotId}`, errorCode: generated.error.code, projectId };
          let phase = generated.data.phase;
          for (let attempt = 0; attempt < 900 && phase !== 'COMPLETED'; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const task = await window.jingxu.image.getMediaTask({
              projectId,
              taskId: generated.data.id,
            });
            if (!task.ok) return { step: `image.task:${shotId}`, errorCode: task.error.code };
            phase = task.data.phase;
          }
          if (phase !== 'COMPLETED') return { step: `image.drained:${shotId}`, phase, projectId };
          const listed = await window.jingxu.image.listCandidates({ projectId, shotId });
          if (!listed.ok) return { step: `image.list:${shotId}`, errorCode: listed.error.code };
          const succeeded = listed.data.find((candidate) => candidate.status === 'SUCCEEDED');
          if (succeeded === undefined)
            return {
              step: `image.no-succeeded:${shotId}`,
              projectId,
              candidateErrors: listed.data.map((candidate) => ({
                status: candidate.status,
                errorCode: candidate.errorCode,
              })),
            };
          const pick = await window.jingxu.image.selectCandidate({
            candidateId: succeeded.id,
            projectId,
            requestId: requestId(`img-select-${shotId}`),
          });
          if (!pick.ok) return { step: `image.select:${shotId}`, errorCode: pick.error.code };
          firstFrameByShot.set(shotId, succeeded.id);
        }
        steps.push({ step: 'first-frames', count: firstFrameByShot.size });

        // ── F. 视频：真 Agnes Adapter 逐镜头生成并选择 ────────────────────────
        const videoByShot = new Map<string, { candidateId: string }>();
        for (const shotId of shotIds) {
          // Agnes 免费档 1 RPM + 队列容量波动：候选级失败（可重试错误）时新轮重发，
          // 每镜头最多 3 轮、轮间 65 秒（与调度器退避同语义）。
          let picked: { id: string } | null = null;
          let lastDiag: Record<string, unknown> | undefined = undefined;
          for (let round = 1; round <= 3; round += 1) {
            if (round > 1) await new Promise((resolve) => setTimeout(resolve, 65_000));
            const generated = await window.jingxu.video.generateVideoCandidates({
              projectId,
              requestId: requestId(`vid-${shotId}-r${String(round)}`),
              shotId,
            });
            if (!generated.ok)
              return {
                step: `video.generate:${shotId}:r${String(round)}`,
                errorCode: generated.error.code,
                projectId,
              };
            const taskId = generated.data.id;
            const priorList = await window.jingxu.video.listVideoCandidates({
              projectId,
              shotId,
            });
            if (!priorList.ok)
              return { step: `video.prior:${shotId}`, errorCode: priorList.error.code };
            // 以"生成前已存在的候选 id 集合"识别本轮新候选（roundNo 不在任务视图暴露）。
            const priorCandidateIds = new Set(priorList.data.map((candidate) => candidate.id));
            let finalPhase = 'TIMEOUT_POLL';
            let videoErrorCode: string | null = null; // candidateErrors 由 lastDiag 承载
            for (let attempt = 0; attempt < 600; attempt += 1) {
              const task = await window.jingxu.video.getVideoTask({ projectId, taskId });
              if (!task.ok) return { step: `video.task:${shotId}`, errorCode: task.error.code };
              finalPhase = task.data.phase;
              if (task.data.phase === 'FAILED') videoErrorCode = task.data.errorCode;
              if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.data.phase)) break;
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            const listed = await window.jingxu.video.listVideoCandidates({ projectId, shotId });
            if (!listed.ok) return { step: `video.list:${shotId}`, errorCode: listed.error.code };
            const succeeded = listed.data.find(
              (candidate) =>
                !priorCandidateIds.has(candidate.id) && candidate.status === 'SUCCEEDED',
            );
            if (succeeded !== undefined) {
              picked = { id: succeeded.id };
              break;
            }
            lastDiag = {
              finalPhase,
              videoErrorCode,
              generatedTaskId: generated.data.id,
              candidateErrors: listed.data
                .filter((candidate) => !priorCandidateIds.has(candidate.id))
                .map((candidate) => ({ status: candidate.status, errorCode: candidate.errorCode })),
            };
          }
          if (picked === null)
            return {
              step: `video.no-succeeded:${shotId}`,
              projectId,
              attempts: 3,
              lastDiag,
            };
          const pick = await window.jingxu.video.selectVideoCandidate({
            candidateId: picked.id,
            projectId,
            requestId: requestId(`vid-select-${shotId}`),
          });
          if (!pick.ok) return { step: `video.select:${shotId}`, errorCode: pick.error.code };
          videoByShot.set(shotId, { candidateId: picked.id });
        }
        steps.push({ step: 'videos', count: videoByShot.size });

        // ── G. 时间线 + FFmpeg 导出 ────────────────────────────────────────────
        const episodeId = workspace.episode.id;
        const timeline = await window.jingxu.video.createTimeline({
          episodeId,
          expectedEpisodeVersionId: workspace.storyboard.current.id,
          projectId,
          requestId: requestId('timeline-create'),
        });
        if (!timeline.ok) return { step: 'timeline.create', errorCode: timeline.error.code };
        const exportStarted = await window.jingxu.video.startExport({
          episodeId,
          projectId,
          requestId: requestId('export'),
          timelineVersionId: timeline.data.id,
        });
        if (!exportStarted.ok) return { step: 'export.start', errorCode: exportStarted.error.code };
        let exportJob = exportStarted.data;
        for (let attempt = 0; attempt < 300 && exportJob.status !== 'SUCCEEDED'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const current = await window.jingxu.video.getExportJob({
            exportJobId: exportJob.id,
            projectId,
          });
          if (!current.ok) return { step: 'export.get', errorCode: current.error.code };
          exportJob = current.data;
          if (['FAILED', 'CANCELLED'].includes(exportJob.status))
            return {
              step: 'export.terminal',
              status: exportJob.status,
              errorCode: exportJob.errorCode,
              projectId,
            };
        }
        if (exportJob.status !== 'SUCCEEDED')
          return { step: 'export.timeout', status: exportJob.status, projectId };
        return {
          episodeId,
          exportByteSize: exportJob.byteSize,
          exportFileSha256: exportJob.fileSha256,
          exportStorageRelPath: (exportJob as { storageRelPath?: string }).storageRelPath ?? null,
          mediaUrl: exportJob.mediaUrl,
          projectId,
          steps,
          timelineTotalDurationMs: timeline.data.totalDurationMs,
          videoCandidatePrefixes: [...videoByShot.values()].map((entry) =>
            entry.candidateId.slice(0, 8),
          ),
        };
      },
      { agnesKey, qwenKey, referencePngBase64: REFERENCE_PNG_BASE64, workspaceId },
    );
    console.log(`REAL_FULL_CHAIN_RESULT ${JSON.stringify(result)}`);
    const ok = result as { exportFileSha256?: string; mediaUrl?: string | null };
    if (ok.exportFileSha256 !== undefined && ok.mediaUrl != null) {
      const effectiveRoot = process.env.JINGXU_DATA_ROOT_OVERRIDE ?? isolatedData;
      const managedRoot = path.join(effectiveRoot, 'JingxuStudio');
      const artifacts = path.resolve(__dirname, '../../../..', 'jingxu-tools');
      // 导出文件位于隔离数据根；把 MP4 与证据摘要复制到 jingxu-tools 留档。
      try {
        const candidates: string[] = [];
        const walkExports = (dir: string): void => {
          for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walkExports(full);
            else if (name.endsWith('.mp4')) candidates.push(full);
          }
        };
        walkExports(managedRoot);
        if (candidates[0] !== undefined) {
          const destination = path.join(artifacts, `full-chain-export-${String(Date.now())}.mp4`);
          await copyFile(candidates[0], destination);
          const bytes = await readFile(destination);
          console.info(
            `[full-chain] MP4 evidence · bytes=${String(bytes.length)} · sha256=${createHash('sha256').update(bytes).digest('hex')} · saved=${destination}`,
          );
        }
      } catch {
        console.info('[full-chain] MP4 copy skipped (non-fatal)');
      }
    }
  } finally {
    await application?.close();
    if (process.env.JINGXU_DATA_ROOT_OVERRIDE === undefined) {
      const keepData = process.env.JINGXU_KEEP_FAILED_DATA === '1';
      if (!keepData)
        await rm(isolatedData, {
          force: true,
          maxRetries: 10,
          recursive: true,
          retryDelay: 300,
        }).catch(() => undefined);
      else console.info(`[full-chain] isolated data kept at ${isolatedData}`);
    }
  }
});
