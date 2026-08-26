import type {
  VoiceCandidateFileRegistration,
  VoiceCandidateRecord,
  VoiceGenerationRepositoryPort,
  VoiceJobEvidenceEntry,
  VoiceJobRecord,
} from '@jingxu/application';

import type { SqliteDatabase, SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

type Row = Readonly<Record<string, SqliteOutputValue>>;

const VOICE_ROW_CORRUPT = 'VOICE_ROW_CORRUPT';

const corrupt = (): never => {
  throw new PersistenceRuntimeError(VOICE_ROW_CORRUPT);
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

const JOB_COLUMNS = `id, project_id, episode_id, request_id, status, target_shot_ids_json,
        skipped_shots_json, evidence_json, created_at, updated_at`;

const parseJsonArray = (row: Row, column: string): readonly unknown[] => {
  const raw = requiredString(row, column);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed as readonly unknown[];
  } catch {
    return corrupt();
  }
};

const mapJobRow = (row: Row): VoiceJobRecord => ({
  createdAt: requiredString(row, 'created_at'),
  episodeId: requiredString(row, 'episode_id'),
  evidence: parseJsonArray(row, 'evidence_json').map((entry) => {
    if (typeof entry !== 'object' || entry === null) return corrupt();
    const value = entry as Record<string, unknown>;
    return {
      at: typeof value.at === 'string' ? value.at : corrupt(),
      candidateId: typeof value.candidateId === 'string' ? value.candidateId : null,
      outcome: value.outcome as VoiceJobEvidenceEntry['outcome'],
      shotId: typeof value.shotId === 'string' ? value.shotId : corrupt(),
    } satisfies VoiceJobEvidenceEntry;
  }),
  id: requiredString(row, 'id'),
  projectId: requiredString(row, 'project_id'),
  requestId: requiredString(row, 'request_id'),
  skippedShots: parseJsonArray(row, 'skipped_shots_json').map((entry) => {
    if (typeof entry !== 'object' || entry === null) return corrupt();
    const value = entry as Record<string, unknown>;
    return {
      reason: value.reason as VoiceJobRecord['skippedShots'][number]['reason'],
      shotId: typeof value.shotId === 'string' ? value.shotId : corrupt(),
    };
  }),
  status: requiredString(row, 'status') as VoiceJobRecord['status'],
  targetShotIds: parseJsonArray(row, 'target_shot_ids_json').map((entry) =>
    typeof entry === 'string' ? entry : corrupt(),
  ),
  updatedAt: requiredString(row, 'updated_at'),
});

const CANDIDATE_COLUMNS = `id, project_id, shot_id, shot_version_id, job_id, round_no,
        index_in_round, speaker_id, spoken_text_sha256, voice_id, model_id,
        generation_input_hash, status, duration_ms, file_sha256, byte_size, mime_type,
        storage_rel_path, error_code, selected_at, created_at, updated_at`;

const mapCandidateRow = (row: Row): VoiceCandidateRecord => ({
  byteSize: nullableNumber(row, 'byte_size'),
  createdAt: requiredString(row, 'created_at'),
  durationMs: nullableNumber(row, 'duration_ms'),
  errorCode: nullableString(row, 'error_code'),
  fileSha256: nullableString(row, 'file_sha256'),
  generationInputHash: requiredString(row, 'generation_input_hash'),
  id: requiredString(row, 'id'),
  indexInRound: requiredNumber(row, 'index_in_round'),
  jobId: requiredString(row, 'job_id'),
  mimeType: nullableString(row, 'mime_type') as VoiceCandidateRecord['mimeType'],
  modelId: requiredString(row, 'model_id'),
  projectId: requiredString(row, 'project_id'),
  roundNo: requiredNumber(row, 'round_no'),
  selectedAt: nullableString(row, 'selected_at'),
  shotId: requiredString(row, 'shot_id'),
  shotVersionId: requiredString(row, 'shot_version_id'),
  speakerId: requiredString(row, 'speaker_id'),
  spokenTextSha256: requiredString(row, 'spoken_text_sha256'),
  status: requiredString(row, 'status') as VoiceCandidateRecord['status'],
  storageRelPath: nullableString(row, 'storage_rel_path'),
  updatedAt: requiredString(row, 'updated_at'),
  voiceId: requiredString(row, 'voice_id'),
});

/**
 * 配音三表之 voice_generation_jobs / voice_candidates 的 SQLite 实现
 * （v2-voice-audio-timeline tasks 4.2，design D3）：job 行即批次（同步端口无
 * 成员任务表），证据 JSON 读改写与终态守卫沿用 SqliteVideoMediaRepository 方法族
 * ——守卫失败抛稳定 PersistenceRuntimeError code（与 InMemory 实现同名对齐）。
 * 方法经 syncToPromise 桥接同步 API，在 MediaUnitOfWorkPort 事务内调用；
 * Repository 不自行提交或回滚。
 */
export class SqliteVoiceGenerationRepository implements VoiceGenerationRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public insertJob(job: VoiceJobRecord): Promise<void> {
    return syncToPromise(() => {
      try {
        this.database
          .prepare(
            `INSERT INTO voice_generation_jobs
             (id, project_id, episode_id, request_id, status, target_shot_ids_json,
              skipped_shots_json, evidence_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            job.id,
            job.projectId,
            job.episodeId,
            job.requestId,
            job.status,
            JSON.stringify(job.targetShotIds),
            JSON.stringify(job.skippedShots),
            JSON.stringify(job.evidence),
            job.createdAt,
            job.updatedAt,
          );
      } catch {
        // UNIQUE(project_id, request_id) 兜底并发重放（service 先查再插）。
        throw new PersistenceRuntimeError('VOICE_JOB_IDEMPOTENCY_CONFLICT');
      }
    });
  }

  public findJobByRequest(projectId: string, requestId: string): Promise<VoiceJobRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM voice_generation_jobs
           WHERE project_id = ? AND request_id = ?`,
        )
        .get(projectId, requestId);
      return row === undefined ? null : mapJobRow(row);
    });
  }

  public findJobById(projectId: string, jobId: string): Promise<VoiceJobRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM voice_generation_jobs
           WHERE project_id = ? AND id = ?`,
        )
        .get(projectId, jobId);
      return row === undefined ? null : mapJobRow(row);
    });
  }

  public findActiveJobByProject(projectId: string): Promise<VoiceJobRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM voice_generation_jobs
           WHERE project_id = ? AND status IN ('QUEUED', 'RUNNING')
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(projectId);
      return row === undefined ? null : mapJobRow(row);
    });
  }

  public markJobRunning(jobId: string, updatedAt: string): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE voice_generation_jobs SET status = 'RUNNING', updated_at = ?
           WHERE id = ? AND status = 'QUEUED'`,
        )
        .run(updatedAt, jobId);
      this.requireJobStatus(jobId, 'RUNNING', 'VOICE_JOB_NOT_QUEUED');
    });
  }

  public cancelJob(jobId: string, at: string): Promise<void> {
    return syncToPromise(() => {
      const row = this.requireJobRow(jobId);
      const job = mapJobRow(row);
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return;
      // 状态与 CANCELLED 证据同事务原子落库（取消先落库，再中止在飞）。
      this.database
        .prepare(
          `UPDATE voice_generation_jobs
           SET status = 'CANCELLED', evidence_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify([
            ...job.evidence,
            { at, candidateId: null, outcome: 'CANCELLED', shotId: '*' },
          ]),
          at,
          jobId,
        );
    });
  }

  public appendJobEvidence(jobId: string, entry: VoiceJobEvidenceEntry): Promise<void> {
    return syncToPromise(() => {
      const job = mapJobRow(this.requireJobRow(jobId));
      this.database
        .prepare(`UPDATE voice_generation_jobs SET evidence_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify([...job.evidence, entry]), entry.at, jobId);
    });
  }

  public finalizeJob(
    jobId: string,
    status: 'COMPLETED' | 'PARTIAL_COMPLETED',
    updatedAt: string,
  ): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE voice_generation_jobs SET status = ?, updated_at = ?
           WHERE id = ? AND status = 'RUNNING'`,
        )
        .run(status, updatedAt, jobId);
      this.requireJobStatus(jobId, status, 'VOICE_JOB_NOT_RUNNING');
    });
  }

  public insertCandidate(candidate: VoiceCandidateRecord): Promise<void> {
    return syncToPromise(() => {
      try {
        this.database
          .prepare(
            `INSERT INTO voice_candidates
             (id, project_id, shot_id, shot_version_id, job_id, round_no, index_in_round,
              speaker_id, spoken_text_sha256, voice_id, model_id, generation_input_hash,
              status, duration_ms, file_sha256, byte_size, mime_type, storage_rel_path,
              error_code, selected_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.id,
            candidate.projectId,
            candidate.shotId,
            candidate.shotVersionId,
            candidate.jobId,
            candidate.roundNo,
            candidate.indexInRound,
            candidate.speakerId,
            candidate.spokenTextSha256,
            candidate.voiceId,
            candidate.modelId,
            candidate.generationInputHash,
            candidate.status,
            candidate.durationMs,
            candidate.fileSha256,
            candidate.byteSize,
            candidate.mimeType,
            candidate.storageRelPath,
            candidate.errorCode,
            candidate.selectedAt,
            candidate.createdAt,
            candidate.updatedAt,
          );
      } catch {
        // UNIQUE(shot_id, round_no, index_in_round) 兜底同镜头并发建档。
        throw new PersistenceRuntimeError('VOICE_CANDIDATE_DUPLICATE');
      }
    });
  }

  public findCandidate(
    projectId: string,
    candidateId: string,
  ): Promise<VoiceCandidateRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM voice_candidates
           WHERE id = ? AND project_id = ?`,
        )
        .get(candidateId, projectId);
      return row === undefined ? null : mapCandidateRow(row);
    });
  }

  public listCandidatesByShot(shotId: string): Promise<VoiceCandidateRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM voice_candidates
           WHERE shot_id = ? ORDER BY round_no, index_in_round`,
        )
        .all(shotId)
        .map(mapCandidateRow),
    );
  }

  public nextRoundNo(shotId: string): Promise<number> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          'SELECT COALESCE(MAX(round_no), 0) AS max_round FROM voice_candidates WHERE shot_id = ?',
        )
        .get(shotId) as { readonly max_round: SqliteOutputValue };
      return Number(row.max_round) + 1;
    });
  }

  public finalizeCandidateSucceeded(
    candidateId: string,
    registration: VoiceCandidateFileRegistration,
    updatedAt: string,
  ): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `UPDATE voice_candidates
           SET status = 'SUCCEEDED', duration_ms = ?, file_sha256 = ?, byte_size = ?,
               mime_type = ?, storage_rel_path = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(
          registration.durationMs,
          registration.fileSha256,
          registration.byteSize,
          registration.mimeType,
          registration.storageRelPath,
          updatedAt,
          candidateId,
        );
      this.requireCandidateStatus(candidateId, 'SUCCEEDED', 'VOICE_CANDIDATE_NOT_PENDING');
    });
  }

  public finalizeCandidateFailed(
    candidateId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    return syncToPromise(() => {
      this.failCandidate(candidateId, errorCode, updatedAt);
    });
  }

  public interruptCandidate(
    candidateId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    return syncToPromise(() => {
      this.failCandidate(candidateId, errorCode, updatedAt);
    });
  }

  public markCandidatesStale(candidateIds: readonly string[], updatedAt: string): Promise<void> {
    return syncToPromise(() => {
      if (candidateIds.length === 0) return;
      const placeholders = candidateIds.map(() => '?').join(', ');
      // 0020 CHECK：duration_ms 仅 SUCCEEDED 可携带——STALE 迁移同时清零；
      // 文件四元组保留（CAS 音频与证据不因失效而抹除）。
      this.database
        .prepare(
          `UPDATE voice_candidates SET status = 'STALE_INPUT', duration_ms = NULL, updated_at = ?
           WHERE id IN (${placeholders}) AND status = 'SUCCEEDED'`,
        )
        .run(updatedAt, ...candidateIds);
    });
  }

  public selectCandidate(candidateId: string, selectedAt: string): Promise<void> {
    return syncToPromise(() => {
      const candidate = mapCandidateRow(this.requireCandidateRow(candidateId));
      if (candidate.status !== 'SUCCEEDED') {
        throw new PersistenceRuntimeError('VOICE_CANDIDATE_NOT_SELECTABLE');
      }
      this.database
        .prepare(
          `UPDATE voice_candidates SET selected_at = NULL, updated_at = ?
           WHERE shot_id = ? AND selected_at IS NOT NULL`,
        )
        .run(selectedAt, candidate.shotId);
      this.database
        .prepare(`UPDATE voice_candidates SET selected_at = ?, updated_at = ? WHERE id = ?`)
        .run(selectedAt, selectedAt, candidateId);
    });
  }

  public deleteCandidate(candidateId: string): Promise<void> {
    return syncToPromise(() => {
      // 先确权再删（run() 返回形状不透明；仅删登记行，共享 CAS 文件不受影响）。
      this.requireCandidateRow(candidateId);
      this.database.prepare('DELETE FROM voice_candidates WHERE id = ?').run(candidateId);
    });
  }

  public listSucceededShotHashes(
    projectId: string,
  ): Promise<readonly { generationInputHash: string; shotId: string }[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          `SELECT shot_id, generation_input_hash FROM voice_candidates
           WHERE project_id = ? AND status = 'SUCCEEDED'`,
        )
        .all(projectId)
        .map((row) => ({
          generationInputHash: requiredString(row as Row, 'generation_input_hash'),
          shotId: requiredString(row as Row, 'shot_id'),
        })),
    );
  }

  private failCandidate(candidateId: string, errorCode: string, updatedAt: string): void {
    this.database
      .prepare(
        `UPDATE voice_candidates SET status = 'FAILED', error_code = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(errorCode, updatedAt, candidateId);
    this.requireCandidateStatus(candidateId, 'FAILED', 'VOICE_CANDIDATE_NOT_PENDING');
  }

  private requireJobRow(jobId: string): Row {
    const row = this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM voice_generation_jobs WHERE id = ?`)
      .get(jobId);
    if (row === undefined) {
      throw new PersistenceRuntimeError('VOICE_JOB_NOT_FOUND');
    }
    return row;
  }

  /** 转移后复核：到达目标状态即成功（幂等重放安全），否则该行处于不可转移状态。 */
  private requireJobStatus(
    jobId: string,
    status: VoiceJobRecord['status'],
    guardCode: string,
  ): void {
    const job = mapJobRow(this.requireJobRow(jobId));
    if (job.status !== status) {
      throw new PersistenceRuntimeError(guardCode);
    }
  }

  private requireCandidateRow(candidateId: string): Row {
    const row = this.database
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM voice_candidates WHERE id = ?`)
      .get(candidateId);
    if (row === undefined) {
      throw new PersistenceRuntimeError('VOICE_CANDIDATE_NOT_FOUND');
    }
    return row;
  }

  private requireCandidateStatus(
    candidateId: string,
    status: VoiceCandidateRecord['status'],
    guardCode: string,
  ): void {
    const candidate = mapCandidateRow(this.requireCandidateRow(candidateId));
    if (candidate.status !== status) {
      throw new PersistenceRuntimeError(guardCode);
    }
  }
}
