import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { StoryboardImageStatesDto } from '@jingxu/contracts';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { seedRealStoryboardReady } from './support/real-probe-seeding';

// 真实火山方舟 Seedream 整集批量首帧联调探针（临时取证，测完可删）：
// - 不设 JINGXU_E2E → 文本走真实 QwenTextModelAdapter、图片走真实 SeedreamImageModelAdapter
//   + 生产数据根；--no-proxy-server 直连（系统代理间歇不可用会污染取证）
// - 全新项目路径：批次一 UI 发起 → 首镜头在飞时 UI 取消 → CANCELLED + 在飞自然终态；
//   随后「为整集生成首帧」驱动剩余镜头收敛（服务端当前世代跳过，跳过清单恰为已就绪镜头）
// - 真实 Provider 限流（首跑实录 MODEL_RATE_LIMITED）→ PARTIAL_COMPLETED 属实况而非缺陷：
//   失败成员必须携带候选错误码，「重试失败镜头（新批次）」UI 入口收敛（重试前退避 60s，
//   至多 4 批）；空目标幂等 MEDIA_BATCH_NO_PENDING_SHOTS；真实 JPEG（jingxu:// 受限协议、
//   尺寸、同轮哈希一致）+ 可选择 + UI 真实解码
// - JINGXU_REAL_BATCH_PROJECT_ID 设定时续跑既有项目：跳过播种与批次一取消，直接驱动收敛
//   （限流中断的探针不重花钱重播种）。待生成口径对齐应用：当前世代 ≥1 张即「已有首帧」
//   （15:0x 实录 1/4 镜头被新批跳过、空目标不建批），续跑收敛线 = 全员 ≥1；「同轮恰 4 张」
//   与全员 4 张的严格断言仅全新跑强制
// - 门控：未设 JINGXU_REAL_KEY_FILE / JINGXU_REAL_WORKSPACE_ID / JINGXU_REAL_ARK_KEY_FILE 时 skip
const desktopRoot = path.resolve(__dirname, '..');
const keyFile = process.env.JINGXU_REAL_KEY_FILE ?? '';
const workspaceId = process.env.JINGXU_REAL_WORKSPACE_ID ?? '';
const arkKeyFile = process.env.JINGXU_REAL_ARK_KEY_FILE ?? '';
const resumeProjectId = process.env.JINGXU_REAL_BATCH_PROJECT_ID ?? '';
const freshProjectName = `真实批次联调-${String(Date.now())}`;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const fetchImageStates = async (
  page: Page,
  projectId: string,
): Promise<StoryboardImageStatesDto> => {
  const result = await page.evaluate(async (pid: string) => {
    const states = await window.jingxu.image.listStoryboardImageStates({ projectId: pid });
    if (!states.ok) throw new Error(`listStoryboardImageStates:${states.error.code}`);
    return states.data;
  }, projectId);
  return result;
};

