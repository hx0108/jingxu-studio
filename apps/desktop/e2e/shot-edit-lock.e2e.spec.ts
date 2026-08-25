import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (managedRoot: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
    },
  });

test('分镜逐镜头编辑与锁定—编辑往返/锁阻断/解锁/非法路径/幂等重放/七根级 UI 入口（shot-edit-lock）', async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-shot-edit-lock-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const setup = await page.evaluate(async (orderedStages) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '编辑锁定闭环',
        requestId: requestId('project'),
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      });
      if (!created.ok) throw new Error(created.error.code);
      const projectId = created.data.id;
      const initialized = await window.jingxu.script.initializeOriginal({
        creativeText: '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客记忆的人。',
        dataProcessingConsent: true,
        projectId,
        requestId: requestId('initialize'),
      });
      if (!initialized.ok) throw new Error(initialized.error.code);
      let workspace = initialized.data;

      const configure = await window.jingxu.provider.getProfile({
        profileId: 'profile_qwen_primary',
      });
      if (!configure.ok) throw new Error(configure.error.code);
      const savedCredential = await window.jingxu.provider.saveCredential({
        apiKey: 'e2e-mock-key-not-a-real-secret',
        expectedVersionId: configure.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-key'),
      });
      if (!savedCredential.ok) throw new Error(savedCredential.error.code);
      const savedWorkspace = await window.jingxu.provider.saveProfile({
        enabled: true,
        expectedVersionId: savedCredential.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-profile'),
        workspaceId: 'jingxu-e2e',
      });
      if (!savedWorkspace.ok) throw new Error(savedWorkspace.error.code);
      const tested = await window.jingxu.provider.testCredential({
        expectedVersionId: savedWorkspace.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-test'),
      });
      if (!tested.ok) throw new Error(tested.error.code);

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
        if (expectedInputVersionId === undefined) throw new Error(`missing-input-${stage}`);
        const queued = await window.jingxu.job.create({
          episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
          expectedInputVersionId,
          idempotencyKey: requestId(`idem-${stage}`),
          operationType: 'GENERATE',
          projectId,
          requestId: requestId(`job-${stage}`),
          stage,
        });
        if (!queued.ok) throw new Error(`${stage}:${queued.error.code}`);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const status = await window.jingxu.job.get({ jobId: queued.data.id });
          if (!status.ok) throw new Error(status.error.code);
          if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
            throw new Error(`${stage}:${status.data.errorCode ?? status.data.status}`);
          }
          if (status.data.status === 'SUCCEEDED') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const refreshed = await window.jingxu.script.getWorkspace({ projectId });
        if (!refreshed.ok) throw new Error(refreshed.error.code);
        workspace = refreshed.data;
        const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
        if (draft?.status !== 'DRAFT') throw new Error(`${stage}:missing-draft`);
        const confirmed = await window.jingxu.script.confirmVersion({
          episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
          expectedVersionId: draft.id,
          projectId,
          requestId: requestId(`confirm-${stage}`),
          stage,
          versionId: draft.id,
        });
        if (!confirmed.ok) throw new Error(`${stage}:${confirmed.error.code}`);
        readyIds[stage] = confirmed.data.id;
        const afterConfirm = await window.jingxu.script.getWorkspace({ projectId });
        if (!afterConfirm.ok) throw new Error(afterConfirm.error.code);
        workspace = afterConfirm.data;
      }

      const sceneReadyId = readyIds.SCENE_SCRIPT;
      if (sceneReadyId === undefined) throw new Error('missing-input-SHOT_CONTRACT');
      const shotJob = await window.jingxu.job.create({
        episodeId: workspace.episode.id,
        expectedInputVersionId: sceneReadyId,
        idempotencyKey: requestId('idem-shot-contract'),
        operationType: 'GENERATE',
        projectId,
        requestId: requestId('job-shot-contract'),
        stage: 'SHOT_CONTRACT',
      });
      if (!shotJob.ok) throw new Error(`shot:${shotJob.error.code}`);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await window.jingxu.job.get({ jobId: shotJob.data.id });
        if (!status.ok) throw new Error(status.error.code);
        if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
          throw new Error(`shot:${status.data.errorCode ?? status.data.status}`);
        }
        if (status.data.status === 'SUCCEEDED') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const afterGenerate = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterGenerate.ok) throw new Error(afterGenerate.error.code);
      const storyboard = afterGenerate.data.storyboard;
      if (storyboard.current?.status !== 'DRAFT') {
        throw new Error('shot:missing-draft-set');
      }
      return {
        episodeId: workspace.episode.id,
        expectedVersionId: storyboard.current.id,
        projectId,
        shots: storyboard.shots.map((shot) => ({
          document: shot.document,
          lockedPaths: shot.lockedPaths,
          shotId: shot.shotId,
          versionId: shot.versionId,
        })),
      };
    }, stages);

    expect(setup.shots).toHaveLength(6);
    expect(setup.shots.every((shot) => shot.lockedPaths.length === 0)).toBe(true);

    // ---- 数据通路：编辑往返、锁阻断、解锁、非法路径、幂等重放 ----
    const editTarget = setup.shots[1];
    if (editTarget === undefined) throw new Error('missing-edit-target');
    const dataPath = await page.evaluate(async (context) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const target = context.shots[1];
      if (target === undefined) throw new Error('missing-edit-target');
      const otherIds = context.shots.slice(2).map((shot) => shot.shotId);

      // 1) 合法编辑：改叙事目的 → 新镜头版本 + 新整集 DRAFT 快照，其余镜头引用不变。
      const editInput = {
        document: { ...target.document, narrative_purpose: '编辑后的叙事目的：质问升级' },
        episodeId: context.episodeId,
        expectedVersionId: context.expectedVersionId,
        projectId: context.projectId,
        requestId: requestId('shot-edit'),
        shotId: target.shotId,
        shotVersionId: target.versionId,
      };
      const edited = await window.jingxu.storyboard.editShot(editInput);
      if (!edited.ok) throw new Error(`edit:${edited.error.code}`);

      // 2) 幂等重放：同 requestId 同 payload（含已过期的 expectedVersionId）→ 回执命中，
      //    返回同 shotVersionId，不产生第二版本（D6 复用 SAVE_SCRIPT_DRAFT 回执）。
      const replayed = await window.jingxu.storyboard.editShot(editInput);
      if (!replayed.ok) throw new Error(`replay:${replayed.error.code}`);

      const afterEdit = await window.jingxu.script.getWorkspace({ projectId: context.projectId });
      if (!afterEdit.ok) throw new Error(afterEdit.error.code);
      const afterEditStoryboard = afterEdit.data.storyboard;
      const afterEditTarget = afterEditStoryboard.shots.find(
        (shot) => shot.shotId === target.shotId,
      );
      if (afterEditTarget === undefined) throw new Error('missing-edited-shot');
      const afterEditOthers = afterEditStoryboard.shots
        .filter((shot) => otherIds.includes(shot.shotId))
        .map((shot) => shot.versionId);

      // 3) 锁定 /dialogue（七根级）→ 有效锁投影可见。
      const lockBase = {
        episodeId: context.episodeId,
        expectedVersionId: afterEditStoryboard.current?.id ?? context.expectedVersionId,
        jsonPointer: '/dialogue',
        projectId: context.projectId,
        requestId: requestId('shot-lock'),
        shotId: target.shotId,
      };
      const locked = await window.jingxu.storyboard.lockShot({ ...lockBase, note: '台词定稿' });
      if (!locked.ok) throw new Error(`lock:${locked.error.code}`);

      // 4) 锁定幂等 no-op：同指针重入 → 成功且整集版本不再前进。
      const lockedAgain = await window.jingxu.storyboard.lockShot({
        ...lockBase,
        expectedVersionId: locked.data.episode.id,
        jsonPointer: '/dialogue',
        note: null,
        requestId: requestId('shot-lock-again'),
      });
      if (!lockedAgain.ok) throw new Error(`lock-again:${lockedAgain.error.code}`);

      // 取锁定后的当前镜头文档作为后续编辑基线（含 locked_paths 投影）。
      const afterLock = await window.jingxu.script.getWorkspace({ projectId: context.projectId });
      if (!afterLock.ok) throw new Error(afterLock.error.code);
      const lockedShot = afterLock.data.storyboard.shots.find(
        (shot) => shot.shotId === target.shotId,
      );
      if (lockedShot === undefined) throw new Error('missing-locked-shot');
      const lockedDialogue = lockedShot.document.dialogue as Record<string, unknown>;

      // 5) 编辑被锁的 dialogue（改 estimated_speech_duration_sec 3→4）→ SHOT_LOCK_CONFLICT。
      const dialogueBlocked = await window.jingxu.storyboard.editShot({
        document: {
          ...lockedShot.document,
          dialogue: { ...lockedDialogue, estimated_speech_duration_sec: 4 },
        },
        episodeId: context.episodeId,
        expectedVersionId: lockedAgain.data.episode.id,
        projectId: context.projectId,
        requestId: requestId('shot-edit-blocked'),
        shotId: target.shotId,
        shotVersionId: lockedAgain.data.shotVersionId,
      });
      if (dialogueBlocked.ok) throw new Error('edit-blocked:unexpected-ok');

      // 6) 无关根编辑（仅改 narrative_purpose，dialogue 不动）→ 通过且锁原样保留。
      const unrelated = await window.jingxu.storyboard.editShot({
        document: { ...lockedShot.document, narrative_purpose: '无关路径再编辑：仅调整叙事目的' },
        episodeId: context.episodeId,
        expectedVersionId: lockedAgain.data.episode.id,
        projectId: context.projectId,
        requestId: requestId('shot-edit-unrelated'),
        shotId: target.shotId,
        shotVersionId: lockedAgain.data.shotVersionId,
      });
      if (!unrelated.ok) throw new Error(`edit-unrelated:${unrelated.error.code}`);

      // 7) 非法锁定路径（元数据根）→ SHOT_LOCK_POINTER_INVALID。
      const invalidLock = await window.jingxu.storyboard.lockShot({
        episodeId: context.episodeId,
        expectedVersionId: unrelated.data.episode.id,
        jsonPointer: '/shot_id',
        note: null,
        projectId: context.projectId,
        requestId: requestId('shot-lock-invalid'),
        shotId: target.shotId,
      });
      if (invalidLock.ok) throw new Error('lock-invalid:unexpected-ok');

      // 8) 显式解锁 → 投影清空。
      const unlocked = await window.jingxu.storyboard.unlockShot({
        episodeId: context.episodeId,
        expectedVersionId: unrelated.data.episode.id,
        jsonPointer: '/dialogue',
        projectId: context.projectId,
        requestId: requestId('shot-unlock'),
        shotId: target.shotId,
      });
      if (!unlocked.ok) throw new Error(`unlock:${unlocked.error.code}`);

      const surface = window.jingxu.storyboard as unknown as Record<string, unknown>;
      return {
        editVersionId: edited.data.shotVersionId,
        invalidPointerCode: invalidLock.error.code,
        lockAgainSameVersion: lockedAgain.data.episode.id === locked.data.episode.id,
        lockConflictCode: dialogueBlocked.error.code,
        lockConflictField: dialogueBlocked.error.fieldErrors?.lockedPaths ?? null,
        lockedPaths: lockedAgain.data.lockedPaths,
        othersUnchanged: afterEditOthers,
        replaySameVersion: replayed.data.shotVersionId === edited.data.shotVersionId,
        storyboardKeys: Object.keys(surface).sort(),
        storyboardFrozen: Object.isFrozen(surface),
        targetVersionAfterEdit: afterEditTarget.versionId,
        unlockedPaths: unlocked.data.lockedPaths,
        unrelatedLockedPaths: unrelated.data.lockedPaths,
      };
    }, setup);

    // 编辑往返：新版本出现（≠ 基线），重放同版本；其余镜头版本引用不变。
    expect(dataPath.targetVersionAfterEdit).not.toBe(editTarget.versionId);
    expect(dataPath.editVersionId).toBe(dataPath.targetVersionAfterEdit);
    expect(dataPath.replaySameVersion).toBe(true);
    const baselineOthers = setup.shots.slice(2).map((shot) => shot.versionId);
    expect(dataPath.othersUnchanged).toEqual(baselineOthers);
    // 锁定/阻断/解锁语义：幂等 no-op 不前进、冲突路径入 fieldErrors、无关编辑保留锁。
    expect(dataPath.lockedPaths).toEqual(['/dialogue']);
    expect(dataPath.lockAgainSameVersion).toBe(true);
    expect(dataPath.lockConflictCode).toBe('SHOT_LOCK_CONFLICT');
    expect(String(dataPath.lockConflictField)).toContain('/dialogue');
    expect(dataPath.unrelatedLockedPaths).toEqual(['/dialogue']);
    expect(dataPath.invalidPointerCode).toBe('SHOT_LOCK_POINTER_INVALID');
    expect(dataPath.unlockedPaths).toEqual([]);
    // storyboard 命名空间白名单（D4；storyboard-export 起第 4 方法 exportEpisode）。
    expect(dataPath.storyboardKeys).toEqual([
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
    expect(dataPath.storyboardFrozen).toBe(true);

    // ---- UI 通路：项目导航、编辑入口、锁徽标、锁阻断错误、七根级入口 ----
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await page.locator('.project-card-main', { hasText: '编辑锁定闭环' }).first().click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();

    const firstCard = page.locator('.shot-card', { hasText: '#1' }).first();
    await firstCard.click();
    await expect(page.getByRole('heading', { name: '镜头 #1 详情' })).toBeVisible();
    // 七根级锁定入口与编辑入口可见（D1/D3）。
    await expect(page.locator('button[name="lock-shot-dialogue"]')).toBeVisible();
    await expect(page.locator('button[name="lock-shot-acceptance"]')).toBeVisible();
    await expect(page.locator('button[name="open-shot-editor"]')).toBeEnabled();

    // 锁定台词 → 卡片出现 🔒 徽标。
    await page.locator('button[name="lock-shot-dialogue"]').click();
    await expect(page.locator('.shot-card.active-tab .status-locked')).toBeVisible();

    const versionDd = page
      .locator('.shot-detail dt', { hasText: '镜头版本' })
      .locator('xpath=following-sibling::dd[1]');
    const versionBefore = await versionDd.textContent();

    // 编辑被锁的 dialogue 字段 → 阻断错误可见（工作区错误横幅）。
    await page.locator('button[name="open-shot-editor"]').click();
    const editor = page.locator('textarea[name="shot-editor-text"]');
    const blockedDocument = JSON.parse(await editor.inputValue()) as Record<string, unknown>;
    const blockedDialogue = blockedDocument.dialogue as Record<string, unknown>;
    blockedDialogue.estimated_speech_duration_sec = 4;
    await editor.fill(JSON.stringify(blockedDocument, null, 2));
    await page.locator('button[name="save-shot-edit"]').click();
    await expect(page.locator('section.inline-error')).toContainText('SHOT_LOCK_CONFLICT');

    // 解锁 → 徽标消失。
    await page.locator('button[name="unlock-shot"]').click();
    await expect(page.locator('.shot-card.active-tab .status-locked')).toHaveCount(0);

    // 解锁后同一处编辑 → 保存成功，详情镜头版本变化。
    await page.locator('button[name="open-shot-editor"]').click();
    const reEditDocument = JSON.parse(
      await page.locator('textarea[name="shot-editor-text"]').inputValue(),
    ) as Record<string, unknown>;
    const reEditDialogue = reEditDocument.dialogue as Record<string, unknown>;
    reEditDialogue.estimated_speech_duration_sec = 4;
    await page
      .locator('textarea[name="shot-editor-text"]')
      .fill(JSON.stringify(reEditDocument, null, 2));
    await page.locator('button[name="save-shot-edit"]').click();
    await expect(versionDd).not.toHaveText(versionBefore ?? '');
    await expect(page.locator('.shot-card.active-tab .status-locked')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
