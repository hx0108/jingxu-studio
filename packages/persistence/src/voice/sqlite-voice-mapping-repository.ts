import type { VoiceMappingRecord, VoiceMappingRepositoryPort } from '@jingxu/application';

import type { SqliteDatabase, SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

type Row = Readonly<Record<string, SqliteOutputValue>>;

const MAPPING_COLUMNS = 'project_id, speaker_id, voice_id, updated_at';

const mapMappingRow = (row: Row): VoiceMappingRecord => ({
  projectId: String(row.project_id),
  speakerId: String(row.speaker_id),
  updatedAt: String(row.updated_at),
  voiceId: String(row.voice_id),
});

/**
 * voice_mappings 的 SQLite 实现（v2-voice-audio-timeline tasks 4.2）：PK(project_id,
 * speaker_id) upsert 语义——replaceAll 以集合整体替换（同事务 DELETE + INSERT 原子）。
 * narrator 固定行与白名单校验在应用层（VoiceMappingService），仓库只存取。
 */
export class SqliteVoiceMappingRepository implements VoiceMappingRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public listByProject(projectId: string): Promise<readonly VoiceMappingRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          `SELECT ${MAPPING_COLUMNS} FROM voice_mappings
           WHERE project_id = ? ORDER BY speaker_id`,
        )
        .all(projectId)
        .map(mapMappingRow),
    );
  }

  public replaceAll(
    projectId: string,
    mappings: readonly VoiceMappingRecord[],
  ): Promise<readonly VoiceMappingRecord[]> {
    return syncToPromise(() => {
      const insert = this.database.prepare(
        `INSERT INTO voice_mappings (project_id, speaker_id, voice_id, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      this.database.prepare('DELETE FROM voice_mappings WHERE project_id = ?').run(projectId);
      for (const mapping of mappings) {
        try {
          insert.run(projectId, mapping.speakerId, mapping.voiceId, mapping.updatedAt);
        } catch {
          // PK(project_id, speaker_id) 兜底服务层漏检的重复行。
          throw new PersistenceRuntimeError('VOICE_MAPPING_DUPLICATE');
        }
      }
      const rows = this.database
        .prepare(
          `SELECT ${MAPPING_COLUMNS} FROM voice_mappings
           WHERE project_id = ? ORDER BY speaker_id`,
        )
        .all(projectId);
      return rows.map(mapMappingRow);
    });
  }
}
