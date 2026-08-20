import { describe, expect, it } from 'vitest';

import type { ScriptJobRepositories } from '../ports/script/index';
import { computeShotSetHash } from './shot-set-hash';
import {
  createShotEditLockService,
  type ShotEditLockServiceDependencies,
} from './shot-edit-lock-service';

const hashPayload = (value: unknown): string => `sha:${JSON.stringify(value)}`;
const hashText = (value: string): string => `h(${value})`;
const NOW = '2026-08-20T00:00:00.000Z';

const shotDocument = (
  shotId: string,
  versionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  acceptance: { human_review_required: true, must_include: [], must_not_include: [] },
  cinematography: { camera_motion: 'STATIC', shot_size: 'MEDIUM' },
  content: {
    action: '主角避雨',
    character_ids: ['char_lin'],
    emotion: '紧张',
    prop_ids: [],
    scene_id: 'scene_street',
    spoken_text: '雨越下越大了。',
  },
  contract_version: 1,
  continuity: {
    asset_version_ids: [],
    continuity_mode: 'NONE',
    first_frame_requirement: null,
    last_frame_requirement: null,
    previous_shot_id: null,
  },
  derived_from_shot_ids: [],
  dialogue: {
    audio_required: true,
    dialogue_mode_source: 'PROJECT_DEFAULT',
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    lip_sync_required: false,
    override_reason: null,
    speaker_id: 'narrator',
  },
  format_profile_id: 'format-0001',
  generation_constraints: {
    budget_estimate: null,
    capability_requirements: [],
    image_prompt: '雨夜街道',
    negative_constraints: [],
    video_prompt: null,
  },
  locked_paths: [],
  narrative_purpose: '建立雨夜氛围',
  parent_version_id: null,
  provenance: {
    last_edit_source: 'AI',
    source_invocation_id: 'inv-0001',
    source_type: 'AI_GENERATED',
  },
  schema_version: '1.1.0',
  sequence: 1,
  shot_id: shotId,
  status: 'DRAFT',
  target_duration_sec: 15,
  version_id: versionId,
  ...overrides,
});

interface Stores {
  readonly audits: Record<string, unknown>[];
  readonly episodeVersions: Map<string, Record<string, unknown>>;
  readonly heads: Map<string, Record<string, unknown>>;
  readonly links: Map<string, { shotId: string; shotVersionId: string; sequence: number }[]>;
  readonly locks: Map<string, Record<string, unknown>>;
  readonly pointerUpdates: Record<string, unknown>[];
  readonly receipts: Map<string, Record<string, unknown>>;
  readonly shotVersions: Map<string, Record<string, unknown>>;
  failInsertShotVersions: boolean;
  failUnlock: boolean;
}

