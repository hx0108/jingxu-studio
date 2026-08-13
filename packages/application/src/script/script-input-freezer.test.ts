import { describe, expect, it } from 'vitest';

import type {
  ScriptJobRepositories,
  ScriptVersion,
  SourceInput,
  StagedScriptStage,
  StoryBibleVersion,
} from '../ports/script/index';
import { freezeScriptJobInput, ScriptPrerequisiteError } from './script-input-freezer';

const source = {
  id: 'source-0001',
  projectId: 'project-0001',
  sha256: 'a'.repeat(64),
} as SourceInput;
const version = (
  stage: ScriptVersion['stage'],
  id: string,
  status: ScriptVersion['status'] = 'READY',
  projectId = 'project-0001',
) =>
  ({
    documentSha256: id.padEnd(64, 'a').slice(0, 64),
    episodeId: stage === 'CONCEPT' ? null : 'episode-0001',
    id,
    projectId,
    stage,
    status,
  }) as ScriptVersion;

interface RepositoryOptions {
  readonly conceptStatus?: ScriptVersion['status'];
  readonly episodeState?: 'ACTIVE' | 'DELETED' | 'MISSING' | 'OTHER_PROJECT';
  readonly missing?: 'SOURCE' | 'FORMAT' | StagedScriptStage;
  readonly wrongProjectStage?: StagedScriptStage;
}

const repositories = (options: RepositoryOptions = {}): ScriptJobRepositories => {
  const versions = new Map([
    [
      'concept-0001',
      version(
        'CONCEPT',
        'concept-0001',
        options.conceptStatus,
        options.wrongProjectStage === 'CONCEPT' ? 'project-other' : undefined,
      ),
    ],
    [
      'outline-0001',
      version(
        'EPISODE_OUTLINE',
        'outline-0001',
        'READY',
        options.wrongProjectStage === 'EPISODE_OUTLINE' ? 'project-other' : undefined,
      ),
    ],
    [
      'beat-0001',
      version(
        'BEAT_SHEET',
        'beat-0001',
        'READY',
        options.wrongProjectStage === 'BEAT_SHEET' ? 'project-other' : undefined,
      ),
    ],
  ]);
  const story: StoryBibleVersion = {
    documentSha256: 'b'.repeat(64),
    id: 'story-0001',
    projectId: options.wrongProjectStage === 'STORY_BIBLE' ? 'project-other' : 'project-0001',
    status: 'READY',
  } as StoryBibleVersion;
  return {
    episodes: {
      findById: () =>
        Promise.resolve(
          options.episodeState === 'MISSING'
            ? null
            : {
                deletedAt: options.episodeState === 'DELETED' ? '2026-08-13T00:00:00.000Z' : null,
                id: 'episode-0001',
                projectId:
                  options.episodeState === 'OTHER_PROJECT' ? 'project-other' : 'project-0001',
              },
        ),
    },
    formatProfiles: {
      findCurrent: () =>
        Promise.resolve(
          options.missing === 'FORMAT'
            ? null
            : ({ id: 'format-0001', projectId: 'project-0001' } as never),
        ),
    },
    scriptVersions: { findById: (id: string) => Promise.resolve(versions.get(id) ?? null) },
    sourceInputs: {
      findCreativeByProjectId: () => Promise.resolve(options.missing === 'SOURCE' ? null : source),
    },
    stageHeads: {
      find: (_projectId: string, _episodeId: string | null, stage: StagedScriptStage) => {
        if (options.missing === stage) return Promise.resolve(null);
        const id =
          stage === 'CONCEPT'
            ? 'concept-0001'
            : stage === 'STORY_BIBLE'
              ? 'story-0001'
              : stage === 'EPISODE_OUTLINE'
                ? 'outline-0001'
                : 'beat-0001';
        return Promise.resolve({ currentVersionId: id });
      },
    },
    storyBibleVersions: { findById: () => Promise.resolve(story) },
  } as unknown as ScriptJobRepositories;
};

const cases = [
  {
    episodeId: null,
    expected: 'source-0001',
    objectTypes: ['SOURCE_INPUT', 'FORMAT_PROFILE'],
    stage: 'CONCEPT',
  },
  {
    episodeId: null,
    expected: 'concept-0001',
    objectTypes: ['SCRIPT_VERSION'],
    stage: 'STORY_BIBLE',
  },
  {
    episodeId: 'episode-0001',
    expected: 'story-0001',
    objectTypes: ['SCRIPT_VERSION', 'STORY_BIBLE_VERSION', 'EPISODE'],
    stage: 'EPISODE_OUTLINE',
  },
  {
    episodeId: 'episode-0001',
    expected: 'outline-0001',
    objectTypes: ['SCRIPT_VERSION', 'STORY_BIBLE_VERSION'],
    stage: 'BEAT_SHEET',
  },
  {
    episodeId: 'episode-0001',
    expected: 'beat-0001',
    objectTypes: ['SCRIPT_VERSION', 'STORY_BIBLE_VERSION', 'FORMAT_PROFILE'],
    stage: 'SCENE_SCRIPT',
  },
] as const;

