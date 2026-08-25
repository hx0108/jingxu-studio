import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { seedStoryboardReady } from './support/storyboard-seeding';

const desktopRoot = path.resolve(__dirname, '..');
const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
const launch = async (
  managedRoot: string,
  evidenceRoot: string,
  scriptImportFile?: string,
  transferImportFile?: string,
  failureScenario?: string,
): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      JINGXU_E2E_EXPORT_DIR: evidenceRoot,
      ...(scriptImportFile === undefined
        ? {}
        : { JINGXU_E2E_SCRIPT_IMPORT_FILE: scriptImportFile }),
      ...(transferImportFile === undefined ? {} : { JINGXU_E2E_IMPORT_FILE: transferImportFile }),
      ...(failureScenario === undefined ? {} : { JINGXU_E2E_FAILURE_SCENARIO: failureScenario }),
    },
  });
const createProject = async (page: Page, name: string): Promise<string> => {
  const result = await page.evaluate(
    (projectName) =>
      window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: projectName,
        requestId: `project_${crypto.randomUUID()}`,
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      }),
    name,
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.data.id;
};
const evidence = async (root: string, name: string, value: unknown): Promise<void> =>
  writeFile(path.join(root, `${name}.json`), JSON.stringify(value, null, 2), 'utf8');
const withApp = async (
  callback: (page: Page, root: string) => Promise<void>,
  scriptImportFile?: string,
  transferImportFile?: string,
  failureScenario?: string,
): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-v1-acceptance-'));
  const managed = path.join(root, 'managed');
  const exportRoot = path.join(root, 'evidence');
  await mkdir(exportRoot, { recursive: true });
  const application = await launch(
    managed,
    exportRoot,
    scriptImportFile,
    transferImportFile,
    failureScenario,
  );
  try {
    await callback(await application.firstWindow(), exportRoot);
  } finally {
    await application.close();
    const evidenceDirectory = process.env.JINGXU_E2E_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await cp(exportRoot, evidenceDirectory, { force: true, recursive: true });
    }
    if (process.env.JINGXU_KEEP_E2E_ARTIFACTS !== '1')
      await rm(root, { force: true, recursive: true });
  }
};

test('E2E-AC01-ORIGINAL—原创输入建立可追溯工作区', async () => {
  test.setTimeout(180_000);
  await withApp(async (page, root) => {
    const seeded = await seedStoryboardReady(page, 'AC01 原创验收');
    const workspace = await page.evaluate(
      (projectId) => window.jingxu.script.getWorkspace({ projectId }),
      seeded.projectId,
    );
    if (!workspace.ok || workspace.data.storyboard.current === null)
      throw new Error('ac01:missing-ready-storyboard');
    expect(workspace.data.source.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      Object.fromEntries(
        workspace.data.stages.map((stage) => [stage.stage, stage.current?.status]),
      ),
    ).toEqual({
      BEAT_SHEET: 'READY',
      CONCEPT: 'READY',
      EPISODE_OUTLINE: 'READY',
      SCENE_SCRIPT: 'READY',
      STORY_BIBLE: 'READY',
    });
    expect(workspace.data.storyboard.current.status).toBe('READY');
    expect(workspace.data.storyboard.shots).toHaveLength(seeded.shotCount);
    expect(seeded.shotCount).toBeGreaterThanOrEqual(6);
    expect(seeded.shotCount).toBeLessThanOrEqual(10);
    expect(workspace.data.storyboard.totalDurationSec).toBeGreaterThanOrEqual(60);
    expect(workspace.data.storyboard.totalDurationSec).toBeLessThanOrEqual(120);
    await evidence(root, 'E2E-AC01-ORIGINAL', workspace);
  });
});

