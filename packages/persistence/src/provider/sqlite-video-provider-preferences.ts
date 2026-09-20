import type {
  VideoProviderPreferencesPort,
  VideoProviderSelection,
  VideoProviderSelectionMode,
} from '@jingxu/application';
import { VIDEO_PROVIDER_PROFILE_BY_MODE } from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';

/** better-sqlite3 run() 结果的最小面（同 script-repositories 本地接口模式）。 */
interface RunResult {
  readonly changes: number;
}

const SELECT_SQL = `SELECT mode, provider_profile_id, updated_at
FROM video_provider_preferences
WHERE id = 1`;

/** 单行 CAS 更新：updated_at 比对失败即冲突（乐观并发），不做读取-修改-写回竞态。 */
const UPDATE_SQL = `UPDATE video_provider_preferences
SET mode = ?, provider_profile_id = ?, updated_at = ?
WHERE id = 1 AND updated_at = ?`;

interface PreferenceRow {
  readonly mode: string;
  readonly provider_profile_id: string;
  readonly updated_at: string;
}

const toSelection = (row: PreferenceRow): VideoProviderSelection => {
  if (row.mode !== 'SEEDANCE' && row.mode !== 'AGNES') {
    throw new PersistenceRuntimeError('VIDEO_PROVIDER_SELECTION_INVALID');
  }
  return {
    mode: row.mode,
    providerProfileId: row.provider_profile_id,
    updatedAt: row.updated_at,
  };
};

/** 视频当前 Provider 偏好（0023 单例表）；保存为原子 CAS，无需 UnitOfWork 协作。 */
export class SqliteVideoProviderPreferences implements VideoProviderPreferencesPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public get(): Promise<VideoProviderSelection | null> {
    return syncToPromise(() => {
      const row = this.database.prepare(SELECT_SQL).get() as PreferenceRow | undefined;
      return row === undefined ? null : toSelection(row);
    });
  }

  public save(
    expectedUpdatedAt: string | null,
    mode: VideoProviderSelectionMode,
    savedAt: string,
  ): Promise<VideoProviderSelection> {
    return syncToPromise(() => {
      const result = this.database
        .prepare(UPDATE_SQL)
        .run(
          mode,
          VIDEO_PROVIDER_PROFILE_BY_MODE[mode],
          savedAt,
          expectedUpdatedAt ?? '',
        ) as RunResult;
      if (result.changes !== 1) {
        throw new PersistenceRuntimeError('VIDEO_PROVIDER_SELECTION_CONFLICT');
      }
      return {
        mode,
        providerProfileId: VIDEO_PROVIDER_PROFILE_BY_MODE[mode],
        updatedAt: savedAt,
      } satisfies VideoProviderSelection;
    });
  }
}