describe('freezeScriptJobInput', () => {
  it.each(cases)(
    '条件—$stage 全部前置 READY—按规范顺序冻结完整引用集合',
    async ({ episodeId, expected, objectTypes, stage }) => {
      const frozen = await freezeScriptJobInput(
        repositories(),
        {
          episodeId,
          expectedInputVersionId: expected,
          projectId: 'project-0001',
          stage,
        },
        () => 'f'.repeat(64),
      );
      expect(frozen.references.map(({ objectType }) => objectType)).toEqual(objectTypes);
      expect(frozen.references).toEqual(
        frozen.references.map(({ objectId, objectType, sha256, versionId }) => ({
          objectId,
          objectType,
          sha256,
          versionId,
        })),
      );
      expect(frozen.references.every(({ sha256 }) => sha256.length === 64)).toBe(true);
      expect(frozen.inputVersionsJson).toBe(JSON.stringify({ references: frozen.references }));
      expect(frozen.inputVersionSetHash).toBe('f'.repeat(64));
    },
  );

  it('条件—仓储返回相同快照—冻结集合排序、序列化与 hash 可重复', async () => {
    const command = {
      episodeId: 'episode-0001',
      expectedInputVersionId: 'story-0001',
      projectId: 'project-0001',
      stage: 'EPISODE_OUTLINE',
    } as const;
    const first = await freezeScriptJobInput(repositories(), command, () => 'f'.repeat(64));
    const second = await freezeScriptJobInput(repositories(), command, () => 'f'.repeat(64));

    expect(second).toEqual(first);
  });

  it('条件—主前置版本已变化—建 Job 前返回 STALE_INPUT', async () => {
    await expect(
      freezeScriptJobInput(
        repositories(),
        {
          episodeId: null,
          expectedInputVersionId: 'old-concept',
          projectId: 'project-0001',
          stage: 'STORY_BIBLE',
        },
        () => 'hash',
      ),
    ).rejects.toEqual(new ScriptPrerequisiteError('STALE_INPUT'));
  });

  it.each(['DRAFT', 'STALE_INPUT'] as const)(
    '条件—上游为 %s—阻断冻结且不降级读取',
    async (status) => {
      await expect(
        freezeScriptJobInput(
          repositories({ conceptStatus: status }),
          {
            episodeId: null,
            expectedInputVersionId: 'concept-0001',
            projectId: 'project-0001',
            stage: 'STORY_BIBLE',
          },
          () => 'hash',
        ),
      ).rejects.toMatchObject({ code: 'SCRIPT_STAGE_NOT_READY' });
    },
  );

  it.each(['MISSING', 'DELETED', 'OTHER_PROJECT'] as const)(
    '条件—集级阶段 Episode 为 %s—阻断创建 Job',
    async (episodeState) => {
      await expect(
        freezeScriptJobInput(
          repositories({ episodeState }),
          {
            episodeId: 'episode-0001',
            expectedInputVersionId: 'outline-0001',
            projectId: 'project-0001',
            stage: 'BEAT_SHEET',
          },
          () => 'hash',
        ),
      ).rejects.toMatchObject({ code: 'SCRIPT_STAGE_PREREQUISITE_MISSING' });
    },
  );

  it('条件—集级阶段没有 episodeId—Application 防御性阻断', async () => {
    await expect(
      freezeScriptJobInput(
        repositories(),
        {
          episodeId: null,
          expectedInputVersionId: 'outline-0001',
          projectId: 'project-0001',
          stage: 'BEAT_SHEET',
        },
        () => 'hash',
      ),
    ).rejects.toMatchObject({ code: 'SCRIPT_STAGE_PREREQUISITE_MISSING' });
  });

  it.each(['SOURCE', 'FORMAT', 'CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE'] as const)(
    '条件—必需前置 %s 缺失—返回稳定前置错误',
    async (missing) => {
      const target =
        missing === 'SOURCE' || missing === 'FORMAT'
          ? cases[0]
          : missing === 'CONCEPT'
            ? cases[1]
            : missing === 'STORY_BIBLE'
              ? cases[2]
              : cases[3];
      await expect(
        freezeScriptJobInput(
          repositories({ missing }),
          {
            episodeId: target.episodeId,
            expectedInputVersionId: target.expected,
            projectId: 'project-0001',
            stage: target.stage,
          },
          () => 'hash',
        ),
      ).rejects.toMatchObject({ code: 'SCRIPT_STAGE_PREREQUISITE_MISSING' });
    },
  );

  it.each(['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET'] as const)(
    '条件—前置 %s 属于另一项目—阻断跨项目冻结',
    async (wrongProjectStage) => {
      const target =
        wrongProjectStage === 'CONCEPT'
          ? cases[1]
          : wrongProjectStage === 'STORY_BIBLE'
            ? cases[2]
            : wrongProjectStage === 'EPISODE_OUTLINE'
              ? cases[3]
              : cases[4];
      await expect(
        freezeScriptJobInput(
          repositories({ wrongProjectStage }),
          {
            episodeId: target.episodeId,
            expectedInputVersionId: target.expected,
            projectId: 'project-0001',
            stage: target.stage,
          },
          () => 'hash',
        ),
      ).rejects.toMatchObject({ code: 'SCRIPT_STAGE_PREREQUISITE_MISSING' });
    },
  );
});
