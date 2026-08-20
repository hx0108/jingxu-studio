import { execFile } from 'node:child_process';
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
  await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
  await page.locator('.project-card-main', { hasText: projectName }).click();
  await page.getByRole('button', { name: '进入剧本工作区' }).click();
  await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
};

test('分镜交付物—Markdown 分镜表/可生产性报告/正脸长对白 WARN/审计 format/路径红线（deliverables）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-deliverables-'));
  const managedRoot = path.join(root, 'managed');
  const exportDir = path.join(root, 'exports');
  await mkdir(exportDir, { recursive: true });
  const application = await launch(managedRoot, exportDir);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '分镜交付物闭环');
    expect(seeded.shotCount).toBe(6);

    // 基线事实：READY v1、6 镜 × 15s（Σ=90 软带内）；Mock 对白全部 3s ≤ 4（无 WARN 基线）。
    const baseline = await page.evaluate(async (projectId: string) => {
      const fetched = await window.jingxu.script.getWorkspace({ projectId });
      if (!fetched.ok) throw new Error(fetched.error.code);
      const storyboard = fetched.data.storyboard;
      if (storyboard.current?.status !== 'READY') throw new Error('baseline:not-ready');
      return {
        durationSum: storyboard.shots.reduce(
          (sum, shot) => sum + Number(shot.document.target_duration_sec ?? 0),
          0,
        ),
        episodeId: fetched.data.episode.id,
        speechDurations: storyboard.shots.map(
          (shot) =>
            (shot.document.dialogue as Record<string, unknown> | undefined)
              ?.estimated_speech_duration_sec,
        ),
        versionNo: storyboard.current.versionNo,
        versionId: storyboard.current.id,
      };
    }, seeded.projectId);
    expect(baseline.durationSum).toBe(90);
    expect(baseline.speechDurations).toEqual([3, 3, 0, 3, 3, 0]);

    // ---- 数据通路 v1：分镜表 .md（9 列表头/6 数据行/Σ=90/版本事实）+ 报告 .md（无 WARN）。 ----
    const markdownExport = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const result = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          format: 'MARKDOWN_TABLE',
          projectId: context.projectId,
          requestId: `export_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.data;
      },
      {
        episodeId: baseline.episodeId,
        projectId: seeded.projectId,
        versionId: baseline.versionId,
      },
    );
    // 回执五键格式无关（路径红线不因交付物形态松动）。
    expect(Object.keys(markdownExport).sort()).toEqual([
      'byteSize',
      'episodeVersionId',
      'exportId',
      'fileSha256',
      'totalDurationSec',
    ]);
    expect(markdownExport.totalDurationSec).toBe(90);

    const tablePath = path.join(
      exportDir,
      `storyboard_${seeded.projectId}_${baseline.episodeId}_v${String(baseline.versionNo)}.md`,
    );
    const table = await readFile(tablePath, 'utf8');
    expect(table).toContain(`# 分镜表：${seeded.projectId}/${baseline.episodeId}`);
    expect(table).toContain(
      '| 镜头号 | 景别 | 运镜 | 时长(s) | 叙事目的 | 台词/旁白 | 角色 | 场景 | 锁定 |',
    );
    expect(table).toContain('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    // 6 条数据行逐镜头一行；#1 有台词/角色/场景，#3 为空镜（空单元格如实呈现）。
    expect(table.match(/^\| #/gmu)).toHaveLength(6);
    expect(table).toContain('| #1 | MEDIUM | STATIC | 15 |');
    expect(table).toContain('这趟列车，到底要开去哪里？');
    expect(table).toContain('char_lead');
    expect(table).toContain('scene_train');
    expect(table).toContain('| #3 | LONG |');
    expect(table).toContain(`- 整集版本：v${String(baseline.versionNo)}`);
    expect(table).toContain('- 镜头时长合计：90s（软带 60–120s）');
    expect(table).toContain(`- 导出 ID：${markdownExport.exportId}`);
    expect(Buffer.byteLength(table, 'utf8')).toBe(markdownExport.byteSize);

    const reportExport = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const result = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          format: 'PRODUCIBILITY_REPORT',
          projectId: context.projectId,
          requestId: `export_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.data;
      },
      {
        episodeId: baseline.episodeId,
        projectId: seeded.projectId,
        versionId: baseline.versionId,
      },
    );
    const reportPath = path.join(
      exportDir,
      `report_${seeded.projectId}_${baseline.episodeId}_v${String(baseline.versionNo)}.md`,
    );
    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain(`# 可生产性报告：${seeded.projectId}/${baseline.episodeId}`);
    expect(report).toContain('## 头部事实');
    expect(report).toContain('- 画幅：9:16 · ');
    expect(report).toContain('- 可生产性规则版本：jingxu-producibility-rules/1');
    expect(report).toContain('- 偏离确认：无（Σ 在软带内）');
    expect(report).toContain('- contains_ai_assisted_content：true');
    expect(report).toContain('- AI 参与镜头：6/6');
    expect(report).toContain(
      '- 判定式：frontal_face=true 且 mouth_visible=true 且 estimated_speech_duration_sec > 4',
    );
    expect(report).toContain('- WARN：无命中（全部镜头对白时长 ≤ 4s）');
    expect(report.match(/^- WARN #/gmu)?.length).toBeFalsy();
    expect(report).toContain('| 镜头号 | shot_id | 时长(s) | 对白时长(s) | 渲染模式 |');
    expect(report).toContain(`- 导出 ID：${reportExport.exportId}`);

    // ---- 编辑镜头 #1 对白 3→5（frontal+mouth 均真）→ 重确认 v2 → 报告命中单条 WARN。 ----
    const warnSetup = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const fetched = await window.jingxu.script.getWorkspace({ projectId: context.projectId });
        if (!fetched.ok) throw new Error(fetched.error.code);
        const shot = fetched.data.storyboard.shots.find((candidate) => candidate.sequence === 1);
        if (shot === undefined) throw new Error('missing-shot-1');
        const document = shot.document;
        const dialogue = document.dialogue as Record<string, unknown>;
        dialogue.estimated_speech_duration_sec = 5;
        const edited = await window.jingxu.storyboard.editShot({
          document,
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          projectId: context.projectId,
          requestId: `edit_${crypto.randomUUID()}`,
          shotId: shot.shotId,
          shotVersionId: shot.versionId,
        });
        if (!edited.ok) throw new Error(`edit:${edited.error.code}`);
        const confirmed = await window.jingxu.script.confirmVersion({
          episodeId: context.episodeId,
          expectedVersionId: edited.data.episode.id,
          projectId: context.projectId,
          requestId: `confirm_${crypto.randomUUID()}`,
          stage: 'SHOT_CONTRACT',
          versionId: edited.data.episode.id,
        });
        if (!confirmed.ok) throw new Error(`confirm:${confirmed.error.code}`);
        // confirm 产生新 READY 版本（id 不同于 editShot 的 DRAFT）：重取 current 再导出。
        const afterConfirm = await window.jingxu.script.getWorkspace({
          projectId: context.projectId,
        });
        if (!afterConfirm.ok) throw new Error(afterConfirm.error.code);
        const current = afterConfirm.data.storyboard.current;
        if (current?.status !== 'READY') throw new Error('after-confirm:not-ready');
        return { versionId: current.id, versionNo: current.versionNo };
      },
      { episodeId: baseline.episodeId, projectId: seeded.projectId, versionId: baseline.versionId },
    );

    await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const result = await window.jingxu.storyboard.exportEpisode({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          format: 'PRODUCIBILITY_REPORT',
          projectId: context.projectId,
          requestId: `export_${crypto.randomUUID()}`,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.data;
      },
      {
        episodeId: baseline.episodeId,
        projectId: seeded.projectId,
        versionId: warnSetup.versionId,
      },
    );
    const warnReportPath = path.join(
      exportDir,
      `report_${seeded.projectId}_${baseline.episodeId}_v${String(warnSetup.versionNo)}.md`,
    );
    const warnReportText = await readFile(warnReportPath, 'utf8');
    // PRD 9.5：正脸长对白 5s > 4s 命中单条 WARN（风险提示非阻断，导出照常成功）。
    expect(warnReportText).toMatch(
      /^- WARN #1（shot_[A-Za-z0-9_-]+）：正脸长对白 5s > 4s（WEAK_LIP_SYNC 风险）$/mu,
    );
    expect(warnReportText.match(/^- WARN #/gmu)).toHaveLength(1);
    expect(warnReportText).not.toContain('- WARN：无命中');

    // ---- UI 通路 v2：三入口并列，点「导出分镜表」→ 成功通知无路径。 ----
    await page.reload();
    await openStoryboard(page, '分镜交付物闭环');
    await expect(page.locator('button[name="export-episode"]')).toBeVisible();
    await expect(page.locator('button[name="export-episode-report"]')).toBeVisible();
    await page.locator('button[name="export-episode-markdown"]').click();
    const notice = page.locator('.script-workspace p[role="status"]');
    await expect(notice).toContainText('导出成功：export_', { timeout: 30_000 });
    await expect(notice).toContainText('sha256 …');
    const noticeText = (await notice.textContent()) ?? '';
    expect(noticeText).not.toContain('.md');
    expect(noticeText).not.toContain(exportDir);

    // 落盘清单恰为四个交付物（v1 分镜表/报告 + v2 报告/UI 分镜表），无 JSON 泄漏。
    expect((await readdir(exportDir)).sort()).toEqual(
      [
        `report_${seeded.projectId}_${baseline.episodeId}_v${String(baseline.versionNo)}.md`,
        `report_${seeded.projectId}_${baseline.episodeId}_v${String(warnSetup.versionNo)}.md`,
        `storyboard_${seeded.projectId}_${baseline.episodeId}_v${String(baseline.versionNo)}.md`,
        `storyboard_${seeded.projectId}_${baseline.episodeId}_v${String(warnSetup.versionNo)}.md`,
      ].sort(),
    );
  } finally {
    await application.close();
  }
  try {
    // 关进程释放库句柄后子进程只读断言审计行（node:sqlite 限制同 storyboard-export）。
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-storyboard-deliverables.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    console.log(stdout.trim());
    expect(stdout).toContain('STORYBOARD_DELIVERABLES_AUDIT_OK');
    expect(stdout).toContain('"rows":4');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
