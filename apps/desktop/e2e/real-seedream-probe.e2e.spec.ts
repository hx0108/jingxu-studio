import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { encodeMockPng } from '@jingxu/model-adapters';
import { _electron as electron, test, type ElectronApplication } from '@playwright/test';

// 真实火山方舟 Seedream 联调探针（临时文件，测完删除）：
// - 不设 JINGXU_E2E → 文本走真实 QwenTextModelAdapter、图片走真实 SeedreamImageModelAdapter + 生产数据根
// - ARK Key 只经 JINGXU_REAL_ARK_KEY_FILE 传文件路径，由主进程门控接线（JINGXU_IMAGE_CREDENTIAL_FILE）
//   safeStorage 加密写入 secrets 固定凭据；探针全程不读取、不回显 Key
// - 文生图与参考图生图各一轮：轮1（未传资产，纯文生图）→ 上传资产 → 轮2（绑定资产，
//   generationInputHash 变化实证参考图进入生成输入）→ 人工选择 → 资产升版 v2 触发 STALE
// - 门控：未设 JINGXU_REAL_KEY_FILE / JINGXU_REAL_WORKSPACE_ID / JINGXU_REAL_ARK_KEY_FILE 时 skip
const desktopRoot = path.resolve(__dirname, '..');
const keyFile = process.env.JINGXU_REAL_KEY_FILE ?? '';
const workspaceId = process.env.JINGXU_REAL_WORKSPACE_ID ?? '';
const arkKeyFile = process.env.JINGXU_REAL_ARK_KEY_FILE ?? '';
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;
const projectName = `真实首帧联调-${String(Date.now())}`;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

