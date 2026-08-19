import type {
  MediaAssetRecord,
  MediaAssetType,
  MediaAssetVersionRecord,
  MediaBatchRecord,
  MediaCandidateRecord,
  MediaRepository,
  MediaStaleAffectedShot,
  MediaStoredFileRef,
  MediaSucceededShotHash,
  MediaTaskRecord,
} from '../ports/media/media-repository';

const NOW = '2026-08-16T00:00:00.000Z';

/** 与 persistence deriveMediaStorageRelPath 的 MIME 扩展名映射保持一致。 */
const MIME_TO_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

/**
 * 内存版 MediaRepository（沿 project/in-memory-ports.ts 模式提取，供 service 与
 * 调度器测试共用）：只为驱动应用层语义，不模拟 SQL 约束之外的并发细节。
 * 状态机守卫与 SqliteMediaRepository 对齐——守卫失败抛同名稳定 message 标记。
 */
export class InMemoryMediaRepository implements MediaRepository {
  public readonly assets: MediaAssetRecord[] = [];
  public readonly versions: MediaAssetVersionRecord[] = [];
  public readonly candidates: MediaCandidateRecord[] = [];
  public readonly tasks: MediaTaskRecord[] = [];
  public readonly batches: MediaBatchRecord[] = [];
  /** 候选行不含 projectId 字段；insert 时旁路登记供 findCandidateById 过滤。 */
  private readonly candidateProjectIds = new Map<string, string>();
  /** 任务行不含 batchId 字段；insertTask 时旁路登记供成员查询过滤。 */
  /** 任务→批次归属（batch_id 列的内存镜像；测试断言成员归属用）。 */
  readonly taskBatchIds = new Map<string, string>();

