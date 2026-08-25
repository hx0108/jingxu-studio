import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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

const execFileAsync = promisify(execFile);

const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

/**
 * 导出经 JINGXU_E2E_EXPORT_DIR 免 Save Dialog 定名落盘；导入经 JINGXU_E2E_IMPORT_FILE
 * 免 Open Dialog（sink 每次现读该文件，spec 可在多次导入之间改写内容）。
 * 取消（用户关对话框）在免对话框注入下不可达——由 4.1 组合根单测与 2.2 服务单测覆盖。
 */
const launch = async (
  managedRoot: string,
  exportDir: string,
  importFile: string,
): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: exportDir,
      JINGXU_E2E_IMPORT_FILE: importFile,
    },
  });

/** 重载后从项目列表走真实入口进分镜工作台（复用既有 E2E 驱动路径）。 */
const openStoryboard = async (page: Page, projectName: string): Promise<void> => {
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

test('项目快照导出导入—幂等重放/覆盖确认/NEW_PROJECT/RTO/冲突/零残留/路径红线（project-transfer）', async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-project-transfer-'));
  const managedRoot = path.join(root, 'managed');
  const exportDir = path.join(root, 'exports');
  const importFile = path.join(root, 'incoming', 'bundle.json');
  await mkdir(path.dirname(importFile), { recursive: true });
  let bundlePath = '';
  const application = await launch(managedRoot, exportDir, importFile);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '项目快照闭环');
    expect(seeded.shotCount).toBe(6);

    // 基线事实：READY v1；transfer 面板恰两方法（白名单）。
    const baseline = await page.evaluate(async (projectId: string) => {
      const fetched = await window.jingxu.script.getWorkspace({ projectId });
      if (!fetched.ok) throw new Error(fetched.error.code);
      const current = fetched.data.storyboard.current;
      if (current?.status !== 'READY') throw new Error('baseline:not-ready');
      return {
        episodeId: fetched.data.episode.id,
        transferKeys: Object.keys(window.jingxu.transfer).sort(),
        versionId: current.id,
        versionNo: current.versionNo,
      };
    }, seeded.projectId);
    expect(baseline.transferKeys).toEqual(['exportProject', 'importProject']);

    // ---- 数据通路（首导 + 同 requestId 幂等重放）：回执 4 键无路径；落盘 1.0.0 Bundle 哈希复核。 ----
    bundlePath = path.join(exportDir, `project-transfer-${seeded.projectId}.json`);
    const firstExport = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const input = {
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          overwriteConfirmed: false,
          projectId: context.projectId,
          requestId: `transfer_export_${crypto.randomUUID()}`,
        };
        const first = await window.jingxu.transfer.exportProject(input);
        if (!first.ok) throw new Error(`export:${first.error.code}`);
        const replayed = await window.jingxu.transfer.exportProject(input);
        if (!replayed.ok) throw new Error(`replay:${replayed.error.code}`);
        return { first: first.data, replay: replayed.data };
      },
      { episodeId: baseline.episodeId, projectId: seeded.projectId, versionId: baseline.versionId },
    );
    // 路径红线：导出回执字段恰为 4 键（byteSize/exportId/fileSha256/warningCodes）。
    expect(Object.keys(firstExport.first).sort()).toEqual([
      'byteSize',
      'exportId',
      'fileSha256',
      'warningCodes',
    ]);
    expect(firstExport.first.warningCodes).toContain('TRANSFER_CURRENT_ONLY');
    expect(firstExport.replay.exportId).toBe(firstExport.first.exportId);
    expect(firstExport.replay.fileSha256).toBe(firstExport.first.fileSha256);
    const bundleRaw = await readFile(bundlePath, 'utf8');
    const bundleBytes = Buffer.from(bundleRaw, 'utf8');
    expect(createHash('sha256').update(bundleBytes).digest('hex')).toBe(
      firstExport.first.fileSha256,
    );
    expect(bundleBytes.byteLength).toBe(firstExport.first.byteSize);
    const bundle = JSON.parse(bundleRaw) as Record<string, unknown>;
    // ProjectTransferBundle 1.0.0 顶层恰 7 键。
    expect(Object.keys(bundle).sort()).toEqual([
      'bundle_id',
      'episode_storyboard',
      'exported_at',
      'project_snapshot',
      'schema_version',
      'script_stage_outputs',
      'story_bible',
    ]);
    expect(bundle.schema_version).toBe('1.0.0');
    expect((bundle.project_snapshot as Record<string, unknown>).project_id).toBe(seeded.projectId);
    expect((bundle.episode_storyboard as Record<string, unknown>).shot_contracts).toHaveLength(6);

    // ---- 数据通路（版本头冲突）：expectedVersionId 过期 → SCRIPT_VERSION_CONFLICT，无新文件。 ----
    const stale = await page.evaluate(
      async (context: { episodeId: string; projectId: string }) => {
        const result = await window.jingxu.transfer.exportProject({
          episodeId: context.episodeId,
          expectedVersionId: 'ev_stale_baseline',
          overwriteConfirmed: false,
          projectId: context.projectId,
          requestId: `transfer_export_${crypto.randomUUID()}`,
        });
        return result.ok ? 'UNEXPECTED_OK' : result.error.code;
      },
      { episodeId: baseline.episodeId, projectId: seeded.projectId },
    );
    expect(stale).toBe('SCRIPT_VERSION_CONFLICT');

    // ---- 数据通路（refused → 同 requestId 显式覆盖）：默认拒覆盖；确认后重写成功。 ----
    const overwrite = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const base = {
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          projectId: context.projectId,
          requestId: `transfer_export_${crypto.randomUUID()}`,
        };
        const refused = await window.jingxu.transfer.exportProject({
          ...base,
          overwriteConfirmed: false,
        });
        if (refused.ok) throw new Error('refused:unexpected-ok');
        const written = await window.jingxu.transfer.exportProject({
          ...base,
          overwriteConfirmed: true,
        });
        if (!written.ok) throw new Error(`overwrite:${written.error.code}`);
        return {
          retryable: refused.error.retryable,
          userAction: refused.error.userAction,
          writtenId: written.data.exportId,
        };
      },
      { episodeId: baseline.episodeId, projectId: seeded.projectId, versionId: baseline.versionId },
    );
    expect(overwrite.retryable).toBe(false);
    expect(overwrite.userAction).toContain('覆盖');
    expect(overwrite.writtenId).not.toBe(firstExport.first.exportId);
    // 原子写入无 .tmp 残留；目录恰一个快照文件。
    expect(await readdir(exportDir)).toEqual([path.basename(bundlePath)]);

    // ---- UI 通路（导出）：目标已存在 → confirm 覆盖 → 通知只含 exportId/哈希尾/字节，无路径。 ----
    await page.reload();
    await openStoryboard(page, '项目快照闭环');
    const dialogMessages: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.accept();
    });
    await page.locator('button[name="export-project-snapshot"]').click();
    const snapshotNotice = page.locator('p[role="status"]', { hasText: '项目快照已导出' });
    await expect(snapshotNotice).toContainText('export_', { timeout: 30_000 });
    const noticeText = (await snapshotNotice.textContent()) ?? '';
    expect(noticeText).not.toContain('.json');
    expect(noticeText).not.toContain(exportDir);
    expect(dialogMessages.length).toBe(1);
    expect(dialogMessages.join('|')).toContain('目标文件已存在');

    // 后续导入统一以最新落盘内容为基线。
    const pristine = await readFile(bundlePath);

    // ---- 数据通路（NEW_PROJECT 导入 + 幂等重放）：回执 5 键；ID 全新、来源指向原项目。 ----
    await writeFile(importFile, pristine);
    const importRequestId = `transfer_import_${randomUUID()}`;
    const imported = await page.evaluate(async (requestId: string) => {
      const first = await window.jingxu.transfer.importProject({
        importMode: 'NEW_PROJECT',
        requestId,
      });
      if (!first.ok) throw new Error(`import:${first.error.code}`);
      const replayed = await window.jingxu.transfer.importProject({
        importMode: 'NEW_PROJECT',
        requestId,
      });
      if (!replayed.ok) throw new Error(`import-replay:${replayed.error.code}`);
      return { first: first.data, replay: replayed.data };
    }, importRequestId);
    // 路径红线：导入回执字段恰为 5 键。
    expect(Object.keys(imported.first).sort()).toEqual([
      'createdObjectCount',
      'importId',
      'projectId',
      'sourceProjectId',
      'warningCodes',
    ]);
    expect(imported.first.sourceProjectId).toBe(seeded.projectId);
    expect(imported.first.projectId).not.toBe(seeded.projectId);
    expect(imported.first.warningCodes).toContain('TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE');
    expect(imported.first.createdObjectCount).toBeGreaterThanOrEqual(20);
    expect(imported.replay.importId).toBe(imported.first.importId);
    expect(imported.replay.projectId).toBe(imported.first.projectId);

    // 同 requestId + 载荷漂移（同名改写）→ TRANSFER_IDEMPOTENCY_CONFLICT。
    const drifted = JSON.parse(bundleRaw) as Record<string, unknown>;
    (drifted.project_snapshot as Record<string, unknown>).name = '幂等冲突探针';
    await writeFile(importFile, JSON.stringify(drifted), 'utf8');
    const idempotency = await page.evaluate(async (requestId: string) => {
      const result = await window.jingxu.transfer.importProject({
        importMode: 'NEW_PROJECT',
        requestId,
      });
      return result.ok ? 'UNEXPECTED_OK' : result.error.code;
    }, importRequestId);
    expect(idempotency).toBe('TRANSFER_IDEMPOTENCY_CONFLICT');

    // ---- 损坏 JSON → TRANSFER_BUNDLE_INVALID（不落有效数据，仅 FAILED 记录）。 ----
    await writeFile(importFile, '这不是 JSON {{{', 'utf8');
    const corrupt = await page.evaluate(async () => {
      const result = await window.jingxu.transfer.importProject({
        importMode: 'NEW_PROJECT',
        requestId: `transfer_import_${crypto.randomUUID()}`,
      });
      return result.ok ? 'UNEXPECTED_OK' : result.error.code;
    });
    expect(corrupt).toBe('TRANSFER_BUNDLE_INVALID');

    // ---- 引用错误：storyboard.project_id 与 snapshot 不同源 → TRANSFER_REFERENCE_INVALID。 ----
    const mismatched = JSON.parse(bundleRaw) as Record<string, unknown>;
    (mismatched.episode_storyboard as Record<string, unknown>).project_id = 'project_other_origin';
    await writeFile(importFile, JSON.stringify(mismatched), 'utf8');
    const reference = await page.evaluate(async () => {
      const result = await window.jingxu.transfer.importProject({
        importMode: 'NEW_PROJECT',
        requestId: `transfer_import_${crypto.randomUUID()}`,
      });
      return result.ok ? 'UNEXPECTED_OK' : result.error.code;
    });
    expect(reference).toBe('TRANSFER_REFERENCE_INVALID');

    // ---- RETURN_TO_ORIGIN 成功：追加新整集版本（v2 READY），不改历史。 ----
    await writeFile(importFile, pristine);
    const restored = await page.evaluate(
      async (context: { projectId: string; versionId: string }) => {
        const result = await window.jingxu.transfer.importProject({
          importMode: 'RETURN_TO_ORIGIN',
          requestId: `transfer_import_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(`restore:${result.error.code}`);
        const after = await window.jingxu.script.getWorkspace({ projectId: context.projectId });
        if (!after.ok) throw new Error(after.error.code);
        const current = after.data.storyboard.current;
        return {
          currentId: current?.id ?? null,
          result: result.data,
          status: current?.status ?? null,
          versionNo: current?.versionNo ?? null,
        };
      },
      { projectId: seeded.projectId, versionId: baseline.versionId },
    );
    expect(restored.result.projectId).toBe(seeded.projectId);
    expect(restored.result.warningCodes).toEqual(['TRANSFER_CURRENT_ONLY']);
    expect(restored.versionNo).toBe(baseline.versionNo + 1);
    expect(restored.status).toBe('READY');
    expect(restored.currentId).not.toBe(baseline.versionId);

    // ---- 改名后 RTO → TRANSFER_PROJECT_CONFLICT（快照基线名 ≠ 当前名）。 ----
    const renamed = await page.evaluate(async (projectId: string) => {
      const fetched = await window.jingxu.project.get({ projectId, scope: 'ACTIVE' });
      if (!fetched.ok) throw new Error(fetched.error.code);
      const detail = fetched.data;
      const profile = detail.currentFormatProfile;
      const updated = await window.jingxu.project.update({
        aspectRatio: profile.aspectRatio,
        dialogueRenderMode: detail.dialogueRenderMode,
        expectedUpdatedAt: detail.updatedAt,
        genre: detail.genre,
        name: '改名后的项目',
        projectId,
        requestId: `project_${crypto.randomUUID()}`,
        style: detail.style,
        subtitleSafeArea: profile.subtitleSafeArea,
      });
      return updated.ok ? updated.data.name : `ERR:${updated.error.code}`;
    }, seeded.projectId);
    expect(renamed).toBe('改名后的项目');
    const conflict = await page.evaluate(async () => {
      const result = await window.jingxu.transfer.importProject({
        importMode: 'RETURN_TO_ORIGIN',
        requestId: `transfer_import_${crypto.randomUUID()}`,
      });
      return result.ok ? 'UNEXPECTED_OK' : result.error.code;
    });
    expect(conflict).toBe('TRANSFER_PROJECT_CONFLICT');

    // ---- UI 通路（导入 NEW_PROJECT）：通知无路径 + 列表刷新出新项目。 ----
    await writeFile(importFile, pristine);
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await page.locator('button[name="import-project-snapshot"]').click();
    const importNotice = page.locator('p[role="status"]', { hasText: '快照已导入为新项目' });
    await expect(importNotice).toContainText('个对象', { timeout: 30_000 });
    const importNoticeText = (await importNotice.textContent()) ?? '';
    expect(importNoticeText).not.toContain('.json');
    expect(importNoticeText).not.toContain(importFile);
    // 原项目已改名；两次 NEW_PROJECT 导入 → 两张同名（或后缀变体）项目卡。
    await expect(page.locator('.project-card-main', { hasText: '项目快照闭环' })).toHaveCount(2);
  } finally {
    await application.close();
  }
  try {
    // 落盘终检：无 .tmp 残留。
    expect(await readdir(exportDir)).toEqual([path.basename(bundlePath)]);
    // 关进程释放库句柄后子进程只读断言记录/审计/零残留（node:sqlite 限制同 storyboard-export）。
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-transfer-audit.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    console.log(stdout.trim());
    expect(stdout).toContain('TRANSFER_AUDIT_OK');
    expect(stdout).toContain('"exportRows":3');
    expect(stdout).toContain('"importSucceeded":3');
    expect(stdout).toContain('"importFailed":4');
    expect(stdout).toContain('"projects":3');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
