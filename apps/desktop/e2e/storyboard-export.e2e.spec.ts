import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

/** 导出落盘 sink 经 JINGXU_E2E + JINGXU_E2E_EXPORT_DIR 注入定名目录（免真实对话框）。 */
const launch = async (managedRoot: string, exportDir: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: exportDir,
    },
  });

/** 重载后从项目列表走真实入口进分镜工作台（复用既有 E2E 驱动路径）。 */
const openStoryboard = async (page: Page, projectName: string): Promise<void> => {
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

test('整集分镜导出—READY 门禁/1.1.0 JSON 落盘/Σ 偏离确认重发/路径红线/审计留痕（storyboard-export）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-storyboard-export-'));
  const managedRoot = path.join(root, 'managed');
  const exportDir = path.join(root, 'exports');
  await mkdir(exportDir, { recursive: true });
  const application = await launch(managedRoot, exportDir);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '整集导出闭环');
    expect(seeded.shotCount).toBe(6);

    // 基线事实：READY v1、6 镜 × 15s（Σ=90 在软带内）。
    const baseline = await page.evaluate(async (projectId: string) => {
      const fetched = await window.jingxu.script.getWorkspace({ projectId });
      if (!fetched.ok) throw new Error(fetched.error.code);
      const storyboard = fetched.data.storyboard;
      if (storyboard.current?.status !== 'READY') throw new Error('baseline:not-ready');
      return {
        durations: storyboard.shots.map((shot) => shot.document.target_duration_sec),
        episodeId: fetched.data.episode.id,
        shots: storyboard.shots.map((shot) => ({
          document: shot.document,
          shotId: shot.shotId,
          versionId: shot.versionId,
        })),
        targetDurationSec: storyboard.current.targetDurationSec,
        versionNo: storyboard.current.versionNo,
        versionId: storyboard.current.id,
        // 白名单（D4）：exportEpisode 并入 storyboard.* 第 4 方法。
        storyboardKeys: Object.keys(window.jingxu.storyboard).sort(),
      };
    }, seeded.projectId);
    expect(baseline.durations).toEqual([15, 15, 15, 15, 15, 15]);
    expect(baseline.storyboardKeys).toEqual([
      'copyShot',
      'deleteShot',
      'editShot',
      'exportEpisode',
      'lockShot',
      'mergeShots',
      'reorderShots',
      'restoreShot',
      'splitShot',
      'unlockShot',
    ]);

    // ---- UI 通路（顺利导出）：READY 才有入口，点击后通知只含 exportId/哈希尾/字节，无路径。 ----
    await page.reload();
    await openStoryboard(page, '整集导出闭环');
    await page.locator('button[name="export-episode"]').click();
    const notice = page.locator('.script-workspace p[role="status"]');
    await expect(notice).toContainText('导出成功：export_', { timeout: 30_000 });
    await expect(notice).toContainText('sha256 …');
    const noticeText = (await notice.textContent()) ?? '';
    expect(noticeText).not.toContain('.json');
    expect(noticeText).not.toContain(exportDir);

    // ---- 数据通路（顺利导出）：回执 5 键无路径；落盘 JSON 过 1.1.0 结构断言 + 哈希复核。 ----
    const exported = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const result = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          format: 'EPISODE_JSON',
          projectId: context.projectId,
          requestId: `export_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.data;
      },
      { episodeId: baseline.episodeId, projectId: seeded.projectId, versionId: baseline.versionId },
    );
    // 路径红线：回执字段恰为 5 键（byteSize/episodeVersionId/exportId/fileSha256/totalDurationSec）。
    expect(Object.keys(exported).sort()).toEqual([
      'byteSize',
      'episodeVersionId',
      'exportId',
      'fileSha256',
      'totalDurationSec',
    ]);
    expect(exported.exportId.startsWith('export_')).toBe(true);
    expect(exported.episodeVersionId).toBe(baseline.versionId);
    expect(exported.totalDurationSec).toBe(90);

    const v1Path = path.join(
      exportDir,
      `export_${seeded.projectId}_${baseline.episodeId}_v${String(baseline.versionNo)}.json`,
    );
    const v1Raw = await readFile(v1Path, 'utf8');
    expect(createHash('sha256').update(v1Raw, 'utf8').digest('hex')).toBe(exported.fileSha256);
    expect(Buffer.byteLength(v1Raw, 'utf8')).toBe(exported.byteSize);
    const envelope = JSON.parse(v1Raw) as Record<string, unknown>;
    // EpisodeStoryboardExport 1.1.0 顶层恰 12 键。
    expect(Object.keys(envelope).sort()).toEqual([
      'episode_id',
      'episode_version',
      'export_id',
      'export_provenance',
      'exported_at',
      'format_profile',
      'lineage_completeness',
      'project_id',
      'schema_version',
      'shot_contracts',
      'story_bible_version_id',
      'target_duration_sec',
    ]);
    expect(envelope.schema_version).toBe('1.1.0');
    expect(envelope.project_id).toBe(seeded.projectId);
    expect(envelope.episode_id).toBe(baseline.episodeId);
    expect(envelope.episode_version).toBe(baseline.versionNo);
    expect(envelope.export_id).toBe(exported.exportId);
    expect(envelope.target_duration_sec).toBe(90);
    expect(envelope.lineage_completeness).toBe('CURRENT_ONLY');
    const provenance = envelope.export_provenance as Record<string, unknown>;
    expect(provenance.exported_by).toBe('LOCAL_USER');
    expect(typeof provenance.app_version).toBe('string');
    expect((provenance.app_version as string).length).toBeGreaterThan(0);
    // Mock 生成链 provenance.source_type=AI_GENERATED ≠ HUMAN_CREATED → true。
    expect(provenance.contains_ai_assisted_content).toBe(true);
    const formatProfile = envelope.format_profile as Record<string, unknown>;
    expect(Object.keys(formatProfile.subtitle_safe_area as object).sort()).toEqual([
      'bottom_pct',
      'left_pct',
      'right_pct',
      'top_pct',
    ]);
    const shotContracts = envelope.shot_contracts as Readonly<Record<string, unknown>>[];
    expect(shotContracts).toHaveLength(6);
    expect(shotContracts.map((shot) => shot.target_duration_sec)).toEqual([15, 15, 15, 15, 15, 15]);
    expect(shotContracts.every((shot) => Array.isArray(shot.locked_paths))).toBe(true);

    // ---- 偏离数据通路：3 镜 15→1（Σ=48）→ DRAFT 门禁 → 再确认 → 无确认导出被拒。 ----
    const deviationSetup = await page.evaluate(
      async (context: {
        episodeId: string;
        projectId: string;
        shots: Readonly<{ document: Record<string, unknown>; shotId: string; versionId: string }>[];
        versionId: string;
      }) => {
        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
        let expectedVersionId = context.versionId;
        // 逐镜改时长（每次编辑推进整集版本，循环内刷新基线）。
        for (const shot of context.shots.slice(0, 3)) {
          const edited = await window.jingxu.storyboard.editShot({
            document: { ...shot.document, target_duration_sec: 1 },
            episodeId: context.episodeId,
            expectedVersionId,
            projectId: context.projectId,
            requestId: requestId('shot-duration'),
            shotId: shot.shotId,
            shotVersionId: shot.versionId,
          });
          if (!edited.ok) throw new Error(`edit:${edited.error.code}`);
          expectedVersionId = edited.data.episode.id;
        }
        const afterEdits = await window.jingxu.script.getWorkspace({
          projectId: context.projectId,
        });
        if (!afterEdits.ok) throw new Error(afterEdits.error.code);
        if (afterEdits.data.storyboard.current?.status !== 'DRAFT') {
          throw new Error('after-edits:not-draft');
        }
        // 非 READY 门禁：DRAFT 下导出直接拒绝（先于任何文件/审计副作用）。
        const notReady = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId,
          format: 'EPISODE_JSON',
          projectId: context.projectId,
          requestId: requestId('export-not-ready'),
        });
        if (notReady.ok) throw new Error('not-ready:unexpected-ok');
        // 重新确认 READY（Σ=48 过硬带 [30,180]，READY 确认不受软带限制）。
        const confirmed = await window.jingxu.script.confirmVersion({
          episodeId: context.episodeId,
          expectedVersionId,
          projectId: context.projectId,
          requestId: requestId('confirm-deviation'),
          stage: 'SHOT_CONTRACT',
          versionId: expectedVersionId,
        });
        if (!confirmed.ok) throw new Error(`confirm:${confirmed.error.code}`);
        const afterConfirm = await window.jingxu.script.getWorkspace({
          projectId: context.projectId,
        });
        if (!afterConfirm.ok) throw new Error(afterConfirm.error.code);
        const current = afterConfirm.data.storyboard.current;
        if (current?.status !== 'READY') throw new Error('after-confirm:not-ready');
        // 无确认导出 → EXPORT_DURATION_DEVIATION，带实际 Σ。
        const deviation = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId: current.id,
          format: 'EPISODE_JSON',
          projectId: context.projectId,
          requestId: requestId('export-deviation'),
        });
        if (deviation.ok) throw new Error('deviation:unexpected-ok');
        return {
          deviationCode: deviation.error.code,
          deviationField: deviation.error.fieldErrors?.totalDurationSec ?? null,
          notReadyCode: notReady.error.code,
          versionNo: current.versionNo,
          versionId: current.id,
        };
      },
      {
        episodeId: baseline.episodeId,
        projectId: seeded.projectId,
        shots: baseline.shots,
        versionId: baseline.versionId,
      },
    );
    expect(deviationSetup.notReadyCode).toBe('EXPORT_NOT_READY');
    expect(deviationSetup.deviationCode).toBe('EXPORT_DURATION_DEVIATION');
    expect(deviationSetup.deviationField).toBe('48');
    // 被拒的两次导出不产生文件：目录仍只有 v1。
    expect(await readdir(exportDir)).toEqual([path.basename(v1Path)]);

    // ---- UI 通路（偏离确认重发，D5）：弹层显示实际 Σ → 填原因 → 确认导出成功。 ----
    await page.reload();
    await openStoryboard(page, '整集导出闭环');
    await page.locator('button[name="export-episode"]').click();
    await expect(page.getByRole('dialog')).toContainText('整集时长偏离目标区间');
    await expect(page.getByRole('dialog')).toContainText('当前镜头时长合计 48s');
    await page.locator('#export-deviation-reason').fill('快闪节奏整集');
    await page.locator('button[name="export-deviation-confirm"]').click();
    await expect(notice).toContainText('导出成功：export_', { timeout: 30_000 });

    // 偏离导出落盘：新整集版本对应 v<N> 文件，时长集合 [1,1,1,15,15,15]。
    const deviationPath = path.join(
      exportDir,
      `export_${seeded.projectId}_${baseline.episodeId}_v${String(deviationSetup.versionNo)}.json`,
    );
    const deviationEnvelope = JSON.parse(await readFile(deviationPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const deviationShots = deviationEnvelope.shot_contracts as Readonly<Record<string, unknown>>[];
    expect(deviationShots.map((shot) => shot.target_duration_sec)).toEqual([1, 1, 1, 15, 15, 15]);
    // 剧集目标时长是剧本事实（90），不随 Σ 偏离改写。
    expect(deviationEnvelope.target_duration_sec).toBe(90);
  } finally {
    await application.close();
  }
  try {
    // 关进程释放库句柄后子进程只读断言审计行（node:sqlite 限制同 media-evidence）。
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-storyboard-export.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    console.log(stdout.trim());
    expect(stdout).toContain('STORYBOARD_EXPORT_AUDIT_OK');
    expect(stdout).toContain('"rows":3');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
