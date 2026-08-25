import type {
  ScriptStageWorkspace,
  ScriptVersionDocument,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  StagedScriptStage,
  StoryboardShotSnapshot,
  StoryboardWorkspace,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import {
  SqliteEpisodeRepository,
  SqliteEpisodeVersionRepository,
  SqliteScriptVersionRepository,
  SqliteShotContractVersionRepository,
  SqliteSourceInputRepository,
  SqliteStageHeadRepository,
  SqliteStoryBibleVersionRepository,
} from './sqlite-script-repositories';

const STAGES = [
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
] as const satisfies readonly StagedScriptStage[];
const HISTORY_LIMIT = 50;

export class SqliteScriptWorkspaceQuery implements ScriptWorkspaceQueryPort {
  private readonly sources: SqliteSourceInputRepository;
  private readonly episodes: SqliteEpisodeRepository;
  private readonly bibles: SqliteStoryBibleVersionRepository;
  private readonly scripts: SqliteScriptVersionRepository;
  private readonly heads: SqliteStageHeadRepository;
  private readonly episodeVersions: SqliteEpisodeVersionRepository;
  private readonly shotContractVersions: SqliteShotContractVersionRepository;

  public constructor(database: SqliteDatabase) {
    this.sources = new SqliteSourceInputRepository(database);
    this.episodes = new SqliteEpisodeRepository(database);
    this.bibles = new SqliteStoryBibleVersionRepository(database);
    this.scripts = new SqliteScriptVersionRepository(database);
    this.heads = new SqliteStageHeadRepository(database);
    this.episodeVersions = new SqliteEpisodeVersionRepository(database);
    this.shotContractVersions = new SqliteShotContractVersionRepository(database);
  }

  public async getWorkspace(projectId: string): Promise<ScriptWorkspaceSnapshot | null> {
    const [sourceInput, episode] = await Promise.all([
      this.sources.findLatestByProjectId(projectId),
      this.episodes.findActiveByProjectId(projectId),
    ]);
    if (sourceInput === null && episode === null) return null;
    const stages: ScriptStageWorkspace[] = [];
    for (const stage of STAGES) {
      const episodeId =
        stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : (episode?.id ?? null);
      const head = await this.heads.find(projectId, episodeId, stage);
      const versions =
        stage === 'STORY_BIBLE'
          ? await this.bibles.listHistory(projectId, null, HISTORY_LIMIT + 1)
          : await this.scripts.listHistory(projectId, episodeId, stage, null, HISTORY_LIMIT + 1);
      const current =
        head === null
          ? null
          : stage === 'STORY_BIBLE'
            ? await this.bibles.findById(head.currentVersionId)
            : await this.scripts.findById(head.currentVersionId);
      stages.push({
        current,
        episodeId,
        head,
        history: versions.slice(0, HISTORY_LIMIT).map((version) => ({
          createdAt: version.createdAt,
          id: version.id,
          parentId: version.parentId,
          source: version.source,
          status: version.status,
          versionNo: version.versionNo,
        })),
        historyTruncated: versions.length > HISTORY_LIMIT,
        stage,
      });
    }
    return {
      episode,
      projectId,
      sourceInput,
      stages,
      storyboard: await this.getStoryboard(projectId, episode),
    };
  }

  /** SHOT_CONTRACT 读模型：阶段头 → 当前整集 + 当前集合镜头（sequence 升序）+ 有界历史。 */
  private async getStoryboard(
    projectId: string,
    episode: Awaited<ReturnType<SqliteEpisodeRepository['findActiveByProjectId']>>,
  ): Promise<StoryboardWorkspace> {
    if (episode === null) {
      return { current: null, currentShots: [], history: [], historyTruncated: false };
    }
    const [head, versions] = await Promise.all([
      this.heads.find(projectId, episode.id, 'SHOT_CONTRACT'),
      this.episodeVersions.listHistory(episode.id, null, HISTORY_LIMIT + 1),
    ]);
    let current = null;
    let currentShots: StoryboardShotSnapshot[] = [];
    if (head !== null) {
      const headVersion = await this.episodeVersions.findById(head.currentVersionId);
      if (headVersion === null) throw new Error('EPISODE_VERSION_NOT_FOUND');
      current = headVersion;
      const links = await this.episodeVersions.listShotLinks(headVersion.id);
      currentShots = [];
      for (const link of links) {
        const version = await this.shotContractVersions.findById(link.shotVersionId);
        if (version === null) throw new Error('SHOT_CONTRACT_VERSION_NOT_FOUND');
        currentShots.push({ sequence: link.sequence, shotId: link.shotId, version });
      }
    }
    const history = await Promise.all(
      versions.slice(0, HISTORY_LIMIT).map(async (version) => ({
        shotCount: (await this.episodeVersions.listShotLinks(version.id)).length,
        version,
      })),
    );
    return { current, currentShots, history, historyTruncated: versions.length > HISTORY_LIMIT };
  }

  public async getVersionDocument(
    projectId: string,
    versionId: string,
  ): Promise<ScriptVersionDocument | null> {
    const bible = await this.bibles.findById(versionId);
    if (bible !== null) {
      return bible.projectId === projectId
        ? {
            document: bible.document,
            documentSha256: bible.documentSha256,
            stage: 'STORY_BIBLE',
            versionId: bible.id,
          }
        : null;
    }
    const script = await this.scripts.findById(versionId);
    return script?.projectId === projectId
      ? {
          document: script.document,
          documentSha256: script.documentSha256,
          stage: script.stage,
          versionId: script.id,
        }
      : null;
  }
}
