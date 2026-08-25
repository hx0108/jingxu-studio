import type { ScriptStage } from '@jingxu/contracts';

import type {
  ConsentRecord,
  ConsentRepositoryPort,
  Episode,
  EpisodeRepositoryPort,
  EpisodeVersion,
  EpisodeVersionRepositoryPort,
  EpisodeVersionShot,
  LockRecord,
  ScriptAuditEntry,
  ScriptAuditRepositoryPort,
  ScriptCommandReceipt,
  ScriptCommandReceiptRepositoryPort,
  ScriptDependency,
  ScriptDependencyRepositoryPort,
  ScriptVersion,
  ScriptVersionRepositoryPort,
  Shot,
  ShotContractVersion,
  ShotContractVersionRepositoryPort,
  ShotDerivation,
  ShotDerivationRepositoryPort,
  ShotLockRecord,
  ShotLockRepositoryPort,
  ShotRepositoryPort,
  SourceInput,
  SourceInputRepositoryPort,
  StageHead,
  StageHeadRepositoryPort,
  StoryBibleVersion,
  StoryBibleVersionRepositoryPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';
import {
  mapConsent,
  mapDependency,
  mapEpisode,
  mapEpisodeVersion,
  mapEpisodeVersionShot,
  mapReceipt,
  mapScriptVersion,
  mapShot,
  mapShotContractVersion,
  mapLockRecord,
  mapSourceInput,
  mapStageHead,
  mapStoryBibleVersion,
  type ScriptRow,
} from './script-row-mappers';

type Input = null | number | bigint | string | NodeJS.ArrayBufferView;
interface RunResult {
  readonly changes: number;
}

const get = <T>(
  database: SqliteDatabase,
  sql: string,
  args: readonly Input[],
  mapper: (row: ScriptRow) => T,
): T | null => {
  const row = database.prepare(sql).get(...args) as ScriptRow | undefined;
  return row === undefined ? null : mapper(row);
};

export class SqliteSourceInputRepository implements SourceInputRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<SourceInput | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, input_kind, file_name, encoding, content_text, char_count, sha256, created_at FROM source_inputs WHERE id=?',
        [id],
        mapSourceInput,
      ),
    );
  }
  public findCreativeByProjectId(projectId: string): Promise<SourceInput | null> {
    return syncToPromise(() =>
      get(
        this.db,
        "SELECT id, project_id, input_kind, file_name, encoding, content_text, char_count, sha256, created_at FROM source_inputs WHERE project_id=? AND input_kind='CREATIVE' ORDER BY created_at DESC, id DESC LIMIT 1",
        [projectId],
        mapSourceInput,
      ),
    );
  }
  public findLatestByProjectId(projectId: string): Promise<SourceInput | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, input_kind, file_name, encoding, content_text, char_count, sha256, created_at FROM source_inputs WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
        [projectId],
        mapSourceInput,
      ),
    );
  }
  public insert(value: SourceInput): Promise<void> {
    return syncToPromise(() => {
      const min = value.inputKind === 'CREATIVE' ? 20 : 1;
      const max = value.inputKind === 'CREATIVE' ? 2_000 : 30_000;
      if (
        value.charCount < min ||
        value.charCount > max ||
        value.content.trim().length === 0 ||
        Array.from(value.content).length !== value.charCount ||
        createHash('sha256').update(value.content, 'utf8').digest('hex') !== value.sha256
      ) {
        throw new PersistenceRuntimeError('SCRIPT_SOURCE_INPUT_INVALID');
      }
      this.db
        .prepare(
          'INSERT INTO source_inputs (id, project_id, input_kind, file_name, encoding, content_text, char_count, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          value.id,
          value.projectId,
          value.inputKind,
          value.fileName,
          value.encoding,
          value.content,
          value.charCount,
          value.sha256,
          value.createdAt,
        );
    });
  }
}
export class SqliteConsentRepository implements ConsentRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findDataProcessingBySourceInputId(id: string): Promise<ConsentRecord | null> {
    return syncToPromise(() =>
      get(
        this.db,
        "SELECT id, project_id, source_input_id, consent_type, content_source, scope, statement_text, confirmed_at, revoked_at FROM consent_records WHERE source_input_id=? AND consent_type='DATA_PROCESSING' AND revoked_at IS NULL ORDER BY confirmed_at DESC, id DESC LIMIT 1",
        [id],
        mapConsent,
      ),
    );
  }
  public insert(value: ConsentRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO consent_records (id, project_id, source_input_id, consent_type, content_source, scope, statement_text, confirmed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          value.id,
          value.projectId,
          value.sourceInputId,
          value.consentType,
          value.contentSource,
          value.scope,
          value.statement,
          value.confirmedAt,
          value.revokedAt,
        );
    });
  }
}
export class SqliteEpisodeRepository implements EpisodeRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<Episode | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at, deleted_at FROM episodes WHERE id=?',
        [id],
        mapEpisode,
      ),
    );
  }
  public findActiveByProjectId(projectId: string): Promise<Episode | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at, deleted_at FROM episodes WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1',
        [projectId],
        mapEpisode,
      ),
    );
  }
  public insert(value: Episode): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO episodes (id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          value.id,
          value.projectId,
          value.title,
          value.targetDurationSec,
          value.currentVersionId,
          value.createdAt,
          value.updatedAt,
          value.deletedAt,
        );
    });
  }
}
export class SqliteStoryBibleVersionRepository implements StoryBibleVersionRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<StoryBibleVersion | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, version_no, parent_id, document_json, document_sha256, status, source, source_invocation_id, created_at FROM story_bible_versions WHERE id=?',
        [id],
        mapStoryBibleVersion,
      ),
    );
  }
  public findMaxVersionNo(projectId: string): Promise<number> {
    return syncToPromise(
      () =>
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(version_no),0) AS value FROM story_bible_versions WHERE project_id=?',
            )
            .get(projectId) as { value: number }
        ).value,
    );
  }
  public listHistory(
    projectId: string,
    before: number | null,
    limit: number,
  ): Promise<readonly StoryBibleVersion[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT id, project_id, version_no, parent_id, document_json, document_sha256, status, source, source_invocation_id, created_at FROM story_bible_versions WHERE project_id=? AND (? IS NULL OR version_no < ?) ORDER BY version_no DESC LIMIT ?',
          )
          .all(projectId, before, before, limit) as ScriptRow[]
      ).map(mapStoryBibleVersion),
    );
  }
  public insert(v: StoryBibleVersion): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO story_bible_versions (id, project_id, version_no, parent_id, document_json, document_sha256, status, source, source_invocation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.id,
          v.projectId,
          v.versionNo,
          v.parentId,
          v.document,
          v.documentSha256,
          v.status,
          v.source,
          v.sourceInvocationId,
          v.createdAt,
        );
    });
  }
}
export class SqliteScriptVersionRepository implements ScriptVersionRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<ScriptVersion | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, project_id, episode_id, stage, version_no, parent_id, source_input_id, document_json, document_sha256, status, change_summary, source, source_invocation_id, created_at FROM script_versions WHERE id=?',
        [id],
        mapScriptVersion,
      ),
    );
  }
  public findMaxVersionNo(
    projectId: string,
    episodeId: string | null,
    stage: ScriptVersion['stage'],
  ): Promise<number> {
    return syncToPromise(
      () =>
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(version_no),0) AS value FROM script_versions WHERE project_id=? AND episode_id IS ? AND stage=?',
            )
            .get(projectId, episodeId, stage) as { value: number }
        ).value,
    );
  }
  public listHistory(
    projectId: string,
    episodeId: string | null,
    stage: ScriptVersion['stage'],
    before: number | null,
    limit: number,
  ): Promise<readonly ScriptVersion[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT id, project_id, episode_id, stage, version_no, parent_id, source_input_id, document_json, document_sha256, status, change_summary, source, source_invocation_id, created_at FROM script_versions WHERE project_id=? AND episode_id IS ? AND stage=? AND (? IS NULL OR version_no < ?) ORDER BY version_no DESC LIMIT ?',
          )
          .all(projectId, episodeId, stage, before, before, limit) as ScriptRow[]
      ).map(mapScriptVersion),
    );
  }
  public insert(v: ScriptVersion): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO script_versions (id, project_id, episode_id, stage, version_no, parent_id, source_input_id, document_json, document_sha256, status, change_summary, source, source_invocation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.id,
          v.projectId,
          v.episodeId,
          v.stage,
          v.versionNo,
          v.parentId,
          v.sourceInputId,
          v.document,
          v.documentSha256,
          v.status,
          v.changeSummary,
          v.source,
          v.sourceInvocationId,
          v.createdAt,
        );
    });
  }
}
export class SqliteStageHeadRepository implements StageHeadRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public find(
    projectId: string,
    episodeId: string | null,
    stage: ScriptStage,
  ): Promise<StageHead | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT project_id, episode_id, stage, current_version_type, current_version_id, updated_at FROM stage_heads WHERE project_id=? AND episode_id IS ? AND stage=?',
        [projectId, episodeId, stage],
        mapStageHead,
      ),
    );
  }
  public listByProjectId(projectId: string): Promise<readonly StageHead[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT project_id, episode_id, stage, current_version_type, current_version_id, updated_at FROM stage_heads WHERE project_id=? ORDER BY stage, episode_id, current_version_id',
          )
          .all(projectId) as ScriptRow[]
      ).map(mapStageHead),
    );
  }
  public upsert(h: StageHead, expected: string | null): Promise<boolean> {
    return syncToPromise(() => {
      if (expected === null) {
        const result = this.db
          .prepare(
            'INSERT INTO stage_heads (project_id, episode_id, stage, current_version_type, current_version_id, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM stage_heads WHERE project_id=? AND episode_id IS ? AND stage=?)',
          )
          .run(
            h.projectId,
            h.episodeId,
            h.stage,
            h.currentVersionType,
            h.currentVersionId,
            h.updatedAt,
            h.projectId,
            h.episodeId,
            h.stage,
          ) as RunResult;
        return result.changes === 1;
      }
      const result = this.db
        .prepare(
          'UPDATE stage_heads SET current_version_type=?, current_version_id=?, updated_at=? WHERE project_id=? AND episode_id IS ? AND stage=? AND current_version_id=?',
        )
        .run(
          h.currentVersionType,
          h.currentVersionId,
          h.updatedAt,
          h.projectId,
          h.episodeId,
          h.stage,
          expected,
        ) as RunResult;
      return result.changes === 1;
    });
  }
}
export class SqliteScriptDependencyRepository implements ScriptDependencyRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public listByUpstreamVersionIds(
    projectId: string,
    ids: readonly string[],
  ): Promise<readonly ScriptDependency[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return syncToPromise(() => {
      const placeholders = ids.map(() => '?').join(',');
      return (
        this.db
          .prepare(
            `SELECT id, project_id, upstream_type, upstream_id, upstream_version_id, downstream_type, downstream_id, downstream_version_id, dependency_type, created_at FROM dependency_edges WHERE project_id=? AND upstream_version_id IN (${placeholders}) ORDER BY upstream_version_id, downstream_version_id, dependency_type, id`,
          )
          .all(projectId, ...ids) as ScriptRow[]
      ).map(mapDependency);
    });
  }
  public insertMany(values: readonly ScriptDependency[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'INSERT OR IGNORE INTO dependency_edges (id, project_id, upstream_type, upstream_id, upstream_version_id, downstream_type, downstream_id, downstream_version_id, dependency_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const v of values)
        statement.run(
          v.id,
          v.projectId,
          v.upstreamType,
          v.upstreamId,
          v.upstreamVersionId,
          v.downstreamType,
          v.downstreamId,
          v.downstreamVersionId,
          v.dependencyType,
          v.createdAt,
        );
    });
  }
}
export class SqliteScriptAuditRepository implements ScriptAuditRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public record(v: ScriptAuditEntry): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO audit_events (id, project_id, actor, action, object_type, object_id, object_version_id, before_sha256, after_sha256, metadata_json, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.id,
          v.projectId,
          v.actor,
          v.action,
          v.objectType,
          v.objectId,
          v.objectVersionId,
          v.beforeSha256,
          v.afterSha256,
          JSON.stringify(v.metadata),
          v.traceId,
          v.createdAt,
        );
    });
  }
}
export class SqliteScriptCommandReceiptRepository implements ScriptCommandReceiptRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findByRequestId(id: string): Promise<ScriptCommandReceipt | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at FROM command_receipts WHERE request_id=?',
        [id],
        mapReceipt,
      ),
    );
  }
  public insert(v: ScriptCommandReceipt): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO command_receipts (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.requestId,
          v.commandName,
          v.payloadSha256,
          v.projectId,
          JSON.stringify(v.resultRef),
          v.traceId,
          v.committedAt,
        );
    });
  }
}
export class SqliteEpisodeVersionRepository implements EpisodeVersionRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<EpisodeVersion | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id, target_duration_sec, shot_set_hash, status, created_at FROM episode_versions WHERE id=?',
        [id],
        mapEpisodeVersion,
      ),
    );
  }
  public findMaxVersionNo(episodeId: string): Promise<number> {
    return syncToPromise(
      () =>
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(version_no),0) AS value FROM episode_versions WHERE episode_id=?',
            )
            .get(episodeId) as { value: number }
        ).value,
    );
  }
  public listHistory(
    episodeId: string,
    before: number | null,
    limit: number,
  ): Promise<readonly EpisodeVersion[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id, target_duration_sec, shot_set_hash, status, created_at FROM episode_versions WHERE episode_id=? AND (? IS NULL OR version_no < ?) ORDER BY version_no DESC LIMIT ?',
          )
          .all(episodeId, before, before, limit) as ScriptRow[]
      ).map(mapEpisodeVersion),
    );
  }
  public insert(v: EpisodeVersion): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO episode_versions (id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id, target_duration_sec, shot_set_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.id,
          v.episodeId,
          v.versionNo,
          v.parentId,
          v.storyBibleVersionId,
          v.formatProfileId,
          v.targetDurationSec,
          v.shotSetHash,
          v.status,
          v.createdAt,
        );
    });
  }
  public listShotLinks(episodeVersionId: string): Promise<readonly EpisodeVersionShot[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT episode_version_id, shot_id, shot_version_id, sequence FROM episode_version_shots WHERE episode_version_id=? ORDER BY sequence, shot_id',
          )
          .all(episodeVersionId) as ScriptRow[]
      ).map(mapEpisodeVersionShot),
    );
  }
  public insertShotLinks(links: readonly EpisodeVersionShot[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'INSERT INTO episode_version_shots (episode_version_id, shot_id, shot_version_id, sequence) VALUES (?, ?, ?, ?)',
      );
      for (const link of links)
        statement.run(link.episodeVersionId, link.shotId, link.shotVersionId, link.sequence);
    });
  }
}
export class SqliteShotRepository implements ShotRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<Shot | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, episode_id, lifecycle_status, current_version_id, created_at, updated_at, deleted_at FROM shots WHERE id=?',
        [id],
        mapShot,
      ),
    );
  }
  public insertMany(values: readonly Shot[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'INSERT INTO shots (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const v of values)
        statement.run(
          v.id,
          v.episodeId,
          v.lifecycleStatus,
          v.currentVersionId,
          v.createdAt,
          v.updatedAt,
          v.deletedAt,
        );
    });
  }
  public updateCurrentVersionIds(
    entries: readonly Readonly<{ shotId: string; currentVersionId: string; updatedAt: string }>[],
  ): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'UPDATE shots SET current_version_id=?, updated_at=? WHERE id=?',
      );
      for (const entry of entries)
        statement.run(entry.currentVersionId, entry.updatedAt, entry.shotId);
    });
  }
  public updateLifecycleStatuses(
    entries: readonly Readonly<{
      shotId: string;
      status: Shot['lifecycleStatus'];
      updatedAt: string;
      deletedAt: string | null;
    }>[],
  ): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'UPDATE shots SET lifecycle_status=?, updated_at=?, deleted_at=? WHERE id=?',
      );
      for (const entry of entries)
        statement.run(entry.status, entry.updatedAt, entry.deletedAt, entry.shotId);
    });
  }
}

