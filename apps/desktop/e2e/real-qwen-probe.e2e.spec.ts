import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { _electron as electron, test, type ElectronApplication } from '@playwright/test';

// 真实 Qwen 联调探针（临时文件，测完删除）：
// - 不设 JINGXU_E2E → 走真实 QwenTextModelAdapter + 生产数据根目录
// - 五阶段全流程：CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT，逐阶段生成+确认
// - 凭据经正式 IPC 保存（safeStorage 加密）；已配置则复用，不重复落密文
// - 门控：未设 JINGXU_REAL_KEY_FILE / JINGXU_REAL_WORKSPACE_ID 时 skip，避免误触真实 API
const desktopRoot = path.resolve(__dirname, '..');
const keyFile = process.env.JINGXU_REAL_KEY_FILE ?? '';
const workspaceId = process.env.JINGXU_REAL_WORKSPACE_ID ?? '';
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

test('真实 Qwen 五阶段全流程探针', async () => {
  test.setTimeout(600_000);
  test.skip(!keyFile || !workspaceId, '需要 JINGXU_REAL_KEY_FILE 与 JINGXU_REAL_WORKSPACE_ID');
  const apiKey = (await readFile(keyFile, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');

  let application: ElectronApplication | undefined;
  try {
    // --no-proxy-server：主进程 fetch 走 Chromium 网络栈并读系统代理；本机系统代理
    // （127.0.0.1:7897）间歇不可用会导致 MODEL_NETWORK_ERROR。探针直连取证，
    // 该行为已作为环境发现记入 README。
    application = await electron.launch({
      args: [desktopRoot, '--no-proxy-server'],
      env: { ...environment() },
    });
    const page = await application.firstWindow();
    const result = await page.evaluate(
      async ({ apiKey, orderedStages, refreshCredential, workspaceId }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        const created = await window.jingxu.project.create({
          aspectRatio: '9:16',
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          genre: '悬疑',
          name: `真实联调五阶段-${String(Date.now())}`,
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

        const profile = await window.jingxu.provider.getProfile({
          profileId: 'profile_qwen_primary',
        });
        if (!profile.ok) return { step: 'provider.getProfile', errorCode: profile.error.code };
        // JINGXU_REAL_REFRESH_CREDENTIAL=1 时强制覆盖生产库里已持久化的旧凭据（Key 轮换后重联调）。
        if (!profile.data.configured || refreshCredential) {
          // 顺序陷阱：先保存凭据（创建行），再保存 Workspace；必须 testCredential 写入 lastValidatedAt
          const savedCredential = await window.jingxu.provider.saveCredential({
            apiKey,
            expectedVersionId: profile.data.versionId,
            profileId: 'profile_qwen_primary',
            requestId: requestId('provider-key'),
          });
          if (!savedCredential.ok) {
            return { step: 'provider.saveCredential', errorCode: savedCredential.error.code };
          }
          const savedWorkspace = await window.jingxu.provider.saveProfile({
            enabled: true,
            expectedVersionId: savedCredential.data.versionId,
            profileId: 'profile_qwen_primary',
            requestId: requestId('provider-profile'),
            workspaceId,
          });
          if (!savedWorkspace.ok) {
            return { step: 'provider.saveProfile', errorCode: savedWorkspace.error.code };
          }
          const tested = await window.jingxu.provider.testCredential({
            expectedVersionId: savedWorkspace.data.versionId,
            profileId: 'profile_qwen_primary',
            requestId: requestId('provider-test'),
          });
          if (!tested.ok) {
            return { step: 'provider.testCredential', errorCode: tested.error.code };
          }
        }

        const readyIds: Record<string, string> = {};
        const stageResults: unknown[] = [];
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
          if (expectedInputVersionId === undefined) {
            stageResults.push({ stage, error: `missing-input` });
            break;
          }
          const queued = await window.jingxu.job.create({
            episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
            expectedInputVersionId,
            idempotencyKey: requestId(`idem-${stage}`),
            operationType: 'GENERATE',
            projectId,
            requestId: requestId(`job-${stage}`),
            stage,
          });
          if (!queued.ok) {
            stageResults.push({ stage, errorCode: queued.error.code });
            break;
          }
          const jobId = queued.data.id;
          let finalStatus = 'TIMEOUT_POLL';
          let errorCode: string | undefined;
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const status = await window.jingxu.job.get({ jobId });
            if (!status.ok) {
              finalStatus = `job.get:${status.error.code}`;
              break;
            }
            if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
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
          if (!refreshed.ok) {
            stageResults.push({
              stage,
              finalStatus,
              errorCode,
              jobId,
              error: refreshed.error.code,
            });
            break;
          }
          workspace = refreshed.data;
          const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
          stageResults.push({
            stage,
            finalStatus,
            errorCode,
            jobId,
            draftStatus: draft?.status ?? null,
          });
          if (finalStatus !== 'SUCCEEDED' || draft?.status !== 'DRAFT') break;
          const confirmed = await window.jingxu.script.confirmVersion({
            episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
            expectedVersionId: draft.id,
            projectId,
            requestId: requestId(`confirm-${stage}`),
            stage,
            versionId: draft.id,
          });
          if (!confirmed.ok) {
            stageResults.push({ stage, error: `confirm:${confirmed.error.code}` });
            break;
          }
          readyIds[stage] = confirmed.data.id;
          const afterConfirm = await window.jingxu.script.getWorkspace({ projectId });
          if (!afterConfirm.ok) break;
          workspace = afterConfirm.data;
        }

        // SHOT_CONTRACT 腿（shot-contract-generation §6.5）：SCENE_SCRIPT READY 后生成整集分镜并确认。
        const sceneReadyId = readyIds.SCENE_SCRIPT;
        if (sceneReadyId !== undefined) {
          const queuedShot = await window.jingxu.job.create({
            episodeId: workspace.episode.id,
            expectedInputVersionId: sceneReadyId,
            idempotencyKey: requestId('idem-shot-contract'),
            operationType: 'GENERATE',
            projectId,
            requestId: requestId('job-shot-contract'),
            stage: 'SHOT_CONTRACT',
          });
          if (!queuedShot.ok) {
            stageResults.push({ stage: 'SHOT_CONTRACT', errorCode: queuedShot.error.code });
          } else {
            let shotStatus = 'TIMEOUT_POLL';
            let shotError: string | undefined;
            for (let attempt = 0; attempt < 400; attempt += 1) {
              const status = await window.jingxu.job.get({ jobId: queuedShot.data.id });
              if (!status.ok) {
                shotStatus = `job.get:${status.error.code}`;
                break;
              }
              if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
                shotStatus = status.data.status;
                shotError = status.data.errorCode ?? undefined;
                break;
              }
              if (status.data.status === 'SUCCEEDED') {
                shotStatus = status.data.status;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            const shotWorkspace = await window.jingxu.script.getWorkspace({ projectId });
            const storyboard = shotWorkspace.ok ? shotWorkspace.data.storyboard : null;
            stageResults.push({
              stage: 'SHOT_CONTRACT',
              draftStatus: storyboard?.current?.status ?? null,
              errorCode: shotError,
              finalStatus: shotStatus,
              shotCount: storyboard?.shots.length ?? null,
              totalDurationSec: storyboard?.totalDurationSec ?? null,
            });
            if (shotStatus === 'SUCCEEDED' && storyboard?.current?.status === 'DRAFT') {
              const confirmedShot = await window.jingxu.script.confirmVersion({
                episodeId: workspace.episode.id,
                expectedVersionId: storyboard.current.id,
                projectId,
                requestId: requestId('confirm-shot-contract'),
                stage: 'SHOT_CONTRACT',
                versionId: storyboard.current.id,
              });
              if (!confirmedShot.ok) {
                stageResults.push({
                  stage: 'SHOT_CONTRACT',
                  error: `confirm:${confirmedShot.error.code}`,
                });
              } else {
                const afterShot = await window.jingxu.script.getWorkspace({ projectId });
                stageResults.push({
                  stage: 'SHOT_CONTRACT',
                  readyStatus: afterShot.ok
                    ? (afterShot.data.storyboard.current?.status ?? null)
                    : null,
                  readyShotSetHash: afterShot.ok
                    ? (afterShot.data.storyboard.current?.shotSetHash ?? null)
                    : null,
                });
              }
            }
          }
        }
        return { projectId, stageResults };
      },
      {
        apiKey,
        orderedStages: stages,
        refreshCredential: process.env.JINGXU_REAL_REFRESH_CREDENTIAL === '1',
        workspaceId,
      },
    );
    console.log(`REAL_QWEN_PROBE_RESULT ${JSON.stringify(result)}`);
  } finally {
    await application?.close();
  }
});