  public findAssetByIdentity(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetRecord | null> {
    return Promise.resolve(
      this.assets.find(
        (asset) =>
          asset.projectId === projectId &&
          asset.assetType === assetType &&
          asset.bibleRefId === bibleRefId,
      ) ?? null,
    );
  }

  public createAsset(input: {
    assetType: MediaAssetType;
    bibleRefId: string;
    displayName: string;
    id: string;
    projectId: string;
  }): Promise<MediaAssetRecord> {
    const record: MediaAssetRecord = { ...input, createdAt: NOW, updatedAt: NOW };
    this.assets.push(record);
    return Promise.resolve(record);
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
    const latest = [...this.versions]
      .filter((version) => version.assetId === input.assetId)
      .sort((a, b) => b.versionNo - a.versionNo)[0];
    const record: MediaAssetVersionRecord = {
      assetId: input.assetId,
      byteSize: input.byteSize,
      createdAt: NOW,
      description: input.description ?? null,
      fileSha256: input.fileSha256,
      height: input.height ?? null,
      id: input.id,
      mimeType: input.mimeType,
      parentVersionId: latest?.id ?? null,
      provenance: 'UPLOADED',
      versionNo: (latest?.versionNo ?? 0) + 1,
      width: input.width ?? null,
    };
    this.versions.push(record);
    return Promise.resolve(record);
  }

  public listAssets(
    projectId: string,
  ): Promise<readonly { asset: MediaAssetRecord; versions: readonly MediaAssetVersionRecord[] }[]> {
    return Promise.resolve(
      this.assets
        .filter((asset) => asset.projectId === projectId)
        .map((asset) => ({
          asset,
          versions: this.versions
            .filter((version) => version.assetId === asset.id)
            .sort((a, b) => a.versionNo - b.versionNo),
        })),
    );
  }

  public findCurrentAssetVersion(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetVersionRecord | null> {
    const asset = this.assets.find(
      (entry) =>
        entry.projectId === projectId &&
        entry.assetType === assetType &&
        entry.bibleRefId === bibleRefId,
    );
    if (asset === undefined) return Promise.resolve(null);
    const latest = [...this.versions]
      .filter((version) => version.assetId === asset.id)
      .sort((a, b) => b.versionNo - a.versionNo)[0];
    return Promise.resolve(latest ?? null);
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
    const records = input.candidateIds.map((id, index): MediaCandidateRecord => {
      const record: MediaCandidateRecord = {
        byteSize: null,
        createdAt: NOW,
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
        updatedAt: NOW,
        width: null,
      };
      this.candidates.push(record);
      return record;
    });
    records.forEach((record) => this.candidateProjectIds.set(record.id, input.projectId));
    return Promise.resolve(records);
  }

  public assignCandidateProviderTask(
    candidateId: string,
    providerTaskId: string,
  ): Promise<MediaCandidateRecord> {
    const index = this.candidates.findIndex((candidate) => candidate.id === candidateId);
    const current = this.candidates[index];
    if (current === undefined) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
    if (current.providerTaskId === providerTaskId) return Promise.resolve(current);
    if (current.status !== 'PENDING' || current.providerTaskId !== null) {
      throw new Error('MEDIA_CANDIDATE_TASK_CONFLICT');
    }
    const next: MediaCandidateRecord = {
      ...current,
      providerTaskId,
      updatedAt: NOW,
    };
    this.candidates[index] = next;
    return Promise.resolve(next);
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
    return this.completeCandidate(candidateId, {
      byteSize: result.byteSize,
      errorCode: null,
      fileSha256: result.fileSha256,
      height: result.height,
      invocationEvidenceRef: result.invocationEvidenceRef,
      mimeType: result.mimeType,
      status: 'SUCCEEDED',
      storageRelPath: result.storageRelPath,
      width: result.width,
    });
  }

  public completeCandidateFailed(
    candidateId: string,
    result: { errorCode: string; invocationEvidenceRef: string },
  ): Promise<MediaCandidateRecord> {
    return this.completeCandidate(candidateId, {
      byteSize: null,
      errorCode: result.errorCode,
      fileSha256: null,
      height: null,
      invocationEvidenceRef: result.invocationEvidenceRef,
      mimeType: null,
      status: 'FAILED',
      storageRelPath: null,
      width: null,
    });
  }

  public listCandidates(shotId: string): Promise<readonly MediaCandidateRecord[]> {
    return Promise.resolve(
      this.candidates
        .filter((candidate) => candidate.shotId === shotId)
        .sort((a, b) => a.roundNo - b.roundNo || a.indexInRound - b.indexInRound),
    );
  }

  public findCandidateById(
    projectId: string,
    candidateId: string,
  ): Promise<MediaCandidateRecord | null> {
    const candidate = this.candidates.find((entry) => entry.id === candidateId);
    if (candidate === undefined) return Promise.resolve(null);
    return Promise.resolve(
      this.candidateProjectIds.get(candidateId) === projectId ? candidate : null,
    );
  }

  /** 落盘候选反查（取图协议入口）：未落盘（PENDING/FAILED）或未知 id 返回 null。 */
  public findCandidateMediaById(candidateId: string): Promise<MediaStoredFileRef | null> {
    const candidate = this.candidates.find((entry) => entry.id === candidateId);
    if (candidate === undefined) return Promise.resolve(null);
    if (candidate.storageRelPath === null || candidate.mimeType === null) {
      return Promise.resolve(null);
    }
    if (candidate.byteSize === null) return Promise.resolve(null);
    return Promise.resolve({
      byteSize: candidate.byteSize,
      mimeType: candidate.mimeType,
      storageRelPath: candidate.storageRelPath,
    });
  }

  /** 资产版本反查：路径由 (projectId, sha256, mime) 派生（与 SQL 实现同规则）。 */
  public findAssetVersionMediaById(versionId: string): Promise<MediaStoredFileRef | null> {
    const version = this.versions.find((entry) => entry.id === versionId);
    if (version === undefined) return Promise.resolve(null);
    const asset = this.assets.find((entry) => entry.id === version.assetId);
    if (asset === undefined) return Promise.resolve(null);
    const extension = MIME_TO_EXTENSION[version.mimeType];
    if (extension === undefined) return Promise.resolve(null);
    return Promise.resolve({
      byteSize: version.byteSize,
      mimeType: version.mimeType,
      storageRelPath: `projects/${asset.projectId}/assets/${version.fileSha256.slice(0, 2)}/${version.fileSha256}.${extension}`,
    });
  }

  /** 先清后设（SQL 实现语义对齐）：仅 SUCCEEDED 可选，同镜头唯一选择指针。 */
  public selectCandidate(shotId: string, candidateId: string): Promise<void> {
    const candidate = this.candidates.find(
      (entry) => entry.id === candidateId && entry.shotId === shotId,
    );
    if (candidate === undefined) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
    if (candidate.status !== 'SUCCEEDED') throw new Error('MEDIA_CANDIDATE_NOT_SELECTABLE');
    this.candidates.forEach((entry, index) => {
      if (entry.shotId !== shotId) return;
      if (entry.selectedAt === null) return;
      this.candidates[index] = { ...entry, selectedAt: null, updatedAt: NOW };
    });
    const target = this.candidates.find((entry) => entry.id === candidateId);
    if (target === undefined) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
    const index = this.candidates.indexOf(target);
    this.candidates[index] = { ...target, selectedAt: NOW, updatedAt: NOW };
    return Promise.resolve();
  }

  public markCandidatesStaleByShotVersion(
    shotVersionId: string,
  ): Promise<readonly MediaStaleAffectedShot[]> {
    return this.markStale((candidate) => candidate.shotVersionId === shotVersionId);
  }

  public markCandidatesStaleByGenerationInputHash(
    generationInputHash: string,
  ): Promise<readonly MediaStaleAffectedShot[]> {
    return this.markStale((candidate) => candidate.generationInputHash === generationInputHash);
  }

  public findTaskByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<MediaTaskRecord | null> {
    return Promise.resolve(
      this.tasks.find(
        (task) => task.projectId === projectId && task.idempotencyKey === idempotencyKey,
      ) ?? null,
    );
  }

  public findTaskById(projectId: string, taskId: string): Promise<MediaTaskRecord | null> {
    return Promise.resolve(
      this.tasks.find((task) => task.projectId === projectId && task.id === taskId) ?? null,
    );
  }

  public insertTask(input: {
    batchId?: string | null;
    candidateCount: number;
    generationInputHash: string;
    id: string;
    idempotencyKey: string;
    projectId: string;
    shotId: string;
    shotVersionId: string;
  }): Promise<MediaTaskRecord> {
    const roundNo =
      Math.max(
        0,
        ...this.candidates.map((candidate) =>
          candidate.shotId === input.shotId ? candidate.roundNo : 0,
        ),
      ) + 1;
    const record: MediaTaskRecord = {
      ...input,
      createdAt: NOW,
      errorCode: null,
      phase: 'SUBMITTED',
      providerTaskId: null,
      roundNo,
      updatedAt: NOW,
    };
    this.tasks.push(record);
    if (input.batchId != null) this.taskBatchIds.set(input.id, input.batchId);
    return Promise.resolve(record);
  }

  public markTaskPolling(taskId: string, providerTaskId: string): Promise<MediaTaskRecord> {
    const task = this.transition(taskId, (record) => {
      // 已处于 POLLING 视为幂等重放，保留原 taskId（与 SQL 实现语义对齐）。
      if (record.phase === 'POLLING') return record;
      if (record.phase !== 'SUBMITTED') return null;
      return { ...record, phase: 'POLLING', providerTaskId, updatedAt: NOW };
    });
    return Promise.resolve(task);
  }

  public markTaskDownloading(taskId: string): Promise<MediaTaskRecord> {
    const task = this.transition(taskId, (record) => {
      // DOWNLOADING 幂等（调度器逐候选懒转移，重复调用不抛）。
      if (record.phase === 'DOWNLOADING') return record;
      if (record.phase !== 'SUBMITTED' && record.phase !== 'POLLING') return null;
      return { ...record, phase: 'DOWNLOADING', updatedAt: NOW };
    });
    return Promise.resolve(task);
  }

  public completeTask(taskId: string): Promise<MediaTaskRecord> {
    return Promise.resolve(this.finishTask(taskId, 'COMPLETED', null));
  }

  public failTask(taskId: string, errorCode: string): Promise<MediaTaskRecord> {
    return Promise.resolve(this.finishTask(taskId, 'FAILED', errorCode));
  }

  public cancelTask(taskId: string): Promise<MediaTaskRecord> {
    return Promise.resolve(this.finishTask(taskId, 'CANCELLED', null));
  }

  public listUnfinishedTasks(projectId: string): Promise<readonly MediaTaskRecord[]> {
    return Promise.resolve(
      this.tasks.filter(
        (task) =>
          task.projectId === projectId &&
          task.phase !== 'COMPLETED' &&
          task.phase !== 'FAILED' &&
          task.phase !== 'CANCELLED',
      ),
    );
  }

  public findBatchByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<MediaBatchRecord | null> {
    return Promise.resolve(
      this.batches.find(
        (batch) => batch.projectId === projectId && batch.idempotencyKey === idempotencyKey,
      ) ?? null,
    );
  }

  public findBatchById(projectId: string, batchId: string): Promise<MediaBatchRecord | null> {
    return Promise.resolve(
      this.batches.find((batch) => batch.projectId === projectId && batch.id === batchId) ?? null,
    );
  }

  public insertBatch(input: {
    id: string;
    idempotencyKey: string;
    projectId: string;
    skippedShotIds: readonly string[];
    targetShotIds: readonly string[];
  }): Promise<MediaBatchRecord> {
    const conflict = this.batches.some(
      (batch) =>
        batch.projectId === input.projectId && batch.idempotencyKey === input.idempotencyKey,
    );
    if (conflict) throw new Error('MEDIA_BATCH_IDEMPOTENCY_CONFLICT');
    const record: MediaBatchRecord = {
      ...input,
      createdAt: NOW,
      errorCode: null,
      pendingShotIds: [...input.targetShotIds],
      status: 'RUNNING',
      updatedAt: NOW,
    };
    this.batches.push(record);
    return Promise.resolve(record);
  }

  public findRunningBatchByProject(projectId: string): Promise<MediaBatchRecord | null> {
    return Promise.resolve(
      this.batches.find((batch) => batch.projectId === projectId && batch.status === 'RUNNING') ??
        null,
    );
  }

  public listRunningBatchProjectIds(): Promise<readonly string[]> {
    return Promise.resolve([
      ...new Set(
        this.batches.filter((batch) => batch.status === 'RUNNING').map((batch) => batch.projectId),
      ),
    ]);
  }

  public takeNextPendingShot(batchId: string): Promise<string | null> {
    const batch = this.requireBatch(batchId);
    if (batch.status !== 'RUNNING' || batch.pendingShotIds.length === 0)
      return Promise.resolve(null);
    const head = batch.pendingShotIds[0];
    if (head === undefined) return Promise.resolve(null);
    this.patchBatch(batchId, { pendingShotIds: batch.pendingShotIds.slice(1) });
    return Promise.resolve(head);
  }

  public finalizeBatch(batchId: string, errorCode?: string): Promise<MediaBatchRecord> {
    const batch = this.requireBatch(batchId);
    if (batch.status !== 'RUNNING') throw new Error('MEDIA_BATCH_ALREADY_TERMINAL');
    // 失败成员定义（与 SQLite finalizeBatch/buildBatchView 同一口径）：任务 FAILED，
    // 或任务 COMPLETED 但同轮零 SUCCEEDED 候选（Provider 错误全败时任务相位仍 COMPLETED）。
    const hasFailed = this.tasks.some((task) => {
      if (this.taskBatchIds.get(task.id) !== batchId) return false;
      if (task.phase === 'FAILED') return true;
      if (task.phase !== 'COMPLETED') return false;
      return !this.candidates.some(
        (candidate) =>
          candidate.shotId === task.shotId &&
          candidate.roundNo === task.roundNo &&
          candidate.status === 'SUCCEEDED',
      );
    });
    const status =
      batch.pendingShotIds.length === 0 && !hasFailed && errorCode === undefined
        ? 'COMPLETED'
        : 'PARTIAL_COMPLETED';
    return Promise.resolve(this.patchBatch(batchId, { errorCode: errorCode ?? null, status }));
  }

  public cancelBatch(batchId: string): Promise<MediaBatchRecord> {
    const batch = this.requireBatch(batchId);
    if (batch.status !== 'RUNNING') return Promise.resolve(batch);
    return Promise.resolve(this.patchBatch(batchId, { status: 'CANCELLED' }));
  }

  public listBatchesByProject(
    projectId: string,
    limit: number,
  ): Promise<readonly MediaBatchRecord[]> {
    return Promise.resolve(
      [...this.batches]
        .filter((batch) => batch.projectId === projectId)
        .reverse()
        .slice(0, limit),
    );
  }

  public listBatchMemberTasks(batchId: string): Promise<readonly MediaTaskRecord[]> {
    return Promise.resolve(this.tasks.filter((task) => this.taskBatchIds.get(task.id) === batchId));
  }

  public countUnfinishedBatchTasks(batchId: string): Promise<number> {
    return Promise.resolve(
      this.tasks.filter(
        (task) =>
          this.taskBatchIds.get(task.id) === batchId &&
          task.phase !== 'COMPLETED' &&
          task.phase !== 'FAILED' &&
          task.phase !== 'CANCELLED',
      ).length,
    );
  }

  public listSucceededCandidateShotHashes(
    projectId: string,
  ): Promise<readonly MediaSucceededShotHash[]> {
    const counts = new Map<string, MediaSucceededShotHash>();
    for (const candidate of this.candidates) {
      if (candidate.status !== 'SUCCEEDED') continue;
      if (this.candidateProjectIds.get(candidate.id) !== projectId) continue;
      const key = `${candidate.shotId}:${candidate.generationInputHash}`;
      const prior = counts.get(key);
      counts.set(key, {
        generationInputHash: candidate.generationInputHash,
        succeededCount: (prior?.succeededCount ?? 0) + 1,
        shotId: candidate.shotId,
      });
    }
    return Promise.resolve([...counts.values()]);
  }

  public listLatestTaskPerShot(projectId: string): Promise<readonly MediaTaskRecord[]> {
    const latest = new Map<string, MediaTaskRecord>();
    for (const task of this.tasks) {
      if (task.projectId !== projectId) continue;
      const current = latest.get(task.shotId);
      if (current === undefined || task.roundNo > current.roundNo) latest.set(task.shotId, task);
    }
    return Promise.resolve([...latest.values()]);
  }

  private requireBatch(batchId: string): MediaBatchRecord {
    const batch = this.batches.find((entry) => entry.id === batchId);
    if (batch === undefined) throw new Error('MEDIA_BATCH_NOT_FOUND');
    return batch;
  }

  private patchBatch(batchId: string, patch: Partial<MediaBatchRecord>): MediaBatchRecord {
    const index = this.batches.findIndex((entry) => entry.id === batchId);
    const current = this.batches[index];
    if (current === undefined) throw new Error('MEDIA_BATCH_NOT_FOUND');
    const next = { ...current, ...patch, updatedAt: NOW };
    this.batches[index] = next;
    return next;
  }

  private completeCandidate(
    candidateId: string,
    patch: Pick<
      MediaCandidateRecord,
      | 'byteSize'
      | 'errorCode'
      | 'fileSha256'
      | 'height'
      | 'invocationEvidenceRef'
      | 'mimeType'
      | 'status'
      | 'storageRelPath'
      | 'width'
    >,
  ): Promise<MediaCandidateRecord> {
    const index = this.candidates.findIndex((candidate) => candidate.id === candidateId);
    const current = this.candidates[index];
    if (current === undefined) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
    // 守卫与 SQL 实现对齐：仅 PENDING 可落终态；非 PENDING（STALE 竞态）原样返回。
    if (current.status === 'PENDING') {
      this.candidates[index] = { ...current, ...patch, updatedAt: NOW };
    }
    const updated = this.candidates[index];
    if (updated === undefined) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
    return Promise.resolve(updated);
  }

  private markStale(
    predicate: (candidate: MediaCandidateRecord) => boolean,
  ): Promise<readonly MediaStaleAffectedShot[]> {
    const affected = new Map<string, number>();
    this.candidates.forEach((candidate, index) => {
      if (!predicate(candidate)) return;
      if (candidate.status === 'STALE_INPUT') return;
      affected.set(candidate.shotId, (affected.get(candidate.shotId) ?? 0) + 1);
      this.candidates[index] = {
        ...candidate,
        errorCode: null,
        status: 'STALE_INPUT',
        updatedAt: NOW,
      };
    });
    return Promise.resolve(
      [...affected.entries()]
        .map(([shotId, candidateCount]) => ({ candidateCount, shotId }))
        .sort((a, b) => (a.shotId < b.shotId ? -1 : 1)),
    );
  }

  private finishTask(
    taskId: string,
    phase: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    errorCode: string | null,
  ): MediaTaskRecord {
    return this.transition(taskId, (record) => {
      if (
        record.phase === 'COMPLETED' ||
        record.phase === 'FAILED' ||
        record.phase === 'CANCELLED'
      ) {
        return record.phase === phase ? record : null;
      }
      return { ...record, errorCode, phase, updatedAt: NOW };
    });
  }

  private transition(
    taskId: string,
    apply: (record: MediaTaskRecord) => MediaTaskRecord | null,
  ): MediaTaskRecord {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    const current = this.tasks[index];
    if (current === undefined) throw new Error('MEDIA_TASK_NOT_FOUND');
    const next = apply(current);
    if (next === null) throw new Error('MEDIA_TASK_ALREADY_TERMINAL');
    this.tasks[index] = next;
    return next;
  }
}
