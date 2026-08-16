import type {
  MediaAssetRecord,
  MediaAssetType,
  MediaAssetVersionRecord,
  MediaAssetWithVersions,
  MediaCandidateRecord,
  MediaRepository,
  MediaStaleAffectedShot,
  MediaTaskPhase,
  MediaTaskRecord,
} from '@jingxu/application';

import type { SqliteDatabase, SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

type Row = Readonly<Record<string, SqliteOutputValue>>;

const MEDIA_ROW_CORRUPT = 'MEDIA_ROW_CORRUPT';

const corrupt = (): never => {
  throw new PersistenceRuntimeError(MEDIA_ROW_CORRUPT);
};

const requiredString = (row: Row, column: string): string => {
  const value = row[column];
  return typeof value === 'string' && value.length > 0 ? value : corrupt();
};

const nullableString = (row: Row, column: string): string | null => {
  const value = row[column];
  if (value === null) return null;
  return typeof value === 'string' ? value : corrupt();
};

const requiredNumber = (row: Row, column: string): number => {
  const value = row[column];
  return typeof value === 'number' && Number.isFinite(value) ? value : corrupt();
};

const nullableNumber = (row: Row, column: string): number | null => {
  const value = row[column];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : corrupt();
};

/** assets 行映射；统一以 asset_id 别名读取 id（listAssets 的 JOIN 与单表查询共用）。 */
const mapAssetRow = (row: Row): MediaAssetRecord => ({
  assetType: requiredString(row, 'asset_type') as MediaAssetType,
  bibleRefId: requiredString(row, 'bible_ref_id'),
  createdAt: requiredString(row, 'created_at'),
  displayName: requiredString(row, 'display_name'),
  id: requiredString(row, 'asset_id'),
  projectId: requiredString(row, 'project_id'),
  updatedAt: requiredString(row, 'updated_at'),
});

/** listAssets 的 LEFT JOIN 行映射（version_* 为 v 表列的别名）。 */
const mapAssetVersionRow = (row: Row): MediaAssetVersionRecord => ({
  assetId: requiredString(row, 'asset_id'),
  byteSize: requiredNumber(row, 'byte_size'),
  createdAt: requiredString(row, 'version_created_at'),
  description: nullableString(row, 'description'),
  fileSha256: requiredString(row, 'file_sha256'),
  height: nullableNumber(row, 'height'),
  id: requiredString(row, 'version_id'),
  mimeType: requiredString(row, 'mime_type'),
  parentVersionId: nullableString(row, 'parent_id'),
  provenance: 'UPLOADED',
  versionNo: requiredNumber(row, 'version_no'),
  width: nullableNumber(row, 'width'),
});

const mapCandidateRow = (row: Row): MediaCandidateRecord => ({
  byteSize: nullableNumber(row, 'byte_size'),
  createdAt: requiredString(row, 'created_at'),
  errorCode: nullableString(row, 'error_code'),
  fileSha256: nullableString(row, 'file_sha256'),
  generationInputHash: requiredString(row, 'generation_input_hash'),
  height: nullableNumber(row, 'height'),
  id: requiredString(row, 'id'),
  indexInRound: requiredNumber(row, 'index_in_round'),
  invocationEvidenceRef: nullableString(row, 'invocation_evidence_ref'),
  mimeType: nullableString(row, 'mime_type'),
  modelId: requiredString(row, 'model_id'),
  providerTaskId: nullableString(row, 'provider_task_id'),
  roundNo: requiredNumber(row, 'round_no'),
  selectedAt: nullableString(row, 'selected_at'),
  shotId: requiredString(row, 'shot_id'),
  shotVersionId: requiredString(row, 'shot_version_id'),
  status: requiredString(row, 'status') as MediaCandidateRecord['status'],
  storageRelPath: nullableString(row, 'storage_rel_path'),
  updatedAt: requiredString(row, 'updated_at'),
  width: nullableNumber(row, 'width'),
});

/** STALE 传播的目标状态集合：终态 STALE_INPUT 之外的全部可传播状态。 */
const STALEABLE_STATUSES = "('PENDING', 'SUCCEEDED', 'FAILED')";

/** 任务相位状态机的非终态集合（终态行拒绝一切转移）。 */
const ACTIVE_TASK_PHASES = "('SUBMITTED', 'POLLING', 'DOWNLOADING')";

const mapTaskRow = (row: Row): MediaTaskRecord => ({
  candidateCount: requiredNumber(row, 'candidate_count'),
  createdAt: requiredString(row, 'created_at'),
  errorCode: nullableString(row, 'error_code'),
  generationInputHash: requiredString(row, 'generation_input_hash'),
  id: requiredString(row, 'id'),
  idempotencyKey: requiredString(row, 'idempotency_key'),
  phase: requiredString(row, 'phase') as MediaTaskPhase,
  projectId: requiredString(row, 'project_id'),
  providerTaskId: nullableString(row, 'provider_task_id'),
  roundNo: requiredNumber(row, 'round_no'),
  shotId: requiredString(row, 'shot_id'),
  shotVersionId: requiredString(row, 'shot_version_id'),
  updatedAt: requiredString(row, 'updated_at'),
});

/**
 * 媒体资产与候选的 SQLite 实现（design D3）。
 *
 * 方法经 {@link syncToPromise} 桥接同步 API（沿 SqliteProjectRepository 模式），
 * 在 MediaUnitOfWorkPort 的事务内调用；Repository 不自行提交或回滚。
 * 版本行只 INSERT——asset_versions 的 BEFORE UPDATE trigger 是持久化层的
 * 不可变保证，本类不提供任何改写路径。
 */
export class SqliteMediaRepository implements MediaRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => string,
  ) {}

  public findAssetByIdentity(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT id AS asset_id, project_id, asset_type, bible_ref_id, display_name,
                  created_at, updated_at
           FROM assets WHERE project_id = ? AND asset_type = ? AND bible_ref_id = ?`,
        )
        .get(projectId, assetType, bibleRefId);
      return row === undefined ? null : mapAssetRow(row);
    });
  }

  public createAsset(input: {
    assetType: MediaAssetType;
    bibleRefId: string;
    displayName: string;
    id: string;
    projectId: string;
  }): Promise<MediaAssetRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      try {
        this.database
          .prepare(
            `INSERT INTO assets (id, project_id, asset_type, bible_ref_id, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.projectId,
            input.assetType,
            input.bibleRefId,
            input.displayName,
            now,
            now,
          );
      } catch {
        throw new PersistenceRuntimeError('MEDIA_ASSET_CONFLICT');
      }
      const record: MediaAssetRecord = {
        assetType: input.assetType,
        bibleRefId: input.bibleRefId,
        createdAt: now,
        displayName: input.displayName,
        id: input.id,
        projectId: input.projectId,
        updatedAt: now,
      };
      return record;
    });
  }

  public appendAssetVersion(input: {
    assetId: string;
    byteSize: number;
    description?: string | null;
    fileSha256: string;
    height?: number | null;
    id: string;
    mimeType: string;
    width?: number | null;
  }): Promise<MediaAssetVersionRecord> {
    return syncToPromise(() => {
      const latest = this.database
        .prepare(
          'SELECT id, version_no FROM asset_versions WHERE asset_id = ? ORDER BY version_no DESC LIMIT 1',
        )
        .get(input.assetId) as { readonly id: string; readonly version_no: number } | undefined;
      const versionNo = (latest?.version_no ?? 0) + 1;
      const now = this.clock();
      // asset 外键缺失（资产不存在）由 FK 约束拒绝，归一化为冲突语义。
      try {
        this.database
          .prepare(
            `INSERT INTO asset_versions
             (id, asset_id, version_no, parent_id, provenance, description,
              file_sha256, byte_size, mime_type, width, height, created_at)
             VALUES (?, ?, ?, ?, 'UPLOADED', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.assetId,
            versionNo,
            latest?.id ?? null,
            input.description ?? null,
            input.fileSha256,
            input.byteSize,
            input.mimeType,
            input.width ?? null,
            input.height ?? null,
            now,
          );
      } catch {
        throw new PersistenceRuntimeError('MEDIA_ASSET_VERSION_REJECTED');
      }
      return {
        assetId: input.assetId,
        byteSize: input.byteSize,
        createdAt: now,
        description: input.description ?? null,
        fileSha256: input.fileSha256,
        height: input.height ?? null,
        id: input.id,
        mimeType: input.mimeType,
        parentVersionId: latest?.id ?? null,
        provenance: 'UPLOADED',
        versionNo,
        width: input.width ?? null,
      } satisfies MediaAssetVersionRecord;
    });
  }

  public listAssets(projectId: string): Promise<readonly MediaAssetWithVersions[]> {
    return syncToPromise(() => {
      const rows = this.database
        .prepare(
          `SELECT a.id AS asset_id, a.project_id, a.asset_type, a.bible_ref_id, a.display_name,
                  a.created_at, a.updated_at,
                  v.id AS version_id, v.version_no, v.parent_id, v.description, v.file_sha256,
                  v.byte_size, v.mime_type, v.width, v.height, v.created_at AS version_created_at
           FROM assets a LEFT JOIN asset_versions v ON v.asset_id = a.id
           WHERE a.project_id = ?
           ORDER BY a.created_at, a.id, v.version_no`,
        )
        .all(projectId) as Row[];
      const byAsset = new Map<
        string,
        { asset: MediaAssetRecord; versions: MediaAssetVersionRecord[] }
      >();
      for (const row of rows) {
        const assetId = requiredString(row, 'asset_id');
        let entry = byAsset.get(assetId);
        if (entry === undefined) {
          entry = { asset: mapAssetRow(row), versions: [] };
          byAsset.set(assetId, entry);
        }
        if (row.version_id !== null && row.version_id !== undefined) {
          entry.versions.push(mapAssetVersionRow(row));
        }
      }
      return [...byAsset.values()].map(({ asset, versions }) => ({ asset, versions }));
    });
  }

  public findCurrentAssetVersion(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetVersionRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT v.id AS version_id, v.asset_id, v.version_no, v.parent_id, v.description,
                  v.file_sha256, v.byte_size, v.mime_type, v.width, v.height,
                  v.created_at AS version_created_at
           FROM asset_versions v JOIN assets a ON a.id = v.asset_id
           WHERE a.project_id = ? AND a.asset_type = ? AND a.bible_ref_id = ?
           ORDER BY v.version_no DESC LIMIT 1`,
        )
        .get(projectId, assetType, bibleRefId);
      return row === undefined ? null : mapAssetVersionRow(row);
    });
  }

  public insertCandidates(input: {
    candidateIds: readonly string[];
    generationInputHash: string;
    modelId: string;
    projectId: string;
    roundNo: number;
    shotId: string;
    shotVersionId: string;
  }): Promise<readonly MediaCandidateRecord[]> {
    return syncToPromise(() => {
      const now = this.clock();
      const insert = this.database.prepare(
        `INSERT INTO image_candidates
         (id, project_id, shot_id, shot_version_id, round_no, index_in_round,
          generation_input_hash, status, model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      );
      const records: MediaCandidateRecord[] = input.candidateIds.map((id, index) => {
        insert.run(
          id,
          input.projectId,
          input.shotId,
          input.shotVersionId,
          input.roundNo,
          index,
          input.generationInputHash,
          input.modelId,
          now,
          now,
        );
        return {
          byteSize: null,
          createdAt: now,
          errorCode: null,
          fileSha256: null,
          generationInputHash: input.generationInputHash,
          height: null,
          id,
          indexInRound: index,
          invocationEvidenceRef: null,
          mimeType: null,
          modelId: input.modelId,
          providerTaskId: null,
          roundNo: input.roundNo,
          selectedAt: null,
          shotId: input.shotId,
          shotVersionId: input.shotVersionId,
          status: 'PENDING',
          storageRelPath: null,
          updatedAt: now,
          width: null,
        } satisfies MediaCandidateRecord;
      });
      return records;
    });
  }

  public assignCandidateProviderTask(
    candidateId: string,
    providerTaskId: string,
  ): Promise<MediaCandidateRecord> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE image_candidates SET provider_task_id = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING' AND provider_task_id IS NULL`,
        )
        .run(providerTaskId, this.clock(), candidateId);
      const candidate = this.requireCandidate(candidateId, 'MEDIA_CANDIDATE_NOT_FOUND');
      if (candidate.providerTaskId !== providerTaskId) {
        // 幂等重放（同 taskId）安全；不同 taskId 说明候选已被其他提交占用。
        throw new PersistenceRuntimeError('MEDIA_CANDIDATE_TASK_CONFLICT');
      }
      return candidate;
    });
  }

  public completeCandidateSucceeded(
    candidateId: string,
    result: {
      byteSize: number;
      fileSha256: string;
      height: number | null;
      invocationEvidenceRef: string;
      mimeType: string;
      storageRelPath: string;
      width: number | null;
    },
  ): Promise<MediaCandidateRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      this.database
        .prepare(
          `UPDATE image_candidates
           SET status = 'SUCCEEDED', file_sha256 = ?, byte_size = ?, mime_type = ?, width = ?,
               height = ?, storage_rel_path = ?, invocation_evidence_ref = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(
          result.fileSha256,
          result.byteSize,
          result.mimeType,
          result.width,
          result.height,
          result.storageRelPath,
          result.invocationEvidenceRef,
          now,
          candidateId,
        );
      return this.requireCandidate(candidateId, 'MEDIA_CANDIDATE_NOT_FOUND');
    });
  }

  public completeCandidateFailed(
    candidateId: string,
    result: { errorCode: string; invocationEvidenceRef: string },
  ): Promise<MediaCandidateRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      this.database
        .prepare(
          `UPDATE image_candidates
           SET status = 'FAILED', error_code = ?, invocation_evidence_ref = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(result.errorCode, result.invocationEvidenceRef, now, candidateId);
      return this.requireCandidate(candidateId, 'MEDIA_CANDIDATE_NOT_FOUND');
    });
  }

  public listCandidates(shotId: string): Promise<readonly MediaCandidateRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          `SELECT id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
                  status, file_sha256, byte_size, mime_type, width, height, storage_rel_path,
                  model_id, provider_task_id, invocation_evidence_ref, error_code, selected_at,
                  created_at, updated_at
           FROM image_candidates WHERE shot_id = ? ORDER BY round_no, index_in_round`,
        )
        .all(shotId)
        .map(mapCandidateRow),
    );
  }

  public selectCandidate(shotId: string, candidateId: string): Promise<void> {
    return syncToPromise(() => {
      const row = this.database
        .prepare('SELECT status FROM image_candidates WHERE id = ? AND shot_id = ?')
        .get(candidateId, shotId);
      if (row === undefined) {
        throw new PersistenceRuntimeError('MEDIA_CANDIDATE_NOT_FOUND');
      }
      if (String(row.status) !== 'SUCCEEDED') {
        throw new PersistenceRuntimeError('MEDIA_CANDIDATE_NOT_SELECTABLE');
      }
      const now = this.clock();
      this.database
        .prepare(
          `UPDATE image_candidates SET selected_at = NULL, selected_by_context = NULL, updated_at = ?
           WHERE shot_id = ? AND selected_at IS NOT NULL`,
        )
        .run(now, shotId);
      this.database
        .prepare(
          `UPDATE image_candidates SET selected_at = ?, selected_by_context = 'USER', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, candidateId);
    });
  }

  public markCandidatesStaleByShotVersion(
    shotVersionId: string,
  ): Promise<readonly MediaStaleAffectedShot[]> {
    return syncToPromise(() => {
      const affected = this.database
        .prepare(
          `SELECT shot_id AS shotId, COUNT(*) AS candidateCount FROM image_candidates
           WHERE shot_version_id = ? AND status IN ${STALEABLE_STATUSES}
           GROUP BY shot_id ORDER BY shot_id`,
        )
        .all(shotVersionId) as unknown as readonly MediaStaleAffectedShot[];
      if (affected.length > 0) {
        this.database
          .prepare(
            `UPDATE image_candidates SET status = 'STALE_INPUT', error_code = NULL, updated_at = ?
             WHERE shot_version_id = ? AND status IN ${STALEABLE_STATUSES}`,
          )
          .run(this.clock(), shotVersionId);
      }
      return affected;
    });
  }

  public markCandidatesStaleByGenerationInputHash(
    generationInputHash: string,
  ): Promise<readonly MediaStaleAffectedShot[]> {
    return syncToPromise(() => {
      const affected = this.database
        .prepare(
          `SELECT shot_id AS shotId, COUNT(*) AS candidateCount FROM image_candidates
           WHERE generation_input_hash = ? AND status IN ${STALEABLE_STATUSES}
           GROUP BY shot_id ORDER BY shot_id`,
        )
        .all(generationInputHash) as unknown as readonly MediaStaleAffectedShot[];
      if (affected.length > 0) {
        this.database
          .prepare(
            `UPDATE image_candidates SET status = 'STALE_INPUT', error_code = NULL, updated_at = ?
             WHERE generation_input_hash = ? AND status IN ${STALEABLE_STATUSES}`,
          )
          .run(this.clock(), generationInputHash);
      }
      return affected;
    });
  }

  public findTaskByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<MediaTaskRecord | null> {
    return syncToPromise(() => {
      const row = this.selectTaskWhere(
        'WHERE project_id = ? AND idempotency_key = ?',
        projectId,
        idempotencyKey,
      );
      return row === undefined ? null : mapTaskRow(row);
    });
  }

  public findTaskById(projectId: string, taskId: string): Promise<MediaTaskRecord | null> {
    return syncToPromise(() => {
      const row = this.selectTaskWhere('WHERE project_id = ? AND id = ?', projectId, taskId);
      return row === undefined ? null : mapTaskRow(row);
    });
  }

  public insertTask(input: {
    candidateCount: number;
    generationInputHash: string;
    id: string;
    idempotencyKey: string;
    projectId: string;
    shotId: string;
    shotVersionId: string;
  }): Promise<MediaTaskRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      // round_no 与候选轮同源派生：同事务内随后以同值 insertCandidates。
      const roundRow = this.database
        .prepare(
          'SELECT COALESCE(MAX(round_no), 0) AS max_round FROM image_candidates WHERE shot_id = ?',
        )
        .get(input.shotId) as { readonly max_round: SqliteOutputValue };
      const roundNo = Number(roundRow.max_round) + 1;
      try {
        this.database
          .prepare(
            `INSERT INTO media_generation_tasks
             (id, project_id, shot_id, shot_version_id, idempotency_key, provider_task_id,
              phase, generation_input_hash, candidate_count, round_no, error_code,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, 'SUBMITTED', ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            input.id,
            input.projectId,
            input.shotId,
            input.shotVersionId,
            input.idempotencyKey,
            input.generationInputHash,
            input.candidateCount,
            roundNo,
            now,
            now,
          );
      } catch {
        // UNIQUE(project_id, idempotency_key) 兜底并发重放（service 先查再插）；
        // UNIQUE(shot_id, round_no) 兜底同镜头并发建档。
        throw new PersistenceRuntimeError('MEDIA_TASK_IDEMPOTENCY_CONFLICT');
      }
      return mapTaskRow(this.requireTaskRow(input.id));
    });
  }

  public markTaskPolling(taskId: string, providerTaskId: string): Promise<MediaTaskRecord> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE media_generation_tasks
           SET phase = 'POLLING', provider_task_id = ?, updated_at = ?
           WHERE id = ? AND phase = 'SUBMITTED'`,
        )
        .run(providerTaskId, this.clock(), taskId);
      return this.requireTaskPhase(taskId, 'POLLING');
    });
  }

  public markTaskDownloading(taskId: string): Promise<MediaTaskRecord> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE media_generation_tasks
           SET phase = 'DOWNLOADING', updated_at = ?
           WHERE id = ? AND phase IN ('SUBMITTED', 'POLLING')`,
        )
        .run(this.clock(), taskId);
      return this.requireTaskPhase(taskId, 'DOWNLOADING');
    });
  }

  public completeTask(taskId: string): Promise<MediaTaskRecord> {
    return syncToPromise(() => this.transitionTerminal(taskId, 'COMPLETED', null));
  }

  public failTask(taskId: string, errorCode: string): Promise<MediaTaskRecord> {
    return syncToPromise(() => this.transitionTerminal(taskId, 'FAILED', errorCode));
  }

  public cancelTask(taskId: string): Promise<MediaTaskRecord> {
    return syncToPromise(() => this.transitionTerminal(taskId, 'CANCELLED', null));
  }

  public listUnfinishedTasks(projectId: string): Promise<readonly MediaTaskRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          `SELECT id, project_id, shot_id, shot_version_id, idempotency_key, provider_task_id,
                  phase, generation_input_hash, candidate_count, round_no, error_code,
                  created_at, updated_at
           FROM media_generation_tasks
           WHERE project_id = ? AND phase IN ${ACTIVE_TASK_PHASES}
           ORDER BY created_at, id`,
        )
        .all(projectId)
        .map(mapTaskRow),
    );
  }

  private transitionTerminal(
    taskId: string,
    phase: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    errorCode: string | null,
  ): MediaTaskRecord {
    this.database
      .prepare(
        `UPDATE media_generation_tasks
         SET phase = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND phase IN ${ACTIVE_TASK_PHASES}`,
      )
      .run(phase, errorCode, this.clock(), taskId);
    return this.requireTaskPhase(taskId, phase);
  }

  private selectTaskWhere(whereClause: string, ...params: readonly string[]): Row | undefined {
    return this.database
      .prepare(
        `SELECT id, project_id, shot_id, shot_version_id, idempotency_key, provider_task_id,
                phase, generation_input_hash, candidate_count, round_no, error_code,
                created_at, updated_at
         FROM media_generation_tasks ${whereClause}`,
      )
      .get(...params);
  }

  private requireTaskRow(taskId: string): Row {
    const row = this.selectTaskWhere('WHERE id = ?', taskId);
    if (row === undefined) {
      throw new PersistenceRuntimeError('MEDIA_TASK_NOT_FOUND');
    }
    return row;
  }

  /** 转移后复核：到达目标相位即成功（幂等重放安全），否则该行已处于不可转移相位。 */
  private requireTaskPhase(taskId: string, phase: MediaTaskPhase): MediaTaskRecord {
    const task = mapTaskRow(this.requireTaskRow(taskId));
    if (task.phase !== phase) {
      throw new PersistenceRuntimeError('MEDIA_TASK_ALREADY_TERMINAL');
    }
    return task;
  }

  private requireCandidate(candidateId: string, errorCode: string): MediaCandidateRecord {
    const row = this.database
      .prepare(
        `SELECT id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
                status, file_sha256, byte_size, mime_type, width, height, storage_rel_path,
                model_id, provider_task_id, invocation_evidence_ref, error_code, selected_at,
                created_at, updated_at
         FROM image_candidates WHERE id = ?`,
      )
      .get(candidateId);
    if (row === undefined) {
      throw new PersistenceRuntimeError(errorCode);
    }
    return mapCandidateRow(row);
  }
}