test('E2E-AC02-LOCKED-REWRITE—Main 文件导入并保留原文', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-v1-input-'));
  const file = path.join(root, 'existing.md');
  await writeFile(file, '# 已有剧本\n林岚在站台等候列车。', 'utf8');
  try {
    await withApp(async (page, evidenceRoot) => {
      const projectId = await createProject(page, 'AC02 已有剧本');
      const imported = await page.evaluate(
        (id) =>
          window.jingxu.script.importInput({
            authorizationSource: null,
            authorizationStatement: null,
            creationMode: 'AI_OPTIMIZATION',
            dataProcessingConsent: true,
            projectId: id,
            requestId: `import_${crypto.randomUUID()}`,
          }),
        projectId,
      );
      if (!imported.ok) throw new Error(`import:${imported.error.code}:${imported.error.message}`);
      expect(imported).toMatchObject({
        ok: true,
        data: {
          projectId,
          source: { inputKind: 'MARKDOWN', fileName: 'existing.md', encoding: 'UTF-8' },
        },
      });
      const seeded = await seedStoryboardReady(page, 'AC02 选区改写', {
        authorizationSource: null,
        authorizationStatement: null,
        content: '# 原始剧本\n林岚在站台等待列车，决定在列车开走前说出真相。',
        creationMode: 'AI_OPTIMIZATION',
        fileName: 'source.md',
        inputKind: 'MARKDOWN',
      });
      const rewrite = await page.evaluate(async (projectId) => {
        const loaded = await window.jingxu.script.getWorkspace({ projectId });
        if (!loaded.ok) throw new Error(loaded.error.code);
        const outline = loaded.data.stages.find(
          (stage) => stage.stage === 'EPISODE_OUTLINE',
        )?.current;
        if (outline === null || outline === undefined) throw new Error('missing-outline');
        const lock = await window.jingxu.script.lockPath({
          action: 'LOCK',
          episodeId: loaded.data.episode.id,
          expectedVersionId: outline.id,
          jsonPointer: '/data/climax',
          note: 'AC02 关键剧情字段',
          objectType: 'SCRIPT_VERSION',
          projectId,
          requestId: `lock_${crypto.randomUUID()}`,
          stage: 'EPISODE_OUTLINE',
        });
        if (!lock.ok) throw new Error(`lock:${lock.error.code}`);
        const lockedRewrite = await window.jingxu.script.rewriteSelection({
          episodeId: loaded.data.episode.id,
          expectedVersionId: outline.id,
          operationType: 'STRENGTHEN_CONFLICT',
          projectId,
          requestId: `rewrite-locked_${crypto.randomUUID()}`,
          selection: ['/data/climax'],
          stage: 'EPISODE_OUTLINE',
          writeSet: ['/data/climax'],
        });
        const lockedWorkspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!lockedWorkspace.ok) throw new Error(lockedWorkspace.error.code);
        const lockedCurrent = lockedWorkspace.data.stages.find(
          (stage) => stage.stage === 'EPISODE_OUTLINE',
        )?.current;
        if (lockedCurrent === null || lockedCurrent === undefined)
          throw new Error('missing-locked-current');
        if (lockedRewrite.ok) throw new Error('locked-rewrite-unexpected-success');
        const unlocked = await window.jingxu.script.lockPath({
          action: 'UNLOCK',
          episodeId: loaded.data.episode.id,
          expectedVersionId: outline.id,
          jsonPointer: '/data/climax',
          note: null,
          objectType: 'SCRIPT_VERSION',
          projectId,
          requestId: `unlock_${crypto.randomUUID()}`,
          stage: 'EPISODE_OUTLINE',
        });
        if (!unlocked.ok) throw new Error(`unlock:${unlocked.error.code}`);
        const rewritten = await window.jingxu.script.rewriteSelection({
          episodeId: loaded.data.episode.id,
          expectedVersionId: outline.id,
          operationType: 'STRENGTHEN_CONFLICT',
          projectId,
          requestId: `rewrite_${crypto.randomUUID()}`,
          selection: ['/data/climax'],
          stage: 'EPISODE_OUTLINE',
          writeSet: ['/data/climax'],
        });
        if (!rewritten.ok) throw new Error(`rewrite:${rewritten.error.code}`);
        const stale = await window.jingxu.script.rewriteSelection({
          episodeId: loaded.data.episode.id,
          expectedVersionId: outline.id,
          operationType: 'STRENGTHEN_CONFLICT',
          projectId,
          requestId: `rewrite-stale_${crypto.randomUUID()}`,
          selection: ['/data/climax'],
          stage: 'EPISODE_OUTLINE',
          writeSet: ['/data/climax'],
        });
        const after = await window.jingxu.script.getWorkspace({ projectId });
        if (!after.ok) throw new Error(after.error.code);
        const current = after.data.stages.find(
          (stage) => stage.stage === 'EPISODE_OUTLINE',
        )?.current;
        if (current === null || current === undefined) throw new Error('missing-rewrite-current');
        return {
          afterHash: current.documentHash,
          afterValue: current.document.data.climax,
          beforeHash: outline.documentHash,
          beforeValue: outline.document.data.climax,
          parentId: current.parentId,
          sourceHash: after.data.source.contentHash,
          lock,
          lockedRewrite,
          lockedCurrentHash: lockedCurrent.documentHash,
          unlocked,
          stale,
        };
      }, seeded.projectId);
      expect(rewrite.parentId).not.toBeNull();
      expect(rewrite.lock).toMatchObject({ ok: true, data: { lockedPaths: ['/data/climax'] } });
      expect(rewrite.lockedRewrite).toMatchObject({
        ok: false,
        error: { code: 'SHOT_LOCK_CONFLICT' },
      });
      expect(rewrite.lockedCurrentHash).toBe(rewrite.beforeHash);
      expect(rewrite.unlocked).toMatchObject({ ok: true, data: { lockedPaths: [] } });
      expect(rewrite.afterHash).not.toBe(rewrite.beforeHash);
      expect(rewrite.afterValue).toContain('[STRENGTHEN_CONFLICT]');
      expect(rewrite.stale).toMatchObject({ ok: false, error: { code: 'STALE_INPUT' } });
      expect(rewrite.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
      await evidence(evidenceRoot, 'E2E-AC02-LOCKED-REWRITE', { imported, rewrite });
    }, file);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-AC03-EDIT-ROUNDTRIP—READY 分镜结构编辑与导出证据', async () => {
  test.setTimeout(240_000);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jingxu-v1-ac03-transfer-'));
  const importFile = path.join(temp, 'roundtrip.json');
  try {
    await withApp(
      async (page, root) => {
        const seeded = await seedStoryboardReady(page, 'AC03 分镜编辑');
        const result = await page.evaluate(async (projectId) => {
          const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
          const load = async (checkpoint: string) => {
            const loaded = await window.jingxu.script.getWorkspace({ projectId });
            if (!loaded.ok) throw new Error(`${checkpoint}:${loaded.error.code}`);
            const current = loaded.data.storyboard.current;
            if (current === null) throw new Error(`${checkpoint}:missing-current-storyboard`);
            return {
              ...loaded.data,
              storyboard: { ...loaded.data.storyboard, current },
            };
          };
          const initial = await load('initial');
          const initialVersionId = initial.storyboard.current.id;
          const originalShotId = initial.storyboard.shots[0]?.shotId;
          if (originalShotId === undefined) throw new Error('missing-original-shot');

          const split = await window.jingxu.storyboard.splitShot({
            episodeId: initial.episode.id,
            expectedVersionId: initialVersionId,
            projectId,
            requestId: requestId('split'),
            shotId: originalShotId,
          });
          if (!split.ok) throw new Error(`split:${split.error.code}`);
          const afterSplit = await load('after-split');
          const copiedSourceId = afterSplit.storyboard.shots[0]?.shotId;
          if (copiedSourceId === undefined) throw new Error('missing-split-shot');

          const copied = await window.jingxu.storyboard.copyShot({
            episodeId: afterSplit.episode.id,
            expectedVersionId: afterSplit.storyboard.current.id,
            projectId,
            requestId: requestId('copy'),
            shotId: copiedSourceId,
          });
          if (!copied.ok) throw new Error(`copy:${copied.error.code}`);
          const afterCopy = await load('after-copy');
          const mergeIds = afterCopy.storyboard.shots.slice(0, 2).map((shot) => shot.shotId);
          const firstMergeId = mergeIds[0];
          const secondMergeId = mergeIds[1];
          if (firstMergeId === undefined || secondMergeId === undefined)
            throw new Error('missing-merge-input');

          const merged = await window.jingxu.storyboard.mergeShots({
            episodeId: afterCopy.episode.id,
            expectedVersionId: afterCopy.storyboard.current.id,
            projectId,
            requestId: requestId('merge'),
            shotIds: [firstMergeId, secondMergeId],
          });
          if (!merged.ok) throw new Error(`merge:${merged.error.code}`);
          const afterMerge = await load('after-merge');
          // 保留 CONTINUOUS_ACTION 的 previous_shot 前序关系；排序命令仍须创建新集合版本。
          const orderedShotIds = afterMerge.storyboard.shots.map((shot) => shot.shotId);
          const reordered = await window.jingxu.storyboard.reorderShots({
            episodeId: afterMerge.episode.id,
            expectedVersionId: afterMerge.storyboard.current.id,
            orderedShotIds,
            projectId,
            requestId: requestId('reorder'),
          });
          if (!reordered.ok) throw new Error(`reorder:${reordered.error.code}`);
          const afterReorder = await load('after-reorder');
          const referenced = new Set(
            afterReorder.storyboard.shots
              .map(
                (shot) =>
                  ((shot.document.continuity as Record<string, unknown>).previous_shot_id as
                    string | null | undefined) ?? null,
              )
              .filter((shotId): shotId is string => typeof shotId === 'string'),
          );
          const deleteId = afterReorder.storyboard.shots.find(
            (shot) => !referenced.has(shot.shotId),
          )?.shotId;
          if (deleteId === undefined) throw new Error('missing-delete-input');
          const deleted = await window.jingxu.storyboard.deleteShot({
            episodeId: afterReorder.episode.id,
            expectedVersionId: afterReorder.storyboard.current.id,
            projectId,
            requestId: requestId('delete'),
            shotId: deleteId,
          });
          if (!deleted.ok)
            throw new Error(
              `delete:${deleted.error.code}:${JSON.stringify({
                deleteId,
                expectedVersionId: afterReorder.storyboard.current.id,
                shots: afterReorder.storyboard.shots.map((shot) => ({
                  shotId: shot.shotId,
                  versionId: shot.versionId,
                })),
              })}`,
            );
          const afterDelete = await load('after-delete');
          const restored = await window.jingxu.storyboard.restoreShot({
            episodeId: afterDelete.episode.id,
            expectedVersionId: afterDelete.storyboard.current.id,
            fromVersionId: initialVersionId,
            projectId,
            requestId: requestId('restore'),
            shotId: originalShotId,
          });
          if (!restored.ok) throw new Error(`restore:${restored.error.code}`);
          const afterRestore = await load('after-restore');
          const confirmed = await window.jingxu.script.confirmVersion({
            episodeId: afterRestore.episode.id,
            expectedVersionId: afterRestore.storyboard.current.id,
            projectId,
            requestId: requestId('confirm'),
            stage: 'SHOT_CONTRACT',
            versionId: afterRestore.storyboard.current.id,
          });
          if (!confirmed.ok) throw new Error(`confirm:${confirmed.error.code}`);
          const ready = await load('after-confirm');
          const exported = await window.jingxu.transfer.exportProject({
            episodeId: ready.episode.id,
            expectedVersionId: ready.storyboard.current.id,
            overwriteConfirmed: false,
            projectId,
            requestId: requestId('transfer-export'),
          });
          if (!exported.ok) throw new Error(`export:${exported.error.code}`);
          return {
            afterCopyShotIds: afterCopy.storyboard.shots.map((shot) => shot.shotId),
            afterRestore: ready.storyboard.shots.map((shot) => ({
              document: shot.document,
              sequence: shot.sequence,
              shotId: shot.shotId,
              versionId: shot.versionId,
            })),
            copiedSourceId,
            exportResult: exported.data,
            initialShotCount: initial.storyboard.shots.length,
            projectId,
          };
        }, seeded.projectId);
        expect(
          result.afterCopyShotIds.filter((shotId) => shotId === result.copiedSourceId),
        ).toHaveLength(1);
        expect(result.afterCopyShotIds).toHaveLength(result.initialShotCount + 2);
        expect(result.afterRestore.map((shot) => shot.sequence)).toEqual(
          Array.from({ length: result.afterRestore.length }, (_, index) => index + 1),
        );
        expect(result.afterRestore.every((shot) => shot.document.sequence === shot.sequence)).toBe(
          true,
        );
        expect(
          result.afterRestore.every(
            (shot) => typeof shot.document.derived_from_shot_ids !== 'undefined',
          ),
        ).toBe(true);
        const bundlePath = path.join(root, `project-transfer-${result.projectId}.json`);
        const bundle = await readFile(bundlePath);
        await writeFile(importFile, bundle);
        const imported = await page.evaluate(async () => {
          const outcome = await window.jingxu.transfer.importProject({
            importMode: 'NEW_PROJECT',
            requestId: `transfer-import_${crypto.randomUUID()}`,
          });
          if (!outcome.ok) throw new Error(`import:${outcome.error.code}`);
          return outcome.data;
        });
        expect(imported.sourceProjectId).toBe(result.projectId);
        expect(imported.projectId).not.toBe(result.projectId);
        expect(imported.createdObjectCount).toBeGreaterThanOrEqual(result.afterRestore.length);
        expect(imported.warningCodes).toContain('TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE');
        await evidence(root, 'E2E-AC03-EDIT-ROUNDTRIP', { imported, result });
      },
      undefined,
      importFile,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('E2E-AC04-FAILURE—主进程固定 Mock 覆盖 Provider 失败、修复、取消与迟到响应', async () => {
  test.setTimeout(300_000);
  const scenarios = [
    ['401', 'FAILED', 'MODEL_CREDENTIAL_INVALID'],
    ['429', 'SUCCEEDED', null],
    ['5xx', 'FAILED', 'MODEL_PROVIDER_ERROR'],
    ['timeout', 'FAILED', 'MODEL_TIMEOUT'],
    ['stale', 'FAILED', 'STALE_INPUT'],
    ['invalid-json', 'SUCCEEDED', null],
    ['repair-failure', 'FAILED', 'STRUCTURE_REPAIR_FAILED'],
    ['late-response', 'CANCELLED', null],
  ] as const;
  for (const [scenario, expectedStatus, expectedErrorCode] of scenarios) {
    await withApp(
      async (page, root) => {
        const outcome = await page.evaluate(
          async ({ expectedStatus: desiredStatus, scenario: selectedScenario }) => {
            const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
            const created = await window.jingxu.project.create({
              aspectRatio: '9:16',
              creationMode: 'AI_ORIGINAL',
              dialogueRenderMode: 'NARRATION_FIRST',
              genre: '悬疑',
              name: `AC04 ${selectedScenario}`,
              requestId: requestId('project'),
              style: '二维漫剧',
              subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
            });
            if (!created.ok) throw new Error(created.error.code);
            const initialized = await window.jingxu.script.initializeOriginal({
              creativeText: '一名侦探必须在列车抵达终点前找出记忆窃贼。',
              dataProcessingConsent: true,
              projectId: created.data.id,
              requestId: requestId('initialize'),
            });
            if (!initialized.ok) throw new Error(initialized.error.code);
            const profile = await window.jingxu.provider.getProfile({
              profileId: 'profile_qwen_primary',
            });
            if (!profile.ok) throw new Error(profile.error.code);
            const credential = await window.jingxu.provider.saveCredential({
              apiKey: 'e2e-mock-key-not-a-real-secret',
              expectedVersionId: profile.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('credential'),
            });
            if (!credential.ok) throw new Error(credential.error.code);
            const enabled = await window.jingxu.provider.saveProfile({
              enabled: true,
              expectedVersionId: credential.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('profile'),
              workspaceId: 'jingxu-e2e',
            });
            if (!enabled.ok) throw new Error(enabled.error.code);
            const tested = await window.jingxu.provider.testCredential({
              expectedVersionId: enabled.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('provider-test'),
            });
            if (!tested.ok) throw new Error(tested.error.code);
            const queued = await window.jingxu.job.create({
              episodeId: null,
              expectedInputVersionId: initialized.data.source.id,
              idempotencyKey: requestId('idempotency'),
              operationType: 'GENERATE',
              projectId: created.data.id,
              requestId: requestId('job'),
              stage: 'CONCEPT',
            });
            if (!queued.ok) throw new Error(queued.error.code);
            const cancelled =
              selectedScenario === 'late-response'
                ? await window.jingxu.job.cancel({
                    expectedVersionId: queued.data.versionId,
                    jobId: queued.data.id,
                    requestId: requestId('cancel'),
                  })
                : null;
            let current = queued.data;
            for (let attempt = 0; attempt < 120; attempt += 1) {
              const status = await window.jingxu.job.get({ jobId: queued.data.id });
              if (!status.ok) throw new Error(status.error.code);
              current = status.data;
              if (current.status === 'FAILED' || current.status === 'CANCELLED') break;
              if (current.status === 'SUCCEEDED') break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const workspace = await window.jingxu.script.getWorkspace({
              projectId: created.data.id,
            });
            if (!workspace.ok) throw new Error(workspace.error.code);
            return {
              cancelled,
              current,
              originalHash: initialized.data.source.contentHash,
              projectId: created.data.id,
              scenario: selectedScenario,
              status: desiredStatus,
              workspace,
            };
          },
          { expectedStatus, scenario },
        );
        expect(
          outcome.current.status,
          `${scenario}: ${outcome.current.errorCode ?? 'no-error'}`,
        ).toBe(expectedStatus);
        if (expectedErrorCode !== null) expect(outcome.current.errorCode).toBe(expectedErrorCode);
        expect(outcome.originalHash).toMatch(/^[a-f0-9]{64}$/u);
        if (scenario === 'late-response') expect(outcome.cancelled).toMatchObject({ ok: true });
        if (
          scenario === '401' ||
          scenario === '5xx' ||
          scenario === 'timeout' ||
          scenario === 'stale' ||
          scenario === 'repair-failure'
        ) {
          expect(outcome.workspace.data.stages.every((stage) => stage.current === null)).toBe(true);
        }
        await evidence(root, `E2E-AC04-FAILURE-${scenario}`, outcome);
      },
      undefined,
      undefined,
      scenario,
    );
  }
});

test('E2E-AC04-FAILURE-CRASH-RECOVERY—进程崩溃后未知响应不重发且任务终止', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-v1-ac04-crash-'));
  const managed = path.join(root, 'managed');
  const exportRoot = path.join(root, 'evidence');
  await mkdir(exportRoot, { recursive: true });
  const application = await launch(managed, exportRoot, undefined, undefined, 'late-response');
  let jobId: string | null = null;
  try {
    const page = await application.firstWindow();
    const prepared = await page.evaluate(async () => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const project = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: 'AC04 crash recovery',
        requestId: requestId('project'),
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      });
      if (!project.ok) throw new Error(project.error.code);
      const initialized = await window.jingxu.script.initializeOriginal({
        creativeText: '一名侦探必须在列车抵达终点前找出记忆窃贼。',
        dataProcessingConsent: true,
        projectId: project.data.id,
        requestId: requestId('initialize'),
      });
      if (!initialized.ok) throw new Error(initialized.error.code);
      const profile = await window.jingxu.provider.getProfile({
        profileId: 'profile_qwen_primary',
      });
      if (!profile.ok) throw new Error(profile.error.code);
      const credential = await window.jingxu.provider.saveCredential({
        apiKey: 'e2e-mock-key-not-a-real-secret',
        expectedVersionId: profile.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('credential'),
      });
      if (!credential.ok) throw new Error(credential.error.code);
      const enabled = await window.jingxu.provider.saveProfile({
        enabled: true,
        expectedVersionId: credential.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('profile'),
        workspaceId: 'jingxu-e2e',
      });
      if (!enabled.ok) throw new Error(enabled.error.code);
      const tested = await window.jingxu.provider.testCredential({
        expectedVersionId: enabled.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-test'),
      });
      if (!tested.ok) throw new Error(tested.error.code);
      const queued = await window.jingxu.job.create({
        episodeId: null,
        expectedInputVersionId: initialized.data.source.id,
        idempotencyKey: requestId('idempotency'),
        operationType: 'GENERATE',
        projectId: project.data.id,
        requestId: requestId('job'),
        stage: 'CONCEPT',
      });
      if (!queued.ok) throw new Error(queued.error.code);
      return { jobId: queued.data.id, projectId: project.data.id };
    });
    jobId = prepared.jobId;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const running = await page.evaluate((id) => window.jingxu.job.get({ jobId: id }), jobId);
      if (running.ok && running.data.status === 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await application
      .evaluate(({ app }) => {
        app.exit(1);
      })
      .catch(() => undefined);
    await application.close().catch(() => undefined);
    const restarted = await launch(managed, exportRoot, undefined, undefined, 'late-response');
    try {
      const pageAfterRestart = await restarted.firstWindow();
      let recovered: {
        readonly ok: boolean;
        readonly data?: { readonly errorCode: string | null; readonly status: string };
      } | null = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        recovered = await pageAfterRestart.evaluate(
          (id) => window.jingxu.job.get({ jobId: id }),
          jobId,
        );
        if (
          recovered.ok &&
          recovered.data !== undefined &&
          (recovered.data.status === 'FAILED' || recovered.data.status === 'CANCELLED')
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (recovered === null || !recovered.ok || recovered.data === undefined)
        throw new Error('crash-recovery-missing-job');
      expect(recovered).toMatchObject({
        ok: true,
        data: { status: 'FAILED', errorCode: 'INTERRUPTED_UNKNOWN_OUTCOME' },
      });
      await evidence(exportRoot, 'E2E-AC04-FAILURE-CRASH-RECOVERY', { jobId, recovered });
    } finally {
      await restarted.close();
    }
  } finally {
    const evidenceDirectory = process.env.JINGXU_E2E_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await cp(exportRoot, evidenceDirectory, { force: true, recursive: true });
    }
    await rm(root, { force: true, recursive: true });
  }
});

test('E2E-AC05-DIALOGUE—四种 DialogueRenderMode 与报告持久化', async () => {
  test.setTimeout(180_000);
  await withApp(async (page, root) => {
    const seeded = await seedStoryboardReady(page, 'AC05 对白规则');
    const workspace = await page.evaluate(
      (id) => window.jingxu.script.getWorkspace({ projectId: id }),
      seeded.projectId,
    );
    if (!workspace.ok || workspace.data.storyboard.current === null)
      throw new Error('missing-ready-storyboard');
    const outcome = await page.evaluate(
      async (context) => {
        const base = context.shots[0];
        if (base === undefined) throw new Error('missing-shot');
        const makeShot = (mode: string, speech: number, frontal: boolean) => ({
          ...base,
          cinematography: {
            ...(base.cinematography as Record<string, unknown>),
            frontal_face: frontal,
          },
          dialogue: {
            ...(base.dialogue as Record<string, unknown>),
            dialogue_render_mode: mode,
            estimated_speech_duration_sec: speech,
            speaker_id: speech === 0 ? null : 'narrator',
          },
          target_duration_sec: 15,
        });
        const run = async (shotContracts: readonly Record<string, unknown>[]) => {
          const report = await window.jingxu.producibility.run({
            document: { shot_contracts: shotContracts },
            episodeId: context.episodeId,
            expectedVersionId: context.expectedVersionId,
            projectId: context.projectId,
            requestId: `producibility_${crypto.randomUUID()}`,
          });
          if (!report.ok) throw new Error(`report:${report.error.code}`);
          return report.data;
        };
        const modes = await run([
          makeShot('NARRATION_FIRST', 3, true),
          makeShot('WEAK_LIP_SYNC', 5, true),
          makeShot('PRECISE_LIP_SYNC', 3, true),
          makeShot('SUBTITLE_ONLY', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
        ]);
        const weak = modes.findings.find(
          (finding) => finding.ruleId === 'WEAK_LIP_SYNC_LONG_DIALOGUE',
        );
        if (weak === undefined) throw new Error('missing-weak-lip-sync-warning');
        const overridden = await window.jingxu.producibility.overrideFinding({
          actor: 'USER',
          findingId: weak.id,
          reason: '本集以风格化弱口型呈现，已完成人工确认。',
          requestId: `override_${crypto.randomUUID()}`,
        });
        if (!overridden.ok) throw new Error(`override:${overridden.error.code}`);
        const unknown = await run([
          {
            ...makeShot('NARRATION_FIRST', 0, false),
            generation_constraints: {
              ...(base.generation_constraints as Record<string, unknown>),
              capability_requirements: [{ capability: 'UNREGISTERED_CAPABILITY', required: true }],
            },
          },
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
        ]);
        const blocked = await run([
          makeShot('NOT_A_DIALOGUE_MODE', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
          makeShot('NARRATION_FIRST', 0, false),
        ]);
        const blockFinding = blocked.findings.find((finding) => finding.severity === 'BLOCK');
        if (blockFinding === undefined) throw new Error('missing-block');
        const blockOverride = await window.jingxu.producibility.overrideFinding({
          actor: 'USER',
          findingId: blockFinding.id,
          reason: '不得覆盖的阻断项',
          requestId: `override_${crypto.randomUUID()}`,
        });
        const loaded = await window.jingxu.producibility.getReport({ reportId: modes.id });
        if (!loaded.ok) throw new Error(`load:${loaded.error.code}`);
        return {
          blockOverride,
          blocked,
          loaded: loaded.data,
          modes,
          overridden: overridden.data,
          unknown,
        };
      },
      {
        episodeId: workspace.data.episode.id,
        expectedVersionId: workspace.data.storyboard.current.id,
        projectId: seeded.projectId,
        shots: workspace.data.storyboard.shots.map((shot) => shot.document),
      },
    );
    expect(outcome.modes.ruleSetVersion).toBe('jingxu-producibility-rules/1');
    expect(outcome.modes.capabilitySnapshotId).toMatch(/.+/u);
    expect(outcome.modes.status).toBe('WARN');
    expect(outcome.overridden.status).toBe('PASS');
    expect(
      outcome.loaded.findings.find((finding) => finding.ruleId === 'WEAK_LIP_SYNC_LONG_DIALOGUE'),
    ).toMatchObject({ overridden: true, overrideReason: expect.any(String) });
    expect(outcome.unknown.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CAPABILITY_UNKNOWN', severity: 'WARN' }),
      ]),
    );
    expect(outcome.blocked.status).toBe('BLOCK');
    expect(outcome.blockOverride).toMatchObject({
      ok: false,
      error: { code: 'EXPORT_COLLECTION_INVALID' },
    });
    await evidence(root, 'E2E-AC05-DIALOGUE', outcome);
  });
});

test('E2E-AC06-LOCK-MATRIX—同路径与父子路径锁冲突无部分写入', async () => {
  test.setTimeout(180_000);
  await withApp(async (page, root) => {
    const seeded = await seedStoryboardReady(page, 'AC06 锁矩阵');
    const workspace = await page.evaluate(
      (id) => window.jingxu.script.getWorkspace({ projectId: id }),
      seeded.projectId,
    );
    if (
      !workspace.ok ||
      workspace.data.storyboard.current === null ||
      workspace.data.storyboard.shots[0] === undefined
    )
      throw new Error('missing-ready-shot');
    const shot = workspace.data.storyboard.shots[0];
    const outcome = await page.evaluate(
      async (context) => {
        const lock = await window.jingxu.storyboard.lockShot({
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          jsonPointer: '/content/action',
          note: 'AC06',
          projectId: context.projectId,
          requestId: `lock_${crypto.randomUUID()}`,
          shotId: context.shotId,
        });
        if (!lock.ok) throw new Error(`lock:${lock.error.code}`);
        const edited = await window.jingxu.storyboard.editShot({
          document: {
            ...context.document,
            content: {
              ...(context.document.content as Record<string, unknown>),
              action: '不应写入锁字段',
            },
          },
          episodeId: context.episodeId,
          expectedVersionId: lock.data.episode.id,
          projectId: context.projectId,
          requestId: `edit_${crypto.randomUUID()}`,
          shotId: context.shotId,
          shotVersionId: lock.data.shotVersionId,
        });
        const invalid = await Promise.all(
          ['/content/action~2', '/content/missing', '/content/character_ids/0'].map((jsonPointer) =>
            window.jingxu.storyboard.lockShot({
              episodeId: context.episodeId,
              expectedVersionId: lock.data.episode.id,
              jsonPointer,
              note: null,
              projectId: context.projectId,
              requestId: `invalid_${crypto.randomUUID()}`,
              shotId: context.shotId,
            }),
          ),
        );
        const stale = await window.jingxu.storyboard.editShot({
          document: context.document,
          episodeId: context.episodeId,
          expectedVersionId: context.versionId,
          projectId: context.projectId,
          requestId: `stale_${crypto.randomUUID()}`,
          shotId: context.shotId,
          shotVersionId: context.shotVersionId,
        });
        const refreshed = await window.jingxu.script.getWorkspace({ projectId: context.projectId });
        if (!refreshed.ok || refreshed.data.storyboard.current === null)
          throw new Error(refreshed.ok ? 'missing-current' : refreshed.error.code);
        const after = refreshed.data.storyboard.shots.find(
          (candidate) => candidate.shotId === context.shotId,
        );
        if (after === undefined) throw new Error('missing-locked-shot');
        return { after, edited, invalid, lock, stale };
      },
      {
        document: shot.document,
        episodeId: workspace.data.episode.id,
        projectId: seeded.projectId,
        shotId: shot.shotId,
        shotVersionId: shot.versionId,
        versionId: workspace.data.storyboard.current.id,
      },
    );
    expect(outcome.lock).toMatchObject({ ok: true, data: { lockedPaths: ['/content/action'] } });
    expect(outcome.edited).toMatchObject({ ok: false, error: { code: 'SHOT_LOCK_CONFLICT' } });
    expect(outcome.invalid).toHaveLength(3);
    expect(
      outcome.invalid.every(
        (result) => !result.ok && result.error.code === 'SHOT_LOCK_POINTER_INVALID',
      ),
    ).toBe(true);
    expect(outcome.stale).toMatchObject({ ok: false, error: { code: 'SCRIPT_VERSION_CONFLICT' } });
    expect((outcome.after.document.content as Record<string, unknown>).action).toBe(
      (shot.document.content as Record<string, unknown>).action,
    );
    expect(outcome.after.lockedPaths).toEqual(['/content/action']);
    await evidence(root, 'E2E-AC06-LOCK-MATRIX', outcome);
  });
});