const createHarness = (options: { schemaDetails?: readonly string[] } = {}) => {
  const doc1 = shotDocument('shot_0001', 'scv_0001_v1');
  const doc2 = shotDocument('shot_0002', 'scv_0002_v1', {
    content: {
      action: '走向屋檐',
      character_ids: [],
      emotion: '平静',
      prop_ids: [],
      scene_id: 'scene_street',
      spoken_text: '',
    },
    dialogue: {
      audio_required: false,
      dialogue_mode_source: 'PROJECT_DEFAULT',
      dialogue_render_mode: 'NARRATION_FIRST',
      estimated_speech_duration_sec: 0,
      lip_sync_required: false,
      override_reason: null,
      speaker_id: null,
    },
    sequence: 2,
  });
  const stores: Stores = {
    audits: [],
    episodeVersions: new Map([
      [
        'ev-0001',
        {
          createdAt: NOW,
          episodeId: 'episode-0001',
          formatProfileId: 'format-0001',
          id: 'ev-0001',
          parentId: null,
          shotSetHash: 'hash-ev-0001',
          status: 'DRAFT',
          storyBibleVersionId: 'bible-0001',
          targetDurationSec: 90,
          versionNo: 1,
        },
      ],
    ]),
    failInsertShotVersions: false,
    failUnlock: false,
    heads: new Map([
      [
        'project-0001:episode-0001:SHOT_CONTRACT',
        {
          currentVersionId: 'ev-0001',
          currentVersionType: 'EPISODE_VERSION',
          episodeId: 'episode-0001',
          projectId: 'project-0001',
          stage: 'SHOT_CONTRACT',
          updatedAt: NOW,
        },
      ],
    ]),
    links: new Map([
      [
        'ev-0001',
        [
          { sequence: 1, shotId: 'shot_0001', shotVersionId: 'scv_0001_v1' },
          { sequence: 2, shotId: 'shot_0002', shotVersionId: 'scv_0002_v1' },
        ],
      ],
    ]),
    locks: new Map(),
    pointerUpdates: [],
    receipts: new Map(),
    shotVersions: new Map([
      [
        'scv_0001_v1',
        {
          createdAt: NOW,
          dialogueRenderMode: 'NARRATION_FIRST',
          document: JSON.stringify(doc1),
          documentSha256: 'sha-scv-0001-v1',
          externalParentVersionId: null,
          formatProfileId: 'format-0001',
          id: 'scv_0001_v1',
          lineageResolutionStatus: 'ROOT',
          parentId: null,
          sequence: 1,
          shotId: 'shot_0001',
          sourceInvocationId: 'inv-0001',
          targetDurationSec: 15,
          versionNo: 1,
          versionStatus: 'DRAFT',
        },
      ],
      [
        'scv_0002_v1',
        {
          createdAt: NOW,
          dialogueRenderMode: 'NARRATION_FIRST',
          document: JSON.stringify(doc2),
          documentSha256: 'sha-scv-0002-v1',
          externalParentVersionId: null,
          formatProfileId: 'format-0001',
          id: 'scv_0002_v1',
          lineageResolutionStatus: 'ROOT',
          parentId: null,
          sequence: 2,
          shotId: 'shot_0002',
          sourceInvocationId: 'inv-0001',
          targetDurationSec: 15,
          versionNo: 1,
          versionStatus: 'DRAFT',
        },
      ],
    ]),
  };

  const bibles = new Map([
    [
      'bible-0001',
      {
        document: JSON.stringify({
          data: { characters: { char_lin: {} }, scenes: { scene_street: {} } },
        }),
        id: 'bible-0001',
      },
    ],
  ]);

  let idSequence = 0;
  const repositories = {
    audit: { record: (entry: Record<string, unknown>) => void stores.audits.push(entry) },
    episodeVersions: {
      findMaxVersionNo: () =>
        Math.max(0, ...[...stores.episodeVersions.values()].map((row) => Number(row.versionNo))),
      findById: (id: string) => stores.episodeVersions.get(id) ?? null,
      insert: (version: Record<string, unknown>) =>
        void stores.episodeVersions.set(String(version.id), version),
      insertShotLinks: (links: readonly Record<string, unknown>[]) => {
        const episodeVersionId = String(links[0]?.episodeVersionId);
        stores.links.set(
          episodeVersionId,
          links.map((link) => ({
            sequence: Number(link.sequence),
            shotId: String(link.shotId),
            shotVersionId: String(link.shotVersionId),
          })),
        );
      },
      listShotLinks: (id: string) =>
        (stores.links.get(id) ?? []).slice().sort((left, right) => left.sequence - right.sequence),
    },
    locks: {
      insert: (record: Record<string, unknown>) => void stores.locks.set(String(record.id), record),
      listActive: () => [...stores.locks.values()].filter((record) => record.unlockedAt === null),
      unlock: (id: string) => {
        if (stores.failUnlock) return Promise.resolve(false);
        const record = stores.locks.get(id);
        if (record?.unlockedAt !== null) return Promise.resolve(false);
        record.unlockedAt = NOW;
        return Promise.resolve(true);
      },
    },
    receipts: {
      findByRequestId: (requestId: string) => stores.receipts.get(requestId) ?? null,
      insert: (receipt: Record<string, unknown>) =>
        void stores.receipts.set(String(receipt.requestId), receipt),
    },
    shots: {
      updateCurrentVersionIds: (entries: readonly Record<string, unknown>[]) =>
        void stores.pointerUpdates.push(...entries),
    },
    shotContractVersions: {
      findById: (id: string) => stores.shotVersions.get(id) ?? null,
      insertMany: (versions: readonly Record<string, unknown>[]) => {
        if (stores.failInsertShotVersions) throw new Error('SQLITE_ERROR');
        for (const version of versions) stores.shotVersions.set(String(version.id), version);
      },
    },
    stageHeads: {
      find: (projectId: string, episodeId: string | null, stage: string) =>
        stores.heads.get(`${projectId}:${String(episodeId)}:${stage}`) ?? null,
      upsert: (head: Record<string, unknown>, expected: unknown) => {
        const key = `${String(head.projectId)}:${String(head.episodeId)}:${String(head.stage)}`;
        const current = stores.heads.get(key);
        if ((current?.currentVersionId ?? null) !== expected) return Promise.resolve(false);
        stores.heads.set(key, head);
        return Promise.resolve(true);
      },
    },
    storyBibleVersions: { findById: (id: string) => bibles.get(id) ?? null },
  } as unknown as ScriptJobRepositories;

  const dependencies: ShotEditLockServiceDependencies = {
    hashPayload,
    hashText,
    newId: () => {
      idSequence += 1;
      return `id-${String(idSequence)}`;
    },
    now: () => NOW,
    unitOfWork: { run: (work) => work(repositories) },
    validateShotDocument: () =>
      options.schemaDetails === undefined
        ? { valid: true }
        : { code: 'SCHEMA_INVALID', details: options.schemaDetails, valid: false },
  };
  return { currentDocument: doc1, dependencies, repositories, stores };
};