/** 有界轮询 listStoryboardImageStates 至谓词成立；超时抛出末次快照取证。 */
const pollImageStates = async (
  page: Page,
  projectId: string,
  until: (states: StoryboardImageStatesDto) => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<StoryboardImageStatesDto> => {
  const deadline = Date.now() + timeoutMs;
  let latest: StoryboardImageStatesDto | null = null;
  while (Date.now() < deadline) {
    latest = await fetchImageStates(page, projectId);
    if (until(latest)) return latest;
    await sleep(intervalMs);
  }
  throw new Error(`POLL_TIMEOUT ${JSON.stringify(latest)}`);
};

test('真实 Seedream 整集批量首帧探针（取消在飞 + 新批跳过 + 限流重试收敛 + 空目标幂等）', async () => {
  test.setTimeout(2_100_000);
  test.skip(
    !keyFile || !workspaceId || !arkKeyFile,
    '需要 JINGXU_REAL_KEY_FILE、JINGXU_REAL_WORKSPACE_ID 与 JINGXU_REAL_ARK_KEY_FILE',
  );
  const apiKey = (await readFile(keyFile, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');
  const arkApiKey = (await readFile(arkKeyFile, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [desktopRoot, '--no-proxy-server'],
      env: environment(),
    });
    const page = await application.firstWindow();
    await page.getByRole('heading', { name: '我的项目', exact: true }).waitFor({ timeout: 30_000 });

    // 阶段一：全新项目走真实 Qwen 六阶段播种；续跑项目只校验分镜仍 READY 并取镜头清单。
    let projectId = '';
    let cardName = '';
    let shotIds: string[] = [];
    let freshRun = true;
    if (resumeProjectId !== '') {
      const resumed = await page.evaluate(async (pid: string) => {
        const detail = await window.jingxu.project.get({ projectId: pid, scope: 'ACTIVE' });
        if (!detail.ok) {
          return { errorCode: detail.error.code, name: '', readyStatus: '', shotIds: [] };
        }
        const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
        if (!workspace.ok) {
          return { errorCode: workspace.error.code, name: '', readyStatus: '', shotIds: [] };
        }
        return {
          errorCode: '',
          name: detail.data.name,
          readyStatus: workspace.data.storyboard.current?.status ?? '',
          shotIds: workspace.data.storyboard.shots.map((shot) => shot.shotId),
        };
      }, resumeProjectId);
      if (resumed.errorCode !== '') {
        throw new Error(`REAL_BATCH_RESUME_FAILED ${JSON.stringify(resumed)}`);
      }
      expect(resumed.readyStatus).toBe('READY');
      projectId = resumeProjectId;
      cardName = resumed.name;
      shotIds = resumed.shotIds;
      freshRun = false;
    } else {
      const seeded = await seedRealStoryboardReady(page, {
        apiKey,
        projectName: freshProjectName,
        refreshCredential: process.env.JINGXU_REAL_REFRESH_CREDENTIAL === '1',
        workspaceId,
      });
      if ('step' in seeded) {
        throw new Error(`REAL_BATCH_SEED_FAILED ${JSON.stringify(seeded)}`);
      }
      expect(seeded.readyStatus).toBe('READY');
      projectId = seeded.projectId;
      cardName = freshProjectName;
      shotIds = seeded.shotIds;
    }
    const shotCount = shotIds.length;
    expect(shotCount).toBeGreaterThanOrEqual(2);
    const firstShotId = shotIds[0] ?? '';

    // 阶段二：ARK Key 走 UI 路径（与 real-seedream-probe 同闭环：先删后存→解密测试）。
    await page.reload();
    await page.getByRole('heading', { name: '我的项目', exact: true }).waitFor({ timeout: 30_000 });
    await page.locator('.project-card-main', { hasText: cardName }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.getByRole('heading', { name: '分镜工作台' }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const imageCard = page.locator('section[aria-labelledby="image-provider-title"]');
    await imageCard
      .getByRole('heading', { name: '图片模型服务（火山方舟 ARK）' })
      .waitFor({ timeout: 30_000 });
    // 已配置且末四位与本轮密钥一致 → 直接复用不删存（删除确认框曾需人工应答，15:0x 实录
    // 卡住整轮探针）；未配置或密钥不一致才走「先删后存」重建。
    const configuredText = `已配置（末四位 ${arkApiKey.slice(-4)}）`;
    if ((await imageCard.getByText(configuredText).count()) === 0) {
      if ((await imageCard.getByText(/已配置/).count()) > 0) {
        page.once('dialog', (dialog) => {
          void dialog.accept();
        });
        await imageCard.getByRole('button', { name: '删除凭据' }).click();
        await imageCard.getByText('凭据已删除').waitFor({ timeout: 15_000 });
      }
      await imageCard.getByLabel('ARK API Key').fill(arkApiKey);
      await imageCard.getByRole('button', { name: '保存凭据' }).click();
      await imageCard.getByText(configuredText).waitFor({ timeout: 15_000 });
    }
    await imageCard.getByRole('button', { name: '测试凭据' }).click();
    await imageCard.getByText(/· 密文可解密读取/).waitFor({ timeout: 15_000 });

    // 阶段三·批次一（仅全新项目）：UI 发起 → 首镜头在建档且存在排队镜头 → UI 取消。
    let batch1Id = '';
    if (freshRun) {
      await page.getByRole('button', { name: '为整集生成首帧' }).click();
      const midStates = await pollImageStates(
        page,
        projectId,
        (states) => {
          const running = states.batches.some((batch) => batch.status === 'RUNNING');
          const first = states.shots.find((shot) => shot.shotId === firstShotId);
          const queued = states.shots.filter((shot) => shot.queuedInBatchId !== null).length;
          return running && first?.activeTaskPhase != null && queued >= 1;
        },
        120_000,
        1_000,
      );
      batch1Id = midStates.batches.find((batch) => batch.status === 'RUNNING')?.batchId ?? '';
      expect(batch1Id).not.toBe('');
      await page.getByRole('button', { name: '取消剩余镜头' }).click();

      // 批次一收尾：CANCELLED 即落；在飞首镜头不被中断，跑完 4 候选；其余零建档零候选。
      const cancelledStates = await pollImageStates(
        page,
        projectId,
        (states) => {
          const batch1 = states.batches.find((batch) => batch.batchId === batch1Id);
          const first = states.shots.find((shot) => shot.shotId === firstShotId);
          return batch1?.status === 'CANCELLED' && first?.activeTaskPhase == null;
        },
        360_000,
      );
      const batch1 = cancelledStates.batches.find((batch) => batch.batchId === batch1Id);
      expect(batch1?.status).toBe('CANCELLED');
      const firstAfterCancel = cancelledStates.shots.find((shot) => shot.shotId === firstShotId);
      expect(firstAfterCancel?.currentGenSucceededCount).toBe(4);
      const restAfterCancel = cancelledStates.shots.filter((shot) => shot.shotId !== firstShotId);
      expect(restAfterCancel.length).toBe(shotCount - 1);
      for (const shot of restAfterCancel) {
        expect(shot.currentGenSucceededCount, `取消后镜头 ${shot.shotId} 不得有候选`).toBe(0);
        expect(shot.activeTaskPhase, `取消后镜头 ${shot.shotId} 不得有任务`).toBeNull();
        expect(shot.queuedInBatchId, `取消后镜头 ${shot.shotId} 不得仍排队`).toBeNull();
      }
    }

    // 阶段三·驱动至全员就绪：为整集发起新批（服务端跳过已就绪镜头）；真实限流致
    // PARTIAL 时断言失败成员携带候选错误码，走「重试失败镜头（新批次）」收敛
    // （重试前退避 60s 让限流窗口翻页；至多 4 批，超限如实失败）。
    const knownBatchIds = new Set<string>();
    const partialEvidence: unknown[] = [];
    let finalStates: StoryboardImageStatesDto | null = null;
    let ensureBatchSkipped: string[] | null = null;
    // 应用待生成口径 = 当前世代 ≥1 张即「已有首帧」（整集/重试两个按钮都不会为其补图），
    // 续跑收敛线与之对齐；全新跑仍从严整集驱动至全员 4 张。
    const readyThreshold = freshRun ? 4 : 1;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pre = await fetchImageStates(page, projectId);
      if (pre.shots.every((shot) => shot.currentGenSucceededCount >= readyThreshold)) {
        finalStates = pre;
        break;
      }
      // 每轮点击前把现存批次全部标记已知：「新批」= 本轮点击后才出现的批。
      // 续跑项目携带历史终态批，空集起判会把它们误当本轮新批（14:03 实录踩坑）。
      for (const existing of pre.batches) knownBatchIds.add(existing.batchId);
      // 续跑实录（2026-08-20）：重启恢复自动续跑中断批次的 pending 队列（设计内行为），
      // 活跃批存在时两按钮均禁用、点击必超时——收养该批为本轮批次（从已知集合除名，
      // 其终态转换即视作本轮新批），等其自然收敛后继续循环，不点击。
      const activeBatch = pre.batches.find((batch) => batch.status === 'RUNNING');
      if (activeBatch !== undefined) knownBatchIds.delete(activeBatch.batchId);
      if (activeBatch === undefined) {
        if (attempt > 0) await sleep(60_000);
        if (attempt === 0) {
          await page.getByRole('button', { name: '为整集生成首帧' }).click();
        } else {
          await page.getByRole('button', { name: '重试失败镜头（新批次）' }).click();
        }
      }
      // 终态=显式 COMPLETED/PARTIAL_COMPLETED：批行创建后先落 PENDING 再转 RUNNING，
      // 「≠RUNNING 且 ≠CANCELLED」会把 PENDING 窗口误判为终态（14:39 实录竞态）。
      const isTerminal = (batch: { status: string }): boolean =>
        batch.status === 'COMPLETED' || batch.status === 'PARTIAL_COMPLETED';
      const isNewTerminalBatch = (batch: { batchId: string; status: string }): boolean =>
        !knownBatchIds.has(batch.batchId) && isTerminal(batch);
      const terminal = await pollImageStates(
        page,
        projectId,
        (states) => states.batches.some(isNewTerminalBatch),
        // 2026-08-20 实录：10 镜头题材整集串行（9 任务 × 4 候选）约 16 分钟，900s 窗口
        // 在末任务建档后 8s 假超时（POLL_TIMEOUT 时批次仍在正常推进）；放宽至 25 分钟。
        1_500_000,
      );
      const newBatch = terminal.batches.find(isNewTerminalBatch) ?? null;
      expect(newBatch, `驱动批 ${String(attempt)} 未出现终态新批`).not.toBeNull();
      if (newBatch !== null) {
        knownBatchIds.add(newBatch.batchId);
        if (attempt === 0) ensureBatchSkipped = [...newBatch.skippedShotIds];
        if (newBatch.status === 'PARTIAL_COMPLETED') {
          for (const member of newBatch.members) {
            if (member.phase === 'FAILED') {
              // 统一失败口径在真实档的实证：失败成员必须携带候选错误码。
              expect(member.errorCode, `真实失败成员 ${member.shotId} 应携带错误码`).not.toBeNull();
            }
          }
          partialEvidence.push({
            batchId: newBatch.batchId,
            failedMembers: newBatch.members
              .filter((member) => member.phase === 'FAILED')
              .map((member) => ({ errorCode: member.errorCode, shotId: member.shotId })),
          });
        }
      }
      if (terminal.shots.every((shot) => shot.currentGenSucceededCount >= readyThreshold)) {
        finalStates = terminal;
        break;
      }
    }
    expect(finalStates, '驱动至全员就绪未收敛（限流持续或批次异常）').not.toBeNull();
    if (freshRun && finalStates !== null) {
      // 全新路径的跳过语义：驱动批恰跳过批次一在飞完成的镜头。
      expect(ensureBatchSkipped).toEqual([firstShotId]);
      for (const shot of finalStates.shots) {
        expect(shot.currentGenSucceededCount, `终态镜头 ${shot.shotId} 应就绪 4 张`).toBe(4);
        expect(shot.latestTaskErrorCode).toBeNull();
      }
    }

    // 幂等空目标：全员当前世代已有成功候选 → 稳定失败，不落批次行。
    const noPending = await page.evaluate(
      async ({ projectId: pid, shotIds: ids }: { projectId: string; shotIds: string[] }) => {
        const created = await window.jingxu.image.generateCandidatesForShots({
          projectId: pid,
          requestId: `image-batch-real_${crypto.randomUUID()}`,
          shotIds: ids,
        });
        return created.ok ? { code: null } : { code: created.error.code };
      },
      { projectId, shotIds },
    );
    expect(noPending.code).toBe('MEDIA_BATCH_NO_PENDING_SHOTS');

    // 候选质量与可选择：每镜头取「最高有成功候选轮」做协议/字节/尺寸/同轮哈希断言（限流
    // 失败轮保留 FAILED 取证、重试新轮收敛；续跑项目终轮可能 <4 张，如 15:0x 的 1/4 镜头）；
    // 非首镜头选择一张实证批次产物可选。
    const quality = await page.evaluate(
      async ({
        firstShotId: firstId,
        projectId: pid,
        requireCleanRound,
        shotIds: ids,
      }: {
        firstShotId: string;
        projectId: string;
        requireCleanRound: boolean;
        shotIds: string[];
      }) => {
        const perShot = [];
        let selectedCandidateId: string | null = null;
        let selectedShotId: string | null = null;
        let selectedAt: string | null = null;
        for (const shotId of ids) {
          const listed = await window.jingxu.image.listCandidates({ projectId: pid, shotId });
          if (!listed.ok) throw new Error(`list:${listed.error.code}`);
          const byRound = new Map<number, typeof listed.data>();
          for (const candidate of listed.data) {
            const round = byRound.get(candidate.roundNo) ?? [];
            round.push(candidate);
            byRound.set(candidate.roundNo, round);
          }
          // featured = 最高「有成功候选」轮。应用口径 ≥1 即已有首帧、不再为其开新轮，故
          // 最高成功轮即终轮；「同轮恰 4 张」仅全新跑强制。
          let featured: {
            hash: string;
            roundNo: number;
            succeeded: typeof listed.data;
          } | null = null;
          for (const [roundNo, candidates] of byRound) {
            const succeeded = candidates.filter((candidate) => candidate.status === 'SUCCEEDED');
            if (succeeded.length === 0) continue;
            if (
              !succeeded.every((candidate) => candidate.mediaUrl?.startsWith('jingxu://media/'))
            ) {
              throw new Error(`shot-${shotId}-r${String(roundNo)}-mediaUrl-prefix`);
            }
            if (
              !succeeded.every(
                (candidate) => (candidate.byteSize ?? 0) > 0 && (candidate.width ?? 0) >= 1000,
              )
            ) {
              throw new Error(`shot-${shotId}-r${String(roundNo)}-bytes-or-dimensions`);
            }
            const hash = succeeded[0]?.generationInputHash ?? null;
            if (hash === null || !succeeded.every((c) => c.generationInputHash === hash)) {
              throw new Error(`shot-${shotId}-r${String(roundNo)}-hash-inconsistent`);
            }
            if (featured === null || roundNo > featured.roundNo) {
              featured = { hash, roundNo, succeeded };
            }
          }
          if (featured === null) throw new Error(`shot-${shotId}-no-succeeded-candidate`);
          if (requireCleanRound && featured.succeeded.length !== 4) {
            throw new Error(`shot-${shotId}-no-clean-round`);
          }
          perShot.push({
            byteSizes: featured.succeeded.map((candidate) => candidate.byteSize),
            dimensions: featured.succeeded.map((candidate) => ({
              height: candidate.height,
              width: candidate.width,
            })),
            generationInputHash: featured.hash,
            roundsSummary: [...byRound.entries()].map(([roundNo, candidates]) => ({
              failed: candidates.filter((candidate) => candidate.status === 'FAILED').length,
              roundNo,
              succeeded: candidates.filter((candidate) => candidate.status === 'SUCCEEDED').length,
            })),
            shotId,
          });
          if (shotId !== firstId && selectedCandidateId === null) {
            const chosen = featured.succeeded[0];
            if (chosen === undefined) throw new Error('select-source-empty');
            const selected = await window.jingxu.image.selectCandidate({
              candidateId: chosen.id,
              projectId: pid,
              requestId: `image-batch-real_${crypto.randomUUID()}`,
            });
            if (!selected.ok) throw new Error(`select:${selected.error.code}`);
            const reflected = selected.data.find((candidate) => candidate.id === chosen.id);
            if (reflected?.selectedAt == null) throw new Error('select-not-reflected');
            selectedCandidateId = chosen.id;
            selectedShotId = shotId;
            selectedAt = reflected.selectedAt;
          }
        }
        return { perShot, selectedAt, selectedCandidateId, selectedShotId };
      },
      { firstShotId, projectId, requireCleanRound: freshRun, shotIds },
    );

    // 阶段四：UI 终态（徽标/进度行/受限协议真实解码）。进度行按最新批事实动态断言。
    const latestBatch =
      finalStates === null
        ? null
        : ([...finalStates.batches].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ??
          null);
    await page.reload();
    await page.getByRole('heading', { name: '我的项目', exact: true }).waitFor({ timeout: 30_000 });
    await page.locator('.project-card-main', { hasText: cardName }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.getByRole('heading', { name: '分镜工作台' }).waitFor();
    await expect(page.locator('.shot-first-frame-badge')).toHaveCount(shotCount);
    if (freshRun) {
      await expect(
        page.locator('.shot-first-frame-badge', { hasText: '首帧就绪 4 张' }),
      ).toHaveCount(shotCount);
    } else if (finalStates !== null) {
      // 续跑按快照逐镜头断言（真实限流留下的 1/4 镜头如实显示 1 张）。`#1` 子串会命中
      // `#10`（10 镜头题材实录 16:0x strict violation），以 \b 词界锁尾。
      for (const [index, shot] of finalStates.shots.entries()) {
        const badge = page
          .locator('.shot-card', { hasText: new RegExp(`#${String(index + 1)}\\b`) })
          .first()
          .locator('.shot-first-frame-badge');
        await expect(badge).toContainText(`首帧就绪 ${String(shot.currentGenSucceededCount)} 张`);
      }
    }
    const settledCount =
      latestBatch === null
        ? 0
        : latestBatch.members.filter(
            (member) => member.phase === 'COMPLETED' || member.phase === 'FAILED',
          ).length;
    await expect(page.locator('#batch-progress')).toContainText(
      `首帧批次已完成 · 进度 ${String(settledCount)}/${String(latestBatch?.members.length ?? 0)}`,
    );
    if ((latestBatch?.skippedShotIds.length ?? 0) > 0) {
      await expect(page.locator('#batch-progress')).toContainText(
        `跳过 ${String(latestBatch?.skippedShotIds.length ?? 0)}（当前世代已有首帧）`,
      );
    }
    await expect(page.getByRole('button', { name: '取消剩余镜头' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试失败镜头（新批次）' })).toHaveCount(0);
    await page.getByRole('button', { name: '画面生成', exact: true }).click();
    await page.locator('.shot-card', { hasText: /#1\b/ }).click();
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

    await application.close();
    application = undefined;

    console.log(
      `REAL_BATCH_PROBE_RESULT ${JSON.stringify({
        batch1: freshRun
          ? { batchId: batch1Id, status: 'CANCELLED', inFlightShotSucceeded: 4 }
          : null,
        ensureBatchSkipped,
        finalBatch:
          latestBatch === null
            ? null
            : { batchId: latestBatch.batchId, status: latestBatch.status },
        finalCounts:
          finalStates === null
            ? []
            : finalStates.shots.map((shot) => shot.currentGenSucceededCount),
        freshRun,
        noPendingErrorCode: noPending.code,
        partialEvidence,
        projectId,
        quality,
        shotCount,
        uiDecodedImages: decodedCount,
      })}`,
    );
  } finally {
    await application?.close();
  }
});
