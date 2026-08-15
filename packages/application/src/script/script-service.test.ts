import { describe, expect, it, vi } from 'vitest';

import { scriptWorkspaceSchema } from '@jingxu/contracts';

import type {
  EpisodeVersion,
  ShotContractVersion,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  StoryboardWorkspace,
} from '../ports/script/index';
import { createScriptService } from './script-service';

const creativeText = '一封来自未来的信改变了侦探原本平静而孤独的一天。';

const shotDocument = (purpose: string, shotSize: string): string =>
  JSON.stringify({
    cinematography: { camera_motion: 'DOLLY', shot_size: shotSize },
    narrative_purpose: purpose,
  });

const shotVersion = (
  id: string,
  sequence: number,
  purpose: string,
  shotSize: string,
  document: string = shotDocument(purpose, shotSize),
): {
  sequence: number;
  shotId: string;
  version: ShotContractVersion;
} => {
  const shotId = `shot_000${String(sequence)}`;
  return {
    sequence,
    shotId,
    version: {
      createdAt: '2026-08-14T00:00:00.000Z',
      dialogueRenderMode: 'NARRATION_FIRST',
      document,
      documentSha256: 'c'.repeat(64),
      externalParentVersionId: null,
      formatProfileId: 'format-0001',
      id,
      lineageResolutionStatus: 'ROOT',
      parentId: null,
      sequence,
      shotId,
      sourceInvocationId: 'invocation-0001',
      targetDurationSec: 15,
      versionNo: 1,
      versionStatus: 'DRAFT',
    },
  };
};

const episodeVersion = (id: string, status: EpisodeVersion['status']): EpisodeVersion => ({
  createdAt: '2026-08-14T00:00:00.000Z',
  episodeId: 'episode-0001',
  formatProfileId: 'format-0001',
  id,
  parentId: null,
  shotSetHash: 'd'.repeat(64),
  status,
  storyBibleVersionId: 'bible-0001',
  targetDurationSec: 90,
  versionNo: 1,
});

const createSnapshot = (storyboard: StoryboardWorkspace): ScriptWorkspaceSnapshot => ({
  episode: {
    createdAt: '2026-08-13T00:00:00.000Z',
    currentVersionId: null,
    deletedAt: null,
    id: 'episode-0001',
    projectId: 'project-0001',
    targetDurationSec: 90,
    title: '第 1 集',
    updatedAt: '2026-08-13T00:00:00.000Z',
  },
  projectId: 'project-0001',
  sourceInput: {
    charCount: Array.from(creativeText).length,
    content: creativeText,
    createdAt: '2026-08-13T00:00:00.000Z',
    encoding: null,
    fileName: null,
    id: 'source-0001',
    inputKind: 'CREATIVE',
    projectId: 'project-0001',
    sha256: 'a'.repeat(64),
  },
  stages: [],
  storyboard,
});

const createHarness = (storyboard: StoryboardWorkspace) => {
  const workspaceQuery: ScriptWorkspaceQueryPort = {
    getVersionDocument: () => Promise.resolve(null),
    getWorkspace: () => Promise.resolve(createSnapshot(storyboard)),
  };
  const service = createScriptService({
    findCurrentJob: () => Promise.resolve(null),
    initialization: { initialize: vi.fn() },
    versions: { confirmVersion: vi.fn(), restoreVersion: vi.fn(), saveDraft: vi.fn() },
    workspaceQuery,
  });
  return { service };
};

describe('ScriptService getWorkspace storyboard 节（shot-contract-generation §5.2）', () => {
  it('条件—存在 DRAFT 整集与镜头集合—输出当前版本摘要、sequence 升序镜头摘要与时长汇总，且整体通过 strict 契约', async () => {
    const current = episodeVersion('ev-000001', 'DRAFT');
    const { service } = createHarness({
      current,
      currentShots: [
        shotVersion('scv-0001', 1, '开场：车厢全景', 'LONG'),
        shotVersion('scv-0002', 2, '林夜攥紧怀表起身', 'MEDIUM'),
      ],
      history: [{ shotCount: 2, version: current }],
      historyTruncated: false,
    });

    const result = await service.getWorkspace({ projectId: 'project-0001' }, 'trace-0001');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.storyboard).toMatchObject({
      current: { id: 'ev-000001', shotCount: 2, status: 'DRAFT', targetDurationSec: 90 },
      history: [{ id: 'ev-000001', shotCount: 2 }],
      shots: [
        {
          narrativePurpose: '开场：车厢全景',
          sequence: 1,
          shotSize: 'LONG',
          versionId: 'scv-0001',
        },
        { narrativePurpose: '林夜攥紧怀表起身', sequence: 2, shotSize: 'MEDIUM' },
      ],
      totalDurationSec: 30,
    });
    expect(result.data.storyboard.shots[0]).toMatchObject({
      cameraMotion: 'DOLLY',
      dialogueRenderMode: 'NARRATION_FIRST',
      shotId: 'shot_0001',
      targetDurationSec: 15,
    });
    // 映射产物必须整体满足 strict 输出契约（镜头摘要、时长汇总、集合一致性）。
    expect(scriptWorkspaceSchema.safeParse(result.data).success).toBe(true);
  });

  it('条件—Episode 尚无分镜阶段头—storyboard 节为空集合形态且仍通过契约', async () => {
    const { service } = createHarness({
      current: null,
      currentShots: [],
      history: [],
      historyTruncated: false,
    });

    const result = await service.getWorkspace({ projectId: 'project-0001' }, 'trace-0001');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.storyboard).toEqual({
      current: null,
      history: [],
      shots: [],
      totalDurationSec: 0,
    });
    expect(scriptWorkspaceSchema.safeParse(result.data).success).toBe(true);
  });

  it('条件—镜头文档损坏（无法解析）—返回 PROJECT_PERSISTENCE_FAILED，不泄漏异常细节', async () => {
    const broken = shotVersion('scv-0001', 1, '开场', 'LONG', '{"narrative_purpose": "未闭合');
    const { service } = createHarness({
      current: episodeVersion('ev-000001', 'DRAFT'),
      currentShots: [broken],
      history: [],
      historyTruncated: false,
    });

    const result = await service.getWorkspace({ projectId: 'project-0001' }, 'trace-0001');

    expect(result).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    expect(JSON.stringify(result)).not.toContain('未闭合');
  });
});
