import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  Episode,
  EpisodeVersion,
  Shot,
  ShotContractVersion,
  StoryBibleVersion,
} from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteScriptUnitOfWork } from './sqlite-script-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-13T00:00:00.000Z';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const open = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'storyboard.sqlite'));
  database.pragma('foreign_keys = ON');
  applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES ('project_storyboard', '分镜项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_storyboard', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES ('format_storyboard', 'project_storyboard', 1, '9:16', 1080, 1920, 24, 'zh-CN',
               '{"top":5,"right":5,"bottom":10,"left":5}', 1, ?)`,
    )
    .run(NOW);
  return database;
};

const seedStoryBibleAndEpisode = async (
  unitOfWork: SqliteScriptUnitOfWork,
): Promise<{ storyBibleVersionId: string; episodeId: string }> => {
  const storyBible: StoryBibleVersion = {
    createdAt: NOW,
    document: JSON.stringify({ data: { title: '雨夜车站' } }),
    documentSha256: hash('storyboard-bible'),
    id: 'sbv_storyboard_1',
    parentId: null,
    projectId: 'project_storyboard',
    source: 'AI',
    sourceInvocationId: null,
    status: 'READY',
    versionNo: 1,
  };
  const episode: Episode = {
    createdAt: NOW,
    currentVersionId: null,
    deletedAt: null,
    id: 'episode_storyboard',
    projectId: 'project_storyboard',
    targetDurationSec: 90,
    title: '第一集',
    updatedAt: NOW,
  };
  await unitOfWork.run(async (repositories) => {
    await repositories.storyBibleVersions.insert(storyBible);
    await repositories.episodes.insert(episode);
  });
  return { episodeId: episode.id, storyBibleVersionId: storyBible.id };
};

/** 构造满足 document_json 列绑定 CHECK 的 ShotContractVersion。 */
const shotVersion = (overrides: Partial<ShotContractVersion> = {}): ShotContractVersion => {
  const value: ShotContractVersion = {
    createdAt: NOW,
    dialogueRenderMode: 'NARRATION_FIRST',
    document: '',
    documentSha256: hash('shot-document'),
    externalParentVersionId: null,
    formatProfileId: 'format_storyboard',
    id: 'scv_storyboard_1_v1',
    lineageResolutionStatus: 'ROOT',
    parentId: null,
    sequence: 1,
    shotId: 'shot_storyboard_1',
    sourceInvocationId: null,
    targetDurationSec: 12,
    versionNo: 1,
    versionStatus: 'DRAFT',
    ...overrides,
  };
  const document = {
    contract_version: value.versionNo,
    dialogue: { dialogue_render_mode: value.dialogueRenderMode },
    format_profile_id: value.formatProfileId,
    parent_version_id: value.parentId,
    sequence: value.sequence,
    shot_id: value.shotId,
    status: value.versionStatus,
    target_duration_sec: value.targetDurationSec,
    version_id: value.id,
  };
  return {
    ...value,
    document: JSON.stringify(document),
    documentSha256: hash(JSON.stringify(document)),
  };
};

const episodeVersion = (overrides: Partial<EpisodeVersion> = {}): EpisodeVersion => ({
  createdAt: NOW,
  episodeId: 'episode_storyboard',
  formatProfileId: 'format_storyboard',
  id: 'epv_storyboard_1',
  parentId: null,
  shotSetHash: hash('shot-set'),
  status: 'DRAFT',
  storyBibleVersionId: 'sbv_storyboard_1',
  targetDurationSec: 90,
  versionNo: 1,
  ...overrides,
});

const shotRow = (id: string): Shot => ({
  createdAt: NOW,
  currentVersionId: null,
  deletedAt: null,
  episodeId: 'episode_storyboard',
  id,
  lifecycleStatus: 'ACTIVE',
  updatedAt: NOW,
});

describe('SQLite Storyboard repositories（episode_versions / shots / shot_contract_versions / episode_version_shots）', () => {
  it('GENERATE 快照—单事务四表写入—读回完整且 sequence 有序', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await seedStoryBibleAndEpisode(unitOfWork);

        const versions = [
          shotVersion(),
          shotVersion({
            id: 'scv_storyboard_2_v1',
            sequence: 2,
            shotId: 'shot_storyboard_2',
          }),
        ];
        const episode = episodeVersion();
        await unitOfWork.run(async (repositories) => {
          await repositories.episodeVersions.insert(episode);
          await repositories.shots.insertMany([
            shotRow('shot_storyboard_1'),
            shotRow('shot_storyboard_2'),
          ]);
          await repositories.shotContractVersions.insertMany(versions);
          await repositories.episodeVersions.insertShotLinks([
            {
              episodeVersionId: episode.id,
              sequence: 2,
              shotId: 'shot_storyboard_2',
              shotVersionId: versions[1]?.id ?? '',
            },
            {
              episodeVersionId: episode.id,
              sequence: 1,
              shotId: 'shot_storyboard_1',
              shotVersionId: versions[0]?.id ?? '',
            },
          ]);
        });

        expect(
          await unitOfWork.run((repositories) => repositories.episodeVersions.findById(episode.id)),
        ).toEqual(episode);
        expect(
          await unitOfWork.run((repositories) =>
            repositories.episodeVersions.findMaxVersionNo('episode_storyboard'),
          ),
        ).toBe(1);
        const links = await unitOfWork.run((repositories) =>
          repositories.episodeVersions.listShotLinks(episode.id),
        );
        expect(links.map((link) => link.sequence)).toEqual([1, 2]);
        expect(links[0]?.shotVersionId).toBe('scv_storyboard_1_v1');
        expect(
          await unitOfWork.run((repositories) =>
            repositories.shotContractVersions.findById(versions[0]?.id ?? ''),
          ),
        ).toEqual(versions[0]);
        expect(
          (await unitOfWork.run((repositories) => repositories.shots.findById('shot_storyboard_1')))
            ?.lifecycleStatus,
        ).toBe('ACTIVE');
      } finally {
        database.close();
      }
    });
  });

  it('document_json 列绑定 CHECK—文档与列不一致—拒绝写入', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await seedStoryBibleAndEpisode(unitOfWork);
        await unitOfWork.run(async (repositories) => {
          await repositories.shots.insertMany([shotRow('shot_storyboard_1')]);
        });

        const mismatched = shotVersion({ versionStatus: 'READY' });
        const forged = {
          ...mismatched,
          document: mismatched.document.replace('"status":"READY"', '"status":"DRAFT"'),
        };
        await expect(
          unitOfWork.run((repositories) => repositories.shotContractVersions.insertMany([forged])),
        ).rejects.toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('UNIQUE(shot_id, version_no)—同镜头同版本号—拒绝第二次写入', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await seedStoryBibleAndEpisode(unitOfWork);
        const version = shotVersion();
        await unitOfWork.run(async (repositories) => {
          await repositories.shots.insertMany([shotRow('shot_storyboard_1')]);
          await repositories.shotContractVersions.insertMany([version]);
        });
        const duplicate = shotVersion({ id: 'scv_storyboard_1_v1_again' });
        await expect(
          unitOfWork.run((repositories) =>
            repositories.shotContractVersions.insertMany([duplicate]),
          ),
        ).rejects.toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('不可变版本触发器—UPDATE episode_versions / shot_contract_versions—必须 ABORT', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await seedStoryBibleAndEpisode(unitOfWork);
        const version = shotVersion();
        await unitOfWork.run(async (repositories) => {
          await repositories.episodeVersions.insert(episodeVersion());
          await repositories.shots.insertMany([shotRow('shot_storyboard_1')]);
          await repositories.shotContractVersions.insertMany([version]);
        });
        expect(() =>
          database
            .prepare("UPDATE episode_versions SET status='STALE_INPUT' WHERE id='epv_storyboard_1'")
            .run(),
        ).toThrow(/IMMUTABLE_VERSION_ROW/);
        expect(() =>
          database
            .prepare(
              "UPDATE shot_contract_versions SET version_status='READY' WHERE id='scv_storyboard_1_v1'",
            )
            .run(),
        ).toThrow(/IMMUTABLE_VERSION_ROW/);
      } finally {
        database.close();
      }
    });
  });

  it('shots 行—updateCurrentVersionIds 推进指针且 updated_at 前进', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await seedStoryBibleAndEpisode(unitOfWork);
        await unitOfWork.run(async (repositories) => {
          await repositories.shots.insertMany([shotRow('shot_storyboard_1')]);
        });
        const later = '2026-08-14T00:00:00.000Z';
        await unitOfWork.run((repositories) =>
          repositories.shots.updateCurrentVersionIds([
            {
              currentVersionId: 'scv_storyboard_1_v2',
              shotId: 'shot_storyboard_1',
              updatedAt: later,
            },
          ]),
        );
        const shot = await unitOfWork.run((repositories) =>
          repositories.shots.findById('shot_storyboard_1'),
        );
        expect(shot?.currentVersionId).toBe('scv_storyboard_1_v2');
        expect(shot?.updatedAt).toBe(later);
      } finally {
        database.close();
      }
    });
  });
});
