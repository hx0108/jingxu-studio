import { describe, expect, it, vi } from 'vitest';

import { scriptWorkspaceSchema } from '@jingxu/contracts';

import type {
  EpisodeVersion,
  ShotContractVersion,
  ScriptStageWorkspace,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  StoryboardWorkspace,
} from '../ports/script/index';
import { createScriptService } from './script-service';

const creativeText = '一封来自未来的信改变了侦探原本平静而孤独的一天。';

const shotDocument = (purpose: string, shotSize: string): string =>
  JSON.stringify({
    cinematography: { camera_motion: 'DOLLY', shot_size: shotSize },
    locked_paths: [],
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

const createSnapshot = (
  storyboard: StoryboardWorkspace,
  stages: readonly ScriptStageWorkspace[] = [],
): ScriptWorkspaceSnapshot => ({
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
  stages,
  storyboard,
});

const createHarness = (
  storyboard: StoryboardWorkspace,
  stages: readonly ScriptStageWorkspace[] = [],
) => {
  const workspaceQuery: ScriptWorkspaceQueryPort = {
    getVersionDocument: () => Promise.resolve(null),
    getWorkspace: () => Promise.resolve(createSnapshot(storyboard, stages)),
  };
  const storyboardService = { confirmStoryboard: vi.fn(), restoreStoryboard: vi.fn() };
  const versions = {
    confirmVersion: vi.fn(),
    listLocks: vi.fn(),
    lockPath: vi.fn(),
    restoreVersion: vi.fn(),
    saveDraft: vi.fn(),
    rewriteSelection: vi.fn(),
  };
  const service = createScriptService({
    findCurrentJob: () => Promise.resolve(null),
    initialization: { initialize: vi.fn() },
    storyboard: storyboardService,
    versions,
    workspaceQuery,
  });
  return { service, storyboardService, versions };
};

const readyConceptStage = (): ScriptStageWorkspace => ({
  current: {
    changeSummary: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    document: JSON.stringify({ stage: 'CONCEPT' }),
    documentSha256: 'e'.repeat(64),
    episodeId: null,
    id: 'concept-0001',
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInputId: 'source-0001',
    sourceInvocationId: 'invocation-0001',
    stage: 'CONCEPT',
    status: 'READY',
    versionNo: 1,
  },
  episodeId: null,
  head: null,
  history: [],
  historyTruncated: false,
  stage: 'CONCEPT',
});

const emptyStoryBibleStage = (): ScriptStageWorkspace => ({
  current: null,
  episodeId: null,
  head: null,
  history: [],
  historyTruncated: false,
  stage: 'STORY_BIBLE',
});

const readyStoryBibleStage = (): ScriptStageWorkspace => ({
  current: {
    createdAt: '2026-08-14T00:00:00.000Z',
    document: JSON.stringify({ stage: 'STORY_BIBLE' }),
    documentSha256: 'f'.repeat(64),
    id: 'bible-0001',
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInvocationId: 'invocation-0002',
    status: 'READY',
    versionNo: 1,
  },
  episodeId: null,
  head: null,
  history: [],
  historyTruncated: false,
  stage: 'STORY_BIBLE',
});

const readyEpisodeScriptStage = (
  stage: 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT',
  id: string,
): ScriptStageWorkspace => ({
  current: {
    changeSummary: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    document: JSON.stringify({ stage }),
    documentSha256: 'g'.repeat(64),
    episodeId: 'episode-0001',
    id,
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInputId: 'source-0001',
    sourceInvocationId: 'invocation-0003',
    stage,
    status: 'READY',
    versionNo: 1,
  },
  episodeId: 'episode-0001',
  head: null,
  history: [],
  historyTruncated: false,
  stage,
});

const emptyEpisodeScriptStage = (
  stage: 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT',
): ScriptStageWorkspace => ({
  current: null,
  episodeId: 'episode-0001',
  head: null,
  history: [],
  historyTruncated: false,
  stage,
});

describe('ScriptService getWorkspace storyboard 节（shot-contract-generation §5.2）', () => {
  it('条件—故事概念已确认 READY—故事圣经 prerequisiteReady 为 true，供 Renderer 解锁生成', async () => {
    const { service } = createHarness(
      { current: null, currentShots: [], history: [], historyTruncated: false },
      [
        readyConceptStage(),
        emptyStoryBibleStage(),
        emptyEpisodeScriptStage('EPISODE_OUTLINE'),
        emptyEpisodeScriptStage('BEAT_SHEET'),
        emptyEpisodeScriptStage('SCENE_SCRIPT'),
      ],
    );

    const result = await service.getWorkspace({ projectId: 'project-0001' }, 'trace-0000');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'CONCEPT', prerequisiteReady: true }),
        expect.objectContaining({ stage: 'STORY_BIBLE', prerequisiteReady: true }),
      ]),
    );
    expect(result.data.prerequisites).toContainEqual({
      message: '前置条件已满足',
      ready: true,
      stage: 'STORY_BIBLE',
    });
    expect(result.data.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'EPISODE_OUTLINE', prerequisiteReady: false }),
        expect.objectContaining({ stage: 'BEAT_SHEET', prerequisiteReady: false }),
        expect.objectContaining({ stage: 'SCENE_SCRIPT', prerequisiteReady: false }),
      ]),
    );
  });

  it('条件—上游链均为 READY—单集大纲、节拍表和场景剧本均按各自依赖解锁', async () => {
    const { service } = createHarness(
      { current: null, currentShots: [], history: [], historyTruncated: false },
      [
        readyConceptStage(),
        readyStoryBibleStage(),
        readyEpisodeScriptStage('EPISODE_OUTLINE', 'outline-0001'),
        readyEpisodeScriptStage('BEAT_SHEET', 'beat-0001'),
        emptyEpisodeScriptStage('SCENE_SCRIPT'),
      ],
    );

    const result = await service.getWorkspace({ projectId: 'project-0001' }, 'trace-0000b');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'STORY_BIBLE', prerequisiteReady: true }),
        expect.objectContaining({ stage: 'EPISODE_OUTLINE', prerequisiteReady: true }),
        expect.objectContaining({ stage: 'BEAT_SHEET', prerequisiteReady: true }),
        expect.objectContaining({ stage: 'SCENE_SCRIPT', prerequisiteReady: true }),
      ]),
    );
  });

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

  it.each(['confirmVersion', 'restoreVersion'] as const)(
    '条件—%s 收到 SHOT_CONTRACT（§5.3 D6 分派）—转发分镜服务且带 versionId，五阶段版本服务零调用',
    async (method) => {
      const { service, storyboardService, versions } = createHarness({
        current: null,
        currentShots: [],
        history: [],
        historyTruncated: false,
      });
      const summary = {
        createdAt: '2026-08-14T00:00:00.000Z',
        episodeId: 'episode-0001',
        formatProfileId: 'format-0001',
        id: 'ev-000002',
        parentId: 'ev-000001',
        shotCount: 6,
        shotSetHash: 'd'.repeat(64),
        status: 'READY',
        storyBibleVersionId: 'bible-0001',
        targetDurationSec: 90,
        versionNo: 2,
      };
      storyboardService.confirmStoryboard.mockResolvedValue({ data: summary, ok: true });
      storyboardService.restoreStoryboard.mockResolvedValue({ data: summary, ok: true });

      const result = await service[method](
        {
          episodeId: 'episode-0001',
          expectedVersionId: 'ev-000001',
          projectId: 'project-0001',
          requestId: 'request-0001',
          stage: 'SHOT_CONTRACT',
          versionId: 'ev-000001',
        },
        'trace-0001',
      );

      expect(result).toEqual({ data: summary, ok: true });
      const called =
        method === 'confirmVersion'
          ? storyboardService.confirmStoryboard
          : storyboardService.restoreStoryboard;
      expect(called).toHaveBeenCalledOnce();
      // 确认不带 versionId（以阶段头为准）；恢复携带历史 episode_version id（D4）。
      expect(called).toHaveBeenCalledWith(
        {
          episodeId: 'episode-0001',
          expectedVersionId: 'ev-000001',
          projectId: 'project-0001',
          requestId: 'request-0001',
          ...(method === 'restoreVersion' ? { versionId: 'ev-000001' } : {}),
        },
        'trace-0001',
      );
      expect(versions.confirmVersion).not.toHaveBeenCalled();
      expect(versions.restoreVersion).not.toHaveBeenCalled();
    },
  );

  it('条件—confirmVersion 收到五阶段命令—仍转发五阶段版本服务，分镜服务零调用', async () => {
    const { service, storyboardService, versions } = createHarness({
      current: null,
      currentShots: [],
      history: [],
      historyTruncated: false,
    });
    versions.confirmVersion.mockResolvedValue({ data: null, ok: false });

    await service.confirmVersion(
      {
        episodeId: 'episode-0001',
        expectedVersionId: 'beat-0001',
        projectId: 'project-0001',
        requestId: 'request-0002',
        stage: 'SCENE_SCRIPT',
        versionId: 'beat-0001',
      },
      'trace-0002',
    );

    expect(versions.confirmVersion).toHaveBeenCalledOnce();
    expect(storyboardService.confirmStoryboard).not.toHaveBeenCalled();
  });
});
