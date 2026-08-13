import type {
  ScriptStageWorkspace,
  ScriptVersionDocument,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  StagedScriptStage,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import {
  SqliteEpisodeRepository,
  SqliteScriptVersionRepository,
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

  public constructor(database: SqliteDatabase) {
    this.sources = new SqliteSourceInputRepository(database);
    this.episodes = new SqliteEpisodeRepository(database);
    this.bibles = new SqliteStoryBibleVersionRepository(database);
    this.scripts = new SqliteScriptVersionRepository(database);
    this.heads = new SqliteStageHeadRepository(database);
  }

  public async getWorkspace(projectId: string): Promise<ScriptWorkspaceSnapshot | null> {
    const [sourceInput, episode] = await Promise.all([
      this.sources.findCreativeByProjectId(projectId),
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
    return { episode, projectId, sourceInput, stages };
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
