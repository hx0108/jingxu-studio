import type {
  MediaUnitOfWorkPort,
  ProjectRepositories,
  ProjectUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
} from '@jingxu/application';
import { describe, expect, it, vi } from 'vitest';

import { createCreatorGuideQuery } from './create-creator-guide-query';

const project = {
  id: 'project_12345678',
  name: '雾都来信',
  genre: '悬疑',
  style: '电影感',
  creationMode: 'AI_ORIGINAL',
  dialogueRenderMode: 'NARRATION_FIRST',
  deploymentMode: 'LOCAL_DEMO',
  experienceMode: 'STANDARD',
  dataRootRel: 'projects/project_12345678',
  createdAt: '2026-09-20T01:00:00.000Z',
  updatedAt: '2026-09-20T01:00:00.000Z',
  deletedAt: null,
} as const;

const createHarness = () => {
  const listPage = vi.fn(() =>
    Promise.resolve({
      items: [{ project, currentAspectRatio: '9:16' as const }],
      nextAfter: null,
      truncated: false,
    }),
  );
  const findById = vi.fn((id: string) => Promise.resolve(id === project.id ? project : null));
  const writes = {
    insert: vi.fn(),
    update: vi.fn(),
    audit: vi.fn(),
    analytics: vi.fn(),
    receipt: vi.fn(),
  };
  const repositories = {
    projects: {
      findById,
      listPage,
      findActiveNameRefs: vi.fn(),
      scanForSearch: vi.fn(),
      insert: writes.insert,
      update: writes.update,
    },
    formatProfiles: {} as ProjectRepositories['formatProfiles'],
    receipts: { findByRequestId: vi.fn(), insert: writes.receipt },
    audit: { record: writes.audit },
    analytics: { record: writes.analytics },
  } satisfies ProjectRepositories;
  const projects: ProjectUnitOfWorkPort = {
    run: (work) => work(repositories),
  };
  const scripts = {
    getWorkspace: vi.fn(() =>
      Promise.resolve({
        projectId: project.id,
        sourceInput: null,
        episode: null,
        stages: [],
        storyboard: { current: null, currentShots: [], history: [], historyTruncated: false },
      }),
    ),
    getVersionDocument: vi.fn(),
  } satisfies ScriptWorkspaceQueryPort;
  return { query: createCreatorGuideQuery({ projects, scripts }), projects, scripts, writes };
};