export class SqliteShotDerivationRepository implements ShotDerivationRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public insertMany(values: readonly ShotDerivation[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'INSERT INTO shot_derivations (new_shot_id, source_shot_id, operation, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const value of values)
        statement.run(value.newShotId, value.sourceShotId, value.operation, value.createdAt);
    });
  }
}
export class SqliteShotContractVersionRepository implements ShotContractVersionRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public findById(id: string): Promise<ShotContractVersion | null> {
    return syncToPromise(() =>
      get(
        this.db,
        'SELECT id, shot_id, version_no, parent_id, external_parent_version_id, lineage_resolution_status, sequence, version_status, format_profile_id, target_duration_sec, dialogue_render_mode, document_json, document_sha256, source_invocation_id, created_at FROM shot_contract_versions WHERE id=?',
        [id],
        mapShotContractVersion,
      ),
    );
  }
  public insertMany(values: readonly ShotContractVersion[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        'INSERT INTO shot_contract_versions (id, shot_id, version_no, parent_id, external_parent_version_id, lineage_resolution_status, sequence, version_status, format_profile_id, target_duration_sec, dialogue_render_mode, document_json, document_sha256, source_invocation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const v of values)
        statement.run(
          v.id,
          v.shotId,
          v.versionNo,
          v.parentId,
          v.externalParentVersionId,
          v.lineageResolutionStatus,
          v.sequence,
          v.versionStatus,
          v.formatProfileId,
          v.targetDurationSec,
          v.dialogueRenderMode,
          v.document,
          v.documentSha256,
          v.sourceInvocationId,
          v.createdAt,
        );
    });
  }
}
export class SqliteShotLockRepository implements ShotLockRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public listActive(projectId: string, shotId: string): Promise<readonly ShotLockRecord[]> {
    return syncToPromise(
      () =>
        (
          this.db
            .prepare(
              "SELECT id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, note, locked_at, unlocked_at FROM lock_records WHERE project_id=? AND object_type='SHOT_CONTRACT' AND object_id=? AND unlocked_at IS NULL ORDER BY locked_at, id",
            )
            .all(projectId, shotId) as ScriptRow[]
        ).map(mapLockRecord) as readonly ShotLockRecord[],
    );
  }
  public listActiveByObject(
    projectId: string,
    objectType: LockRecord['objectType'],
    objectId: string,
  ): Promise<readonly LockRecord[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            'SELECT id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, note, locked_at, unlocked_at FROM lock_records WHERE project_id=? AND object_type=? AND object_id=? AND unlocked_at IS NULL ORDER BY locked_at, id',
          )
          .all(projectId, objectType, objectId) as ScriptRow[]
      ).map(mapLockRecord),
    );
  }
  public insert(v: LockRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO lock_records (id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, note, locked_at, unlocked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          v.id,
          v.projectId,
          v.objectType,
          v.objectId,
          v.objectVersionId,
          v.jsonPointer,
          v.lockedBy,
          v.note,
          v.lockedAt,
          v.unlockedAt,
        );
    });
  }
  public unlock(id: string, unlockedAt: string): Promise<boolean> {
    return syncToPromise(() => {
      const result = this.db
        .prepare('UPDATE lock_records SET unlocked_at=? WHERE id=? AND unlocked_at IS NULL')
        .run(unlockedAt, id) as RunResult;
      return result.changes === 1;
    });
  }
}
import { createHash } from 'node:crypto';