const editInput = (document: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  document,
  episodeId: 'episode-0001',
  expectedVersionId: 'ev-0001',
  projectId: 'project-0001',
  requestId: 'req-edit-1',
  shotId: 'shot_0001',
  shotVersionId: 'scv_0001_v1',
  ...overrides,
});

describe('editShot 编辑事务', () => {
  it('合法编辑—新 DRAFT 镜头版本+完整整集快照+指针推进+SAVE_SCRIPT_DRAFT 回执', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const result = await service.editShot(
      editInput({
        ...currentDocument,
        content: {
          ...(currentDocument.content as Record<string, unknown>),
          spoken_text: '改写后的台词。',
        },
      }),
      'trace-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const newId = result.data.shotVersionId;
    expect(newId).toMatch(/^scv_id-\d+_v2$/);
    expect(result.data.episode.status).toBe('DRAFT');
    expect(result.data.episode.versionNo).toBe(2);

    const newVersion = stores.shotVersions.get(newId);
    expect(newVersion).toMatchObject({
      lineageResolutionStatus: 'LOCAL_VERIFIED',
      parentId: 'scv_0001_v1',
      sequence: 1,
      shotId: 'shot_0001',
      versionNo: 2,
      versionStatus: 'DRAFT',
    });
    const newDocument = JSON.parse(String(newVersion?.document)) as Record<string, unknown>;
    expect(newDocument.provenance).toMatchObject({ last_edit_source: 'HUMAN' });
    expect(newDocument.status).toBe('DRAFT');
    expect(newDocument.locked_paths).toEqual([]);

    // 完整整集快照：编辑镜头指向新版本，兄弟镜头沿用；shotSetHash 与快照复算一致。
    const episodeV2 = [...stores.episodeVersions.values()].find((row) => row.versionNo === 2);
    expect(episodeV2).toMatchObject({ parentId: 'ev-0001', status: 'DRAFT' });
    const links = stores.links.get(String(episodeV2?.id)) ?? [];
    expect(links).toEqual([
      { sequence: 1, shotId: 'shot_0001', shotVersionId: newId },
      { sequence: 2, shotId: 'shot_0002', shotVersionId: 'scv_0002_v1' },
    ]);
    expect(String(episodeV2?.shotSetHash)).toBe(
      computeShotSetHash(
        [
          {
            documentSha256: String(newVersion?.documentSha256),
            sequence: 1,
            shotId: 'shot_0001',
            shotVersionId: newId,
          },
          {
            documentSha256: 'sha-scv-0002-v1',
            sequence: 2,
            shotId: 'shot_0002',
            shotVersionId: 'scv_0002_v1',
          },
        ],
        hashText,
      ),
    );
    expect(stores.heads.get('project-0001:episode-0001:SHOT_CONTRACT')).toMatchObject({
      currentVersionId: episodeV2?.id,
    });
    expect(stores.pointerUpdates).toEqual([
      { currentVersionId: newId, updatedAt: NOW, shotId: 'shot_0001' },
    ]);
    expect([...stores.receipts.values()]).toHaveLength(1);
    expect([...stores.receipts.values()][0]).toMatchObject({
      commandName: 'SAVE_SCRIPT_DRAFT',
      resultRef: { episodeVersionId: episodeV2?.id, shotVersionId: newId },
    });
    expect(stores.audits).toHaveLength(1);
    expect(stores.audits[0]).toMatchObject({
      action: 'SHOT_EDITED',
      metadata: { changedRoots: ['content'] },
    });
  });

  it('幂等重放—同 requestId 同 payload 返回同结果且零重复写入', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);
    const input = editInput({
      ...currentDocument,
      narrative_purpose: '改写用途',
    });

    const first = await service.editShot(input, 'trace-1');
    const firstShotVersions = stores.shotVersions.size;
    const firstEpisodes = stores.episodeVersions.size;
    const second = await service.editShot(input, 'trace-1');

    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.shotVersionId).toBe(first.data.shotVersionId);
    expect(second.data.episode.id).toBe(first.data.episode.id);
    expect(stores.shotVersions.size).toBe(firstShotVersions);
    expect(stores.episodeVersions.size).toBe(firstEpisodes);
    expect(stores.receipts.size).toBe(1);
  });

  it('requestId 复用不同 payload → REQUEST_ID_REUSED', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);
    await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: '第一次' }),
      'trace-1',
    );
    const reused = await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: '第二次' }),
      'trace-1',
    );

    expect(reused).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REUSED' } });
    expect(stores.shotVersions.size).toBe(3);
  });

  it('乐观并发—head 过期或编辑基线漂移均 SCRIPT_VERSION_CONFLICT', async () => {
    const { currentDocument, dependencies } = createHarness();
    const service = createShotEditLockService(dependencies);

    const staleHead = await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: 'x' }, { expectedVersionId: 'ev-0000' }),
      'trace-1',
    );
    expect(staleHead).toMatchObject({ ok: false, error: { code: 'SCRIPT_VERSION_CONFLICT' } });

    const staleBaseline = await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: 'x' }, { shotVersionId: 'scv_0001_v0' }),
      'trace-2',
    );
    expect(staleBaseline).toMatchObject({ ok: false, error: { code: 'SCRIPT_VERSION_CONFLICT' } });
  });

  it('Schema 违反 → SCRIPT_SCHEMA_INVALID 整体拒绝且无任何写入', async () => {
    const { currentDocument, dependencies, stores } = createHarness({
      schemaDetails: ['/dialogue:TYPE'],
    });
    const service = createShotEditLockService(dependencies);

    const result = await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: '改' }),
      'trace-1',
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SCRIPT_SCHEMA_INVALID', fieldErrors: { details: '/dialogue:TYPE' } },
    });
    expect(stores.shotVersions.size).toBe(2);
    expect(stores.episodeVersions.size).toBe(1);
    expect(stores.receipts.size).toBe(0);
    expect(stores.pointerUpdates).toHaveLength(0);
  });

  it('集合校验违反（整集时长越界）→ SCRIPT_SCHEMA_INVALID 整体拒绝', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const result = await service.editShot(
      editInput({ ...currentDocument, target_duration_sec: 1 }),
      'trace-1',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_SCHEMA_INVALID' } });
    if (!result.ok) {
      expect(result.error.fieldErrors?.details).toContain('SHOT_SET_DURATION_OUT_OF_RANGE');
    }
    expect(stores.shotVersions.size).toBe(2);
    expect(stores.episodeVersions.size).toBe(1);
  });

  it('锁复检—锁 /dialogue 阻断 dialogue 编辑并给出冲突路径；无关根放行且锁被复制', async () => {
    const harness = createHarness();
    const { currentDocument, dependencies, stores } = harness;
    const service = createShotEditLockService(dependencies);
    stores.locks.set('lock-1', {
      id: 'lock-1',
      jsonPointer: '/dialogue',
      lockedAt: NOW,
      lockedBy: 'USER',
      note: null,
      objectId: 'shot_0001',
      objectType: 'SHOT_CONTRACT',
      objectVersionId: 'scv_0001_v1',
      projectId: 'project-0001',
      unlockedAt: null,
    });

    const blocked = await service.editShot(
      editInput({
        ...currentDocument,
        dialogue: {
          ...(currentDocument.dialogue as Record<string, unknown>),
          dialogue_render_mode: 'SUBTITLE_ONLY',
        },
      }),
      'trace-1',
    );
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'SHOT_LOCK_CONFLICT', fieldErrors: { lockedPaths: '/dialogue' } },
    });
    expect(stores.shotVersions.size).toBe(2);

    const allowed = await service.editShot(
      editInput({
        ...currentDocument,
        cinematography: {
          ...(currentDocument.cinematography as Record<string, unknown>),
          shot_size: 'CLOSE_UP',
        },
      }),
      'trace-2',
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      const document = JSON.parse(
        String(stores.shotVersions.get(allowed.data.shotVersionId)?.document),
      ) as Record<string, unknown>;
      // 锁复制（不变量 13）：新版本 locked_paths 恒等于有效锁集合。
      expect(document.locked_paths).toEqual(['/dialogue']);
      expect(allowed.data.lockedPaths).toEqual(['/dialogue']);
    }
  });

  it('无变化与系统字段篡改 → SHOT_EDIT_NO_CHANGE', async () => {
    const { currentDocument, dependencies } = createHarness();
    const service = createShotEditLockService(dependencies);

    const noChange = await service.editShot(editInput({ ...currentDocument }), 'trace-1');
    expect(noChange).toMatchObject({ ok: false, error: { code: 'SHOT_EDIT_NO_CHANGE' } });

    const tamperedSystemFieldOnly = await service.editShot(
      editInput({ ...currentDocument, sequence: 99, shot_id: 'shot_hacked' }),
      'trace-2',
    );
    expect(tamperedSystemFieldOnly).toMatchObject({
      ok: false,
      error: { code: 'SHOT_EDIT_NO_CHANGE' },
    });
  });

  it('中途失败—返回持久化失败且无回执与 head 变化', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    stores.failInsertShotVersions = true;
    const service = createShotEditLockService(dependencies);

    const result = await service.editShot(
      editInput({ ...currentDocument, narrative_purpose: '改' }),
      'trace-1',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PERSISTENCE_FAILED' } });
    expect(stores.receipts.size).toBe(0);
    expect(stores.heads.get('project-0001:episode-0001:SHOT_CONTRACT')).toMatchObject({
      currentVersionId: 'ev-0001',
    });
  });
});