describe('desktop creator guide query', () => {
  it('读取活动项目与工作区—组合投影—不调用任何写方法', async () => {
    const { query, writes } = createHarness();

    await expect(query.listActiveProjects()).resolves.toEqual([
      { id: project.id, updatedAt: project.updatedAt },
    ]);
    await expect(query.getProjectSnapshot(project.id)).resolves.toMatchObject({
      projectId: project.id,
      sourceInputReady: false,
      stages: { CONCEPT: 'MISSING', SHOT_CONTRACT: 'MISSING' },
    });
    expect(Object.values(writes).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('跨项目或缺失项目 ID—查询失配—返回 null 且不读其工作区', async () => {
    const { query, scripts } = createHarness();

    await expect(query.getProjectSnapshot('project_other_1234')).resolves.toBeNull();
    expect(scripts.getWorkspace).not.toHaveBeenCalled();
  });

  it('项目存在但剧本工作区未初始化—投影为未就绪输入而非过期—续作可定位输入故事', async () => {
    const { query, scripts } = createHarness();
    scripts.getWorkspace.mockReturnValue(
      Promise.resolve(null) as unknown as ReturnType<typeof scripts.getWorkspace>,
    );

    await expect(query.getProjectSnapshot(project.id)).resolves.toEqual({
      consistencyBlocks: [],
      exportReady: false,
      imagesReady: false,
      projectId: project.id,
      sourceInputReady: false,
      stages: {
        BEAT_SHEET: 'MISSING',
        CONCEPT: 'MISSING',
        EPISODE_OUTLINE: 'MISSING',
        SCENE_SCRIPT: 'MISSING',
        SHOT_CONTRACT: 'MISSING',
        STORY_BIBLE: 'MISSING',
      },
      videosReady: false,
      voiceReady: false,
    });
  });

  it('分镜已确认且媒体事实逐步完成—投影当前选中候选、配音与成功导出—不把旧候选计为完成', async () => {
    const { projects, scripts } = createHarness();
    scripts.getWorkspace.mockResolvedValue({
      projectId: project.id,
      sourceInput: { id: 'source_1' },
      episode: { id: 'episode_1' },
      stages: [
        ...(
          ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const
        ).map((stage) => ({ current: { status: 'READY' }, stage })),
      ],
      storyboard: {
        current: { status: 'READY' },
        currentShots: [
          {
            shotId: 'shot_1',
            version: {
              document: JSON.stringify({ content: { spoken_text: '你好' } }),
              id: 'shot_version_1',
            },
          },
          {
            shotId: 'shot_2',
            version: {
              document: JSON.stringify({ content: { spoken_text: '' } }),
              id: 'shot_version_2',
            },
          },
        ],
        history: [],
        historyTruncated: false,
      },
    } as never);
    const selected = (shotVersionId: string) => ({
      selectedAt: '2026-09-21T01:00:00.000Z',
      shotVersionId,
      status: 'SUCCEEDED',
    });
    const media: MediaUnitOfWorkPort = {
      run: (work) =>
        work({
          composition: {
            composition: {
              findLatestSucceededExport: vi.fn(() => Promise.resolve({ id: 'export_1' })),
            },
          },
          media: {
            listCandidates: vi.fn((shotId: string) =>
              Promise.resolve([
                selected(shotId === 'shot_1' ? 'shot_version_1' : 'shot_version_2'),
              ]),
            ),
          },
          video: {
            listCandidates: vi.fn((shotId: string) =>
              Promise.resolve([
                selected(shotId === 'shot_1' ? 'shot_version_1' : 'shot_version_2'),
              ]),
            ),
          },
          voice: {
            generation: {
              listCandidatesByShot: vi.fn(() => Promise.resolve([selected('shot_version_1')])),
            },
          },
        } as never),
    };
    const consistency = {
      getPreflight: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            missingItems: [],
            ready: true,
            shots: [],
            storyBibleValid: true,
            styleAssetVersionId: 'asset_version_style',
            warnings: [],
          },
        }),
      ),
    };

    await expect(
      createCreatorGuideQuery({ consistency, media, projects, scripts }).getProjectSnapshot(
        project.id,
      ),
    ).resolves.toMatchObject({
      consistencyBlocks: [],
      exportReady: true,
      imagesReady: true,
      videosReady: true,
      voiceReady: true,
    });
  });

  it('一致性预检缺少画风与角色—聚合为两个阻断且媒体不误报就绪', async () => {
    const { projects, scripts } = createHarness();
    scripts.getWorkspace.mockResolvedValue({
      projectId: project.id,
      sourceInput: { id: 'source_1' },
      episode: { id: 'episode_1' },
      stages: [],
      storyboard: {
        current: { status: 'READY' },
        currentShots: [{ shotId: 'shot_1', version: { document: '{}', id: 'version_1' } }],
        history: [],
        historyTruncated: false,
      },
    } as never);
    const consistency = {
      getPreflight: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            missingItems: [
              { bibleRefId: 'project-style', displayName: '项目画风', kind: 'STYLE' as const },
              { bibleRefId: 'char_1', displayName: '角色一', kind: 'CHARACTER' as const },
            ],
            ready: false,
            shots: [],
            storyBibleValid: true,
            styleAssetVersionId: null,
            warnings: [],
          },
        }),
      ),
    };
    const mediaRun = vi.fn();
    const media = { run: mediaRun } as unknown as MediaUnitOfWorkPort;

    await expect(
      createCreatorGuideQuery({ consistency, media, projects, scripts }).getProjectSnapshot(
        project.id,
      ),
    ).resolves.toMatchObject({
      consistencyBlocks: ['STYLE_REFERENCE', 'CHARACTER_REFERENCE'],
      imagesReady: false,
    });
    expect(mediaRun).not.toHaveBeenCalled();
  });
});
