import type {
  MediaAssetRecord,
  MediaAssetType,
  MediaAssetVersionRecord,
  MediaCandidateRecord,
  MediaRepository,
  MediaStaleAffectedShot,
  MediaTaskRecord,
} from '../ports/media/media-repository';

const NOW = '2026-08-16T00:00:00.000Z';

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

  public listAssets(): Promise<
    readonly { asset: MediaAssetRecord; versions: readonly MediaAssetVersionRecord[] }[]
  > {
    return Promise.resolve(
      this.assets.map((asset) => ({
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

  public selectCandidate(): Promise<void> {
    throw new Error('not used in media service tests');
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