test('真实 Seedream 首帧闭环探针（文生图 + 参考图生图 + 选择 + 升版 STALE）', async () => {
  test.setTimeout(1_200_000);
  test.skip(
    !keyFile || !workspaceId || !arkKeyFile,
    '需要 JINGXU_REAL_KEY_FILE、JINGXU_REAL_WORKSPACE_ID 与 JINGXU_REAL_ARK_KEY_FILE',
  );
  const apiKey = (await readFile(keyFile, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');

  let application: ElectronApplication | undefined;
  try {
    // --no-proxy-server：主进程 fetch 走 Chromium 网络栈并读系统代理；系统代理间歇不可用
    // 会表现为 MODEL_NETWORK_ERROR（2026-08-16 README 联调记录）。探针直连取证。
    application = await electron.launch({
      args: [desktopRoot, '--no-proxy-server'],
      env: { ...environment(), JINGXU_IMAGE_CREDENTIAL_FILE: arkKeyFile },
    });
    const page = await application.firstWindow();
    await page
      .getByRole('heading', { name: '镜序 Studio', exact: true })
      .waitFor({ timeout: 30_000 });

    // 阶段一：真实 Qwen 五阶段 + SHOT_CONTRACT，取得 READY 分镜（与 real-qwen-probe 同源逻辑）。
    const seeded = await page.evaluate(
      async ({ apiKey, orderedStages, projectName, refreshCredential, workspaceId }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        const created = await window.jingxu.project.create({
          aspectRatio: '9:16',
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          genre: '悬疑',
          name: projectName,
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
        if (!initialized.ok) {
          return { step: 'script.initializeOriginal', errorCode: initialized.error.code };
        }
        let workspace = initialized.data;
        const profile = await window.jingxu.provider.getProfile({
          profileId: 'profile_qwen_primary',
        });
        if (!profile.ok) return { step: 'provider.getProfile', errorCode: profile.error.code };
        if (!profile.data.configured || refreshCredential) {
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
            stageResults.push({ stage, error: 'missing-input' });
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
          let finalStatus = 'TIMEOUT_POLL';
          let errorCode: string | undefined;
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const status = await window.jingxu.job.get({ jobId: queued.data.id });
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
            stageResults.push({ stage, finalStatus, errorCode, error: refreshed.error.code });
            break;
          }
          workspace = refreshed.data;
          const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
          stageResults.push({
            stage,
            finalStatus,
            errorCode,
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

        const sceneReadyId = readyIds.SCENE_SCRIPT;
        if (sceneReadyId === undefined) {
          return {
            projectId,
            stageResults,
            step: 'seed-stages',
            errorCode: 'SCENE_SCRIPT_NOT_READY',
          };
        }
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
          return {
            projectId,
            stageResults,
            step: 'job.create-shot',
            errorCode: queuedShot.error.code,
          };
        }
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
        });
        if (shotStatus !== 'SUCCEEDED' || storyboard?.current?.status !== 'DRAFT') {
          return { projectId, stageResults, step: 'seed-shot', errorCode: shotError ?? shotStatus };
        }
        const confirmedShot = await window.jingxu.script.confirmVersion({
          episodeId: workspace.episode.id,
          expectedVersionId: storyboard.current.id,
          projectId,
          requestId: requestId('confirm-shot-contract'),
          stage: 'SHOT_CONTRACT',
          versionId: storyboard.current.id,
        });
        if (!confirmedShot.ok) {
          return {
            projectId,
            stageResults,
            step: 'confirm-shot',
            errorCode: confirmedShot.error.code,
          };
        }
        const afterShot = await window.jingxu.script.getWorkspace({ projectId });
        return {
          projectId,
          readyStatus: afterShot.ok ? (afterShot.data.storyboard.current?.status ?? null) : null,
          shotId: afterShot.ok ? (afterShot.data.storyboard.shots[0]?.shotId ?? null) : null,
          shotCount: afterShot.ok ? afterShot.data.storyboard.shots.length : null,
          stageResults,
        };
      },
      {
        apiKey,
        orderedStages: stages,
        projectName,
        refreshCredential: process.env.JINGXU_REAL_REFRESH_CREDENTIAL === '1',
        workspaceId,
      },
    );
    const seedFailure = seeded as { errorCode?: string; step?: string };
    const seedOk = seeded as {
      projectId: string;
      readyStatus: string | null;
      shotCount: number | null;
      shotId: string | null;
    };
    if (seedFailure.step !== undefined || seedOk.shotId === null) {
      throw new Error(`REAL_SEEDREAM_SEED_FAILED ${JSON.stringify(seeded)}`);
    }

    // 阶段二：真实 Seedream 两轮候选 + 选择 + 升版 STALE。
    const referenceV1 = encodeMockPng('seedream-probe-ref-v1', 256, 256);
    const referenceV2PerAsset = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
      encodeMockPng(`seedream-probe-ref-v2-${String(index)}`, 256, 256),
    );
    const imageLoop = await page.evaluate(
      async ({ projectId, referenceV1, referenceV2PerAsset, shotId }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        const generateAndDrain = async (label: string) => {
          const generated = await window.jingxu.image.generateCandidates({
            projectId,
            requestId: requestId(`generate-${label}`),
            shotId,
          });
          if (!generated.ok) throw new Error(`generate-${label}:${generated.error.code}`);
          let phase = generated.data.phase;
          for (let attempt = 0; attempt < 300 && phase !== 'COMPLETED'; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const task = await window.jingxu.image.getMediaTask({
              projectId,
              taskId: generated.data.id,
            });
            if (!task.ok) throw new Error(`poll-${label}:${task.error.code}`);
            phase = task.data.phase;
            if (phase === 'FAILED') {
              throw new Error(`task-${label}:${String(task.data.errorCode)}`);
            }
          }
          if (phase !== 'COMPLETED') throw new Error(`task-${label}:terminal-${phase}`);
          const listed = await window.jingxu.image.listCandidates({ projectId, shotId });
          if (!listed.ok) throw new Error(`list-${label}:${listed.error.code}`);
          return listed.data;
        };

        // 轮1 文生图：未上传任何资产，生成输入不含 boundAssetVersionIds。
        const round1All = await generateAndDrain('round1');
        const round1 = round1All.filter((candidate) => candidate.roundNo === 1);
        const succeeded1 = round1.filter((candidate) => candidate.status === 'SUCCEEDED');
        if (succeeded1.length !== 4)
          throw new Error(`round1-succeeded:${String(succeeded1.length)}`);
        if (!succeeded1.every((candidate) => candidate.mediaUrl?.startsWith('jingxu://media/'))) {
          throw new Error('round1-mediaUrl-prefix');
        }
        if (
          !succeeded1.every(
            (candidate) => (candidate.byteSize ?? 0) > 0 && (candidate.width ?? 0) >= 1000,
          )
        ) {
          throw new Error('round1-bytes-or-dimensions');
        }
        const hash1 = succeeded1[0]?.generationInputHash ?? null;
        if (hash1 === null || !succeeded1.every((c) => c.generationInputHash === hash1)) {
          throw new Error('round1-hash-inconsistent');
        }

        // 上传资产：覆盖 STORY_BIBLE 全部 character/scene 引用（≤8），确保镜头绑定命中。
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok) throw new Error(`workspace:${workspace.error.code}`);
        const bibleStage = workspace.data.stages.find((stage) => stage.stage === 'STORY_BIBLE');
        const bibleData = bibleStage?.current?.document.data ?? {};
        const bibleCharacters = (bibleData.characters ?? {}) as Record<string, { name?: unknown }>;
        const bibleScenes = (bibleData.scenes ?? {}) as Record<string, { name?: unknown }>;
        const idPattern = /^[A-Za-z0-9_-]{8,128}$/u;
        const refs = [
          ...Object.entries(bibleCharacters).map(([bibleRefId, entry]) => ({
            assetType: 'CHARACTER' as const,
            bibleRefId,
            displayName:
              typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : bibleRefId,
          })),
          ...Object.entries(bibleScenes).map(([bibleRefId, entry]) => ({
            assetType: 'SCENE' as const,
            bibleRefId,
            displayName:
              typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : bibleRefId,
          })),
        ].filter((ref) => idPattern.test(ref.bibleRefId));
        const bounded = refs.slice(0, 8);
        if (bounded.length === 0) throw new Error('assets:no-bible-refs');
        for (const [index, ref] of bounded.entries()) {
          const uploaded = await window.jingxu.image.uploadAssetReference({
            assetType: ref.assetType,
            bibleRefId: ref.bibleRefId,
            byteSize: referenceV1.length,
            bytes: Uint8Array.from(referenceV1),
            description: null,
            displayName: ref.displayName,
            mimeType: 'image/png',
            projectId,
            requestId: requestId(`asset-v1-${String(index)}`),
          });
          if (!uploaded.ok) throw new Error(`asset-v1-${String(index)}:${uploaded.error.code}`);
        }

        // 轮2 参考图生图：绑定资产进入生成输入 → generationInputHash 必须变化。
        const round2All = await generateAndDrain('round2');
        const round2 = round2All.filter((candidate) => candidate.roundNo === 2);
        const succeeded2 = round2.filter((candidate) => candidate.status === 'SUCCEEDED');
        if (succeeded2.length !== 4)
          throw new Error(`round2-succeeded:${String(succeeded2.length)}`);
        const hash2 = succeeded2[0]?.generationInputHash ?? null;
        if (hash2 === null || hash2 === hash1) throw new Error('round2-hash-unchanged');

        // 人工选择轮2候选。
        const chosen = succeeded2[0];
        if (chosen === undefined) throw new Error('round2-empty');
        const selected = await window.jingxu.image.selectCandidate({
          candidateId: chosen.id,
          projectId,
          requestId: requestId('select'),
        });
        if (!selected.ok) throw new Error(`select:${selected.error.code}`);
        if (
          !selected.data.some(
            (candidate) => candidate.id === chosen.id && candidate.selectedAt !== null,
          )
        ) {
          throw new Error('select:not-reflected');
        }

        // 资产升版 v2：受影响镜头必须包含本镜头，轮2候选全员 STALE_INPUT，轮1不受影响。
        const affected = [];
        for (const [index, ref] of bounded.entries()) {
          const bytes = referenceV2PerAsset[index] ?? referenceV2PerAsset[0];
          if (bytes === undefined) throw new Error('asset-v2-bytes-missing');
          const bumped = await window.jingxu.image.uploadAssetReference({
            assetType: ref.assetType,
            bibleRefId: ref.bibleRefId,
            byteSize: bytes.length,
            bytes: Uint8Array.from(bytes),
            description: null,
            displayName: ref.displayName,
            mimeType: 'image/png',
            projectId,
            requestId: requestId(`asset-v2-${String(index)}`),
          });
          if (!bumped.ok) throw new Error(`asset-v2-${String(index)}:${bumped.error.code}`);
          affected.push(...bumped.data.affectedShots);
        }
        const affectedCounts = affected
          .filter((entry) => entry.shotId === shotId)
          .reduce((total, entry) => total + entry.candidateCount, 0);
        if (affectedCounts === 0) throw new Error('stale:shot-not-affected');
        const restaled = await window.jingxu.image.listCandidates({ projectId, shotId });
        if (!restaled.ok) throw new Error(`restale:${restaled.error.code}`);
        const staleRound2 = round2.filter((candidate) => candidate.status === 'STALE_INPUT');
        const intactRound1 = round1.filter(
          (candidate) => candidate.status === 'SUCCEEDED' && candidate.selectedAt === null,
        );
        if (staleRound2.length !== round2.length) {
          throw new Error(`stale-round2:${String(staleRound2.length)}/${String(round2.length)}`);
        }
        if (!staleRound2.some((candidate) => candidate.id === chosen.id)) {
          throw new Error('stale:selected-not-included');
        }
        return {
          affectedShotEntries: affected.filter((entry) => entry.shotId === shotId).length,
          hash1,
          hash2,
          intactRound1: intactRound1.length,
          referenceAssets: bounded.length,
          round1Bytes: succeeded1.map((candidate) => candidate.byteSize),
          round1Dimensions: succeeded1.map((candidate) => ({
            height: candidate.height,
            width: candidate.width,
          })),
          round2Bytes: succeeded2.map((candidate) => candidate.byteSize),
          selectedCandidateId: chosen.id,
          staleRound2: staleRound2.length,
          totalCandidates: restaled.data.length,
        };
      },
      { projectId: seedOk.projectId, referenceV1, referenceV2PerAsset, shotId: seedOk.shotId },
    );

    // 阶段三：UI 经受限协议真实解码（真实 PNG 字节 naturalWidth>0）。
    await page.reload();
    await page.locator('.project-card-main', { hasText: projectName }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.getByRole('heading', { name: '分镜工作台' }).waitFor();
    await page.locator('.shot-card', { hasText: '#1' }).click();
    await page.getByRole('heading', { name: '首帧候选 · 镜头 #1' }).waitFor();
    await page.waitForFunction(
      () => {
        const images = Array.from(
          document.querySelectorAll<HTMLImageElement>('#first-frame-panel .candidate-grid img'),
        );
        return images.length > 0 && images.every((image) => image.naturalWidth > 0);
      },
      undefined,
      { timeout: 60_000 },
    );
    const decodedCount = await page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll<HTMLImageElement>('#first-frame-panel .candidate-grid img'),
        ).filter((image) => image.naturalWidth > 0).length,
    );

    console.log(
      `REAL_SEEDREAM_PROBE_RESULT ${JSON.stringify({
        ...seeded,
        imageLoop,
        projectId: seedOk.projectId,
        uiDecodedImages: decodedCount,
      })}`,
    );
  } finally {
    await application?.close();
  }
});
