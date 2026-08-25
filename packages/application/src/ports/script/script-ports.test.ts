import { describe, expect, it } from 'vitest';

import type { JobRepositoryPort, ModelInvocationRepositoryPort } from '../persistence/job';
import type {
  EpisodeVersion,
  ScriptJobRepositories,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  Shot,
  ShotContractVersion,
  SourceInput,
  StoryboardRepositories,
} from './index';

const sourceInput = {
  id: 'source-0001',
  projectId: 'project-0001',
  inputKind: 'CREATIVE',
  fileName: null,
  encoding: null,
  content: '保留原始空白的原创输入',
  charCount: 11,
  sha256: 'a'.repeat(64),
  createdAt: '2026-08-13T00:00:00.000Z',
} satisfies SourceInput;

describe('Script Application Ports', () => {
  it('条件—构造 SourceInput—只暴露领域字段且保留原始内容', () => {
    expect(sourceInput.content).toBe('保留原始空白的原创输入');
    expect(sourceInput).not.toHaveProperty('content_text');
    expect(sourceInput).not.toHaveProperty('row');
    expect(sourceInput).not.toHaveProperty('connection');
  });

  it('条件—组合 Script Job Repository—同一 UoW 回调可访问业务与 Job Port', async () => {
    const repositories = {
      jobs: {} as JobRepositoryPort,
      invocations: {} as ModelInvocationRepositoryPort,
      sourceInputs: {
        findById: () => Promise.resolve(null),
        findCreativeByProjectId: () => Promise.resolve(null),
        insert: () => Promise.resolve(),
      },
      consents: {} as ScriptJobRepositories['consents'],
      episodes: {} as ScriptJobRepositories['episodes'],
      episodeVersions: {} as ScriptJobRepositories['episodeVersions'],
      storyBibleVersions: {} as ScriptJobRepositories['storyBibleVersions'],
      scriptVersions: {} as ScriptJobRepositories['scriptVersions'],
      shotContractVersions: {} as ScriptJobRepositories['shotContractVersions'],
      locks: {} as ScriptJobRepositories['locks'],
      shots: {} as ScriptJobRepositories['shots'],
      stageHeads: {} as ScriptJobRepositories['stageHeads'],
      dependencies: {} as ScriptJobRepositories['dependencies'],
      audit: {} as ScriptJobRepositories['audit'],
      receipts: {} as ScriptJobRepositories['receipts'],
      formatProfiles: { findCurrent: () => Promise.resolve(null) },
    } satisfies ScriptJobRepositories;

    const unitOfWork: ScriptUnitOfWorkPort = {
      run: async (work) => work(repositories),
    };

    const result = await unitOfWork.run(async (ports) => {
      await ports.sourceInputs.insert(sourceInput);
      return ports.jobs === repositories.jobs && ports.invocations === repositories.invocations;
    });

    expect(result).toBe(true);
  });

  it('条件—只读工作区查询—返回快照而非 Repository 或连接', async () => {
    const query: ScriptWorkspaceQueryPort = {
      getWorkspace: () => Promise.resolve(null),
      getVersionDocument: () => Promise.resolve(null),
    };

    expect(await query.getWorkspace('project-0001')).toBeNull();
    expect(await query.getVersionDocument('project-0001', 'version-0001')).toBeNull();
  });

  it('条件—组合分镜仓储—整集快照与镜头版本可同一事务读写', async () => {
    const episodeVersion: EpisodeVersion = {
      createdAt: '2026-08-15T00:00:00.000Z',
      episodeId: 'episode-0001',
      formatProfileId: 'format-0001',
      id: 'episode-version-0001',
      parentId: null,
      shotSetHash: 'b'.repeat(64),
      status: 'DRAFT',
      storyBibleVersionId: 'story-bible-0001',
      targetDurationSec: 60,
      versionNo: 1,
    };
    const recorded: {
      episodeVersions: EpisodeVersion[];
      pointerUpdates: number;
      shotVersions: ShotContractVersion[];
      shots: Shot[];
    } = { episodeVersions: [], pointerUpdates: 0, shotVersions: [], shots: [] };
    const repositories: StoryboardRepositories = {
      episodeVersions: {
        findById: (id) => Promise.resolve(id === episodeVersion.id ? episodeVersion : null),
        findMaxVersionNo: () => Promise.resolve(episodeVersion.versionNo),
        insert: (version) => {
          recorded.episodeVersions.push(version);
          return Promise.resolve();
        },
        insertShotLinks: () => Promise.resolve(),
        listHistory: () => Promise.resolve([episodeVersion]),
        listShotLinks: () => Promise.resolve([]),
      },
      shotContractVersions: {
        findById: () => Promise.resolve(null),
        insertMany: (versions) => {
          recorded.shotVersions.push(...versions);
          return Promise.resolve();
        },
      },
      locks: {
        insert: () => Promise.resolve(),
        listActive: () => Promise.resolve([]),
        listActiveByObject: () => Promise.resolve([]),
        unlock: () => Promise.resolve(true),
      },
      shots: {
        findById: () => Promise.resolve(null),
        insertMany: (shots) => {
          recorded.shots.push(...shots);
          return Promise.resolve();
        },
        updateCurrentVersionIds: (entries) => {
          recorded.pointerUpdates += entries.length;
          return Promise.resolve();
        },
      },
    };

    await repositories.episodeVersions.insert(episodeVersion);
    await repositories.shotContractVersions.insertMany([]);
    await repositories.shots.updateCurrentVersionIds([]);

    expect(recorded).toEqual({
      episodeVersions: [episodeVersion],
      pointerUpdates: 0,
      shotVersions: [],
      shots: [],
    });
    expect(await repositories.episodeVersions.findById('episode-version-0001')).toEqual(
      episodeVersion,
    );
  });
});
