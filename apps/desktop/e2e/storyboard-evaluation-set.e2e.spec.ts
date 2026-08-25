import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

import { seedStoryboardReady } from './support/storyboard-seeding';

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(__dirname, '..');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
    ),
  );

const launch = async (managedRoot: string, importFile: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EVALUATION_IMPORT_FILE: importFile,
    },
  });

test('评测集—种子/九类规则/创建派生导入标注删除/路径红线（storyboard-evaluation-set）', async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-evaluation-'));
  const managedRoot = path.join(root, 'managed');
  const importFile = path.join(root, 'incoming', 'evaluation.json');
  await mkdir(path.dirname(importFile), { recursive: true });
  const application = await launch(managedRoot, importFile);
  try {
    const page = await application.firstWindow();
    const seeded = await seedStoryboardReady(page, '评测集闭环');
    expect(seeded.shotCount).toBe(6);

    const baseline = await page.evaluate(async (projectId: string) => {
      const workspace = await window.jingxu.script.getWorkspace({ projectId });
      if (!workspace.ok || workspace.data.storyboard.current === null) {
        throw new Error(workspace.ok ? 'missing-ready-storyboard' : workspace.error.code);
      }
      const first = workspace.data.storyboard.shots[0];
      if (first === undefined) throw new Error('missing-shot');
      return {
        document: first.document,
        episodeId: workspace.data.episode.id,
        evaluationKeys: Object.keys(window.jingxu.evaluation).sort(),
        episodeVersionId: workspace.data.storyboard.current.id,
      };
    }, seeded.projectId);
    expect(baseline.evaluationKeys).toEqual([
      'addAnnotation',
      'createFromEpisode',
      'createSample',
      'deleteSample',
      'getSample',
      'importBatch',
      'listSamples',
    ]);

    const manual = await page.evaluate(
      async (context: { document: Record<string, unknown>; projectId: string }) => {
        const input = {
          authorization: 'SYNTHETIC' as const,
          datasetSplit: 'TRAIN' as const,
          dedupKey: 'e2e-evaluation-manual-001',
          expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
          input: {
            candidate: { document: context.document, kind: 'SHOT_CONTRACT' as const },
            context: {
              characters: [],
              dialogueRenderMode: 'NARRATION_FIRST' as const,
              previousShotSummary: null,
              scenes: [],
              targetDurationSec: 90,
            },
          },
          projectId: context.projectId,
        };
        const created = await window.jingxu.evaluation.createSample(input);
        const duplicate = await window.jingxu.evaluation.createSample(input);
        return { created, duplicate };
      },
      { document: baseline.document, projectId: seeded.projectId },
    );
    expect(manual.created.ok).toBe(true);
    expect(manual.duplicate).toMatchObject({
      error: { code: 'EVALUATION_DEDUP_CONFLICT' },
      ok: false,
    });
    if (!manual.created.ok) throw new Error(manual.created.error.code);

    // READY 门禁：恢复会创建新的当前 DRAFT；派生必须拒绝，重新确认后才能继续。
    const readiness = await page.evaluate(
      async (context: { episodeId: string; projectId: string; versionId: string }) => {
        const restored = await window.jingxu.script.restoreVersion({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          projectId: context.projectId,
          requestId: `evaluation_restore_${crypto.randomUUID()}`,
          stage: 'SHOT_CONTRACT',
          versionId: context.versionId,
        });
        if (!restored.ok) return { restored };
        const rejected = await window.jingxu.evaluation.createFromEpisode({
          authorization: 'SYNTHETIC',
          datasetSplit: 'VALIDATION',
          expectedVersionId: restored.data.id,
          projectId: context.projectId,
          requestId: `evaluation_draft_${crypto.randomUUID()}`,
        });
        const confirmed = await window.jingxu.script.confirmVersion({
          episodeId: context.episodeId,
          expectedVersionId: restored.data.id,
          projectId: context.projectId,
          requestId: `evaluation_reconfirm_${crypto.randomUUID()}`,
          stage: 'SHOT_CONTRACT',
          versionId: restored.data.id,
        });
        if (!confirmed.ok) throw new Error(confirmed.error.code);
        return { confirmedVersionId: confirmed.data.id, rejected, restored };
      },
      {
        episodeId: baseline.episodeId,
        projectId: seeded.projectId,
        versionId: baseline.episodeVersionId,
      },
    );
    expect(readiness.restored.ok).toBe(true);
    expect(readiness.rejected).toMatchObject({
      error: { code: 'EVALUATION_DERIVE_NOT_READY' },
      ok: false,
    });
    const confirmedVersionId = readiness.confirmedVersionId ?? '';
    expect(confirmedVersionId).not.toBe('');

    const derived = await page.evaluate(
      async (context: { projectId: string; versionId: string }) =>
        window.jingxu.evaluation.createFromEpisode({
          authorization: 'SYNTHETIC',
          datasetSplit: 'VALIDATION',
          expectedVersionId: context.versionId,
          projectId: context.projectId,
          requestId: `evaluation_derive_${crypto.randomUUID()}`,
        }),
      { projectId: seeded.projectId, versionId: confirmedVersionId },
    );
    if (!derived.ok) throw new Error(`derive:${derived.error.code}`);
    expect(derived.data.samples).toHaveLength(6);

    await writeFile(
      importFile,
      JSON.stringify({
        samples: [
          {
            authorization: 'SYNTHETIC',
            datasetSplit: 'TEST',
            dedupKey: 'e2e-evaluation-import-001',
            expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
            input: {
              candidate: { document: baseline.document, kind: 'SHOT_CONTRACT' },
              context: { dialogueRenderMode: 'NARRATION_FIRST', targetDurationSec: 90 },
            },
            projectId: seeded.projectId,
          },
          {
            authorization: 'SYNTHETIC',
            datasetSplit: 'TRAIN',
            dedupKey: 'e2e-evaluation-manual-001',
            expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
            input: {
              candidate: { document: baseline.document, kind: 'SHOT_CONTRACT' },
              context: {},
            },
          },
          { dedupKey: 'bad' },
        ],
        version: 1,
      }),
    );
    const imported = await page.evaluate(async () =>
      window.jingxu.evaluation.importBatch({
        requestId: `evaluation_import_${crypto.randomUUID()}`,
      }),
    );
    expect(imported.ok).toBe(true);
    if (imported.ok)
      expect(imported.data.items.map((item) => item.status)).toEqual([
        'CREATED',
        'DUPLICATE',
        'REJECTED',
      ]);

    // 文件级损坏必须在 staging 被拦截，不能留下一条半成品样本。
    const beforeInvalidImport = await page.evaluate(async () =>
      window.jingxu.evaluation.listSamples({ scope: 'ALL' }),
    );
    expect(beforeInvalidImport.ok).toBe(true);
    await writeFile(importFile, '{ invalid-json');
    const invalidImport = await page.evaluate(async () =>
      window.jingxu.evaluation.importBatch({
        requestId: `evaluation_invalid_import_${crypto.randomUUID()}`,
      }),
    );
    expect(invalidImport).toMatchObject({
      error: { code: 'EVALUATION_IMPORT_INVALID' },
      ok: false,
    });
    const afterInvalidImport = await page.evaluate(async () =>
      window.jingxu.evaluation.listSamples({ scope: 'ALL' }),
    );
    expect(afterInvalidImport.ok).toBe(true);
    if (beforeInvalidImport.ok && afterInvalidImport.ok) {
      expect(afterInvalidImport.data.samples).toHaveLength(beforeInvalidImport.data.samples.length);
    }

    const annotated = await page.evaluate(async (sampleId: string) => {
      const added = await window.jingxu.evaluation.addAnnotation({
        annotator: 'E2E_USER',
        guidelineVersion: 'jingxu-annotation-guideline/1',
        label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
        rationale: '离线 E2E 对可接受样本的追加式标注。',
        requestId: `evaluation_annotation_${crypto.randomUUID()}`,
        sampleId,
      });
      const detail = await window.jingxu.evaluation.getSample({ sampleId });
      return { added, detail };
    }, manual.created.data.sampleId);
    expect(annotated.added.ok).toBe(true);
    expect(annotated.detail).toMatchObject({
      data: { annotations: [expect.any(Object)] },
      ok: true,
    });

    // UI 双入口：项目详情按钮与全局导航均可达；提示文本不含本地路径。
    await page
      .locator('nav[aria-label="全局导航"]')
      .getByRole('button', { name: '我的项目', exact: true })
      .click();
    await page.locator('.project-card-main', { hasText: '评测集闭环' }).click();
    await page.getByRole('button', { name: '当前项目评测集' }).click();
    await expect(page.getByRole('heading', { name: '结构化分镜评测集' })).toBeVisible();
    await expect(page.getByText('样本列表')).toBeVisible();
    await page.getByRole('button', { name: '全部样本' }).click();
    await expect(page.getByText(/样本列表（\d+）/u)).toBeVisible();
    const surface = await page.evaluate(() => JSON.stringify(window.jingxu.evaluation));
    expect(surface).not.toContain(importFile);
    expect(surface).not.toContain('sqlite');

    const deleted = await page.evaluate(
      async (sampleId: string) =>
        window.jingxu.evaluation.deleteSample({
          requestId: `evaluation_delete_${crypto.randomUUID()}`,
          sampleId,
        }),
      manual.created.data.sampleId,
    );
    expect(deleted.ok).toBe(true);
  } finally {
    await application.close();
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(__dirname, 'support', 'verify-evaluation-audit.mjs'),
      '--db',
      path.join(managedRoot, 'data', 'jingxu.sqlite'),
    ]);
    expect(stdout).toContain('EVALUATION_AUDIT_OK');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