describe('lockShot / unlockShot 版本化命令', () => {
  const lockInput = (jsonPointer: string, overrides: Record<string, unknown> = {}) => ({
    episodeId: 'episode-0001',
    expectedVersionId: 'ev-0001',
    jsonPointer,
    note: null,
    projectId: 'project-0001',
    requestId: 'req-lock-1',
    shotId: 'shot_0001',
    ...overrides,
  });

  it('锁定合法根—新版本仅变 locked_paths，lock_records 同事务写，投影一致，无回执', async () => {
    const { currentDocument, dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const result = await service.lockShot(lockInput('/dialogue'), 'trace-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const newId = result.data.shotVersionId;
    expect(result.data.lockedPaths).toEqual(['/dialogue']);

    const newVersion = stores.shotVersions.get(newId);
    const newDocument = JSON.parse(String(newVersion?.document)) as Record<string, unknown>;
    const oldDocument = { ...currentDocument };
    expect(newDocument).toEqual({
      ...oldDocument,
      contract_version: 2,
      locked_paths: ['/dialogue'],
      parent_version_id: 'scv_0001_v1',
      version_id: newId,
    });
    expect(newVersion).toMatchObject({ versionNo: 2, versionStatus: 'DRAFT' });

    const records = [...stores.locks.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      jsonPointer: '/dialogue',
      objectVersionId: newId,
      objectType: 'SHOT_CONTRACT',
      unlockedAt: null,
    });
    expect(stores.audits[0]).toMatchObject({ action: 'SHOT_LOCKED' });
    expect(stores.receipts.size).toBe(0);
  });

  it('锁定非法路径—白名单外/数组下标/不存在子路径均 SHOT_LOCK_POINTER_INVALID', async () => {
    const { dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    for (const pointer of [
      '/target_duration_sec',
      '/content/character_ids/0',
      '/dialogue/nonexistent',
    ]) {
      const result = await service.lockShot(
        lockInput(pointer, { requestId: `req-${pointer}` }),
        'trace-1',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SHOT_LOCK_POINTER_INVALID');
      }
    }
    expect(stores.shotVersions.size).toBe(2);
  });

  it('锁定幂等—同指针重入 no-op 成功且不新增版本', async () => {
    const { dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const first = await service.lockShot(lockInput('/dialogue'), 'trace-1');
    const versionCount = stores.shotVersions.size;
    const second = await service.lockShot(lockInput('/dialogue'), 'trace-2');

    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.shotVersionId).toBe(first.data.shotVersionId);
    expect(stores.shotVersions.size).toBe(versionCount);
  });

  it('锁定/解锁往返—locked_paths 增删与 lock_records 状态一致（不变量 13）', async () => {
    const { dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const locked = await service.lockShot(lockInput('/dialogue'), 'trace-1');
    if (!locked.ok) throw new Error('lock failed');
    const unlocked = await service.unlockShot(
      lockInput('/dialogue', { expectedVersionId: locked.data.episode.id }),
      'trace-2',
    );

    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    expect(unlocked.data.lockedPaths).toEqual([]);
    const finalDocument = JSON.parse(
      String(stores.shotVersions.get(unlocked.data.shotVersionId)?.document),
    ) as Record<string, unknown>;
    expect(finalDocument.locked_paths).toEqual([]);

    const records = [...stores.locks.values()];
    expect(records).toHaveLength(1);
    expect(records[0]?.unlockedAt).toBe(NOW);
    expect(stores.audits.map((entry) => entry.action)).toEqual(['SHOT_LOCKED', 'SHOT_UNLOCKED']);
    // v1 + lock v2 + unlock v3：版本链推进而内容仅 locked_paths 往返。
    expect(stores.shotVersions.size).toBe(4);
    expect(unlocked.data.shotVersionId).toMatch(/_v3$/);
  });

  it('解锁未锁指针—no-op 成功不新增版本', async () => {
    const { dependencies, stores } = createHarness();
    const service = createShotEditLockService(dependencies);

    const result = await service.unlockShot(lockInput('/dialogue'), 'trace-1');

    expect(result.ok).toBe(true);
    expect(stores.shotVersions.size).toBe(2);
  });

  it('解锁竞态—unlock 返回 false → SCRIPT_VERSION_CONFLICT', async () => {
    const { dependencies, stores } = createHarness();
    stores.failUnlock = true;
    const service = createShotEditLockService(dependencies);
    await service.lockShot(lockInput('/dialogue'), 'trace-1');

    const result = await service.unlockShot(lockInput('/dialogue'), 'trace-2');

    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_VERSION_CONFLICT' } });
  });
});
