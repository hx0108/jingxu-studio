import type {
  VoiceCandidateFileRegistration,
  VoiceCandidateRecord,
  VoiceGenerationRepositoryPort,
  VoiceJobEvidenceEntry,
  VoiceJobRecord,
} from '../ports/voice/voice-generation-repository';

/**
 * 内存版 VoiceGenerationRepository（沿 InMemoryVideoMediaRepository 模式，供
 * VoiceGenerationService / VoiceGenerationScheduler 测试共用）：只为驱动应用层
 * 语义，不模拟 SQL 约束之外的并发细节；终态守卫与 Sqlite 实现对齐——守卫失败
 * 抛同名稳定 message 标记（候选行不可原地改写终态）。
 */
export class InMemoryVoiceGenerationRepository implements VoiceGenerationRepositoryPort {
  public readonly jobs: VoiceJobRecord[] = [];
  public readonly candidates: VoiceCandidateRecord[] = [];

  public insertJob(job: VoiceJobRecord): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }

  public findJobByRequest(projectId: string, requestId: string): Promise<VoiceJobRecord | null> {
    return Promise.resolve(
      this.jobs.find((job) => job.projectId === projectId && job.requestId === requestId) ?? null,
    );
  }

  public findJobById(projectId: string, jobId: string): Promise<VoiceJobRecord | null> {
    return Promise.resolve(
      this.jobs.find((job) => job.projectId === projectId && job.id === jobId) ?? null,
    );
  }

  public findActiveJobByProject(projectId: string): Promise<VoiceJobRecord | null> {
    return Promise.resolve(
      this.jobs.find(
        (job) =>
          job.projectId === projectId && (job.status === 'QUEUED' || job.status === 'RUNNING'),
      ) ?? null,
    );
  }

  public markJobRunning(jobId: string, updatedAt: string): Promise<void> {
    this.mutateJob(jobId, (job) => {
      if (job.status !== 'QUEUED') throw new Error('VOICE_JOB_NOT_QUEUED');
      return { ...job, status: 'RUNNING', updatedAt };
    });
    return Promise.resolve();
  }

  public cancelJob(jobId: string, at: string): Promise<void> {
    this.mutateJob(jobId, (job) => {
      if (job.status === 'QUEUED' || job.status === 'RUNNING') {
        return {
          ...job,
          evidence: [...job.evidence, { at, candidateId: null, outcome: 'CANCELLED', shotId: '*' }],
          status: 'CANCELLED',
          updatedAt: at,
        };
      }
      return job;
    });
    return Promise.resolve();
  }

  public appendJobEvidence(jobId: string, entry: VoiceJobEvidenceEntry): Promise<void> {
    this.mutateJob(jobId, (job) => ({ ...job, evidence: [...job.evidence, entry] }));
    return Promise.resolve();
  }

  public finalizeJob(
    jobId: string,
    status: 'COMPLETED' | 'PARTIAL_COMPLETED',
    updatedAt: string,
  ): Promise<void> {
    this.mutateJob(jobId, (job) => {
      if (job.status !== 'RUNNING') throw new Error('VOICE_JOB_NOT_RUNNING');
      return { ...job, status, updatedAt };
    });
    return Promise.resolve();
  }

  public insertCandidate(candidate: VoiceCandidateRecord): Promise<void> {
    if (this.candidates.some((row) => row.id === candidate.id)) {
      throw new Error('VOICE_CANDIDATE_DUPLICATE');
    }
    this.candidates.push(candidate);
    return Promise.resolve();
  }

  public findCandidate(
    projectId: string,
    candidateId: string,
  ): Promise<VoiceCandidateRecord | null> {
    return Promise.resolve(
      this.candidates.find((row) => row.projectId === projectId && row.id === candidateId) ?? null,
    );
  }

  public listCandidatesByShot(shotId: string): Promise<VoiceCandidateRecord[]> {
    return Promise.resolve(this.candidates.filter((row) => row.shotId === shotId));
  }

  public nextRoundNo(shotId: string): Promise<number> {
    const rounds = this.candidates.filter((row) => row.shotId === shotId).map((row) => row.roundNo);
    return Promise.resolve((rounds.length > 0 ? Math.max(...rounds) : 0) + 1);
  }

  public finalizeCandidateSucceeded(
    candidateId: string,
    registration: VoiceCandidateFileRegistration,
    updatedAt: string,
  ): Promise<void> {
    this.mutateCandidate(candidateId, (candidate) => {
      if (candidate.status !== 'PENDING') throw new Error('VOICE_CANDIDATE_NOT_PENDING');
      return {
        ...candidate,
        byteSize: registration.byteSize,
        durationMs: registration.durationMs,
        fileSha256: registration.fileSha256,
        mimeType: registration.mimeType,
        status: 'SUCCEEDED',
        storageRelPath: registration.storageRelPath,
        updatedAt,
      };
    });
    return Promise.resolve();
  }

  public finalizeCandidateFailed(
    candidateId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    this.mutateCandidate(candidateId, (candidate) => {
      if (candidate.status !== 'PENDING') throw new Error('VOICE_CANDIDATE_NOT_PENDING');
      return { ...candidate, errorCode, status: 'FAILED', updatedAt };
    });
    return Promise.resolve();
  }

  public interruptCandidate(
    candidateId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    this.mutateCandidate(candidateId, (candidate) => {
      if (candidate.status !== 'PENDING') throw new Error('VOICE_CANDIDATE_NOT_PENDING');
      return { ...candidate, errorCode, status: 'FAILED', updatedAt };
    });
    return Promise.resolve();
  }

  public markCandidatesStale(candidateIds: readonly string[], updatedAt: string): Promise<void> {
    const ids = new Set(candidateIds);
    for (const [index, row] of this.candidates.entries()) {
      if (ids.has(row.id) && row.status === 'SUCCEEDED') {
        // 与 0020 CHECK 对齐：duration_ms 仅 SUCCEEDED 携带，STALE 迁移清零。
        this.candidates[index] = {
          ...row,
          durationMs: null,
          status: 'STALE_INPUT',
          updatedAt,
        };
      }
    }
    return Promise.resolve();
  }

  public selectCandidate(candidateId: string, selectedAt: string): Promise<void> {
    const target = this.candidates.find((row) => row.id === candidateId);
    if (target === undefined) throw new Error('VOICE_CANDIDATE_NOT_FOUND');
    if (target.status !== 'SUCCEEDED') throw new Error('VOICE_CANDIDATE_NOT_SELECTABLE');
    for (const [index, row] of this.candidates.entries()) {
      if (row.shotId === target.shotId && row.id !== candidateId && row.selectedAt !== null) {
        this.candidates[index] = { ...row, selectedAt: null };
      }
    }
    this.candidates[this.candidates.indexOf(target)] = { ...target, selectedAt };
    return Promise.resolve();
  }

  public deleteCandidate(candidateId: string): Promise<void> {
    const index = this.candidates.findIndex((row) => row.id === candidateId);
    if (index < 0) throw new Error('VOICE_CANDIDATE_NOT_FOUND');
    this.candidates.splice(index, 1);
    return Promise.resolve();
  }

  public listSucceededShotHashes(
    projectId: string,
  ): Promise<readonly { generationInputHash: string; shotId: string }[]> {
    return Promise.resolve(
      this.candidates
        .filter((row) => row.projectId === projectId && row.status === 'SUCCEEDED')
        .map((row) => ({ generationInputHash: row.generationInputHash, shotId: row.shotId })),
    );
  }

  private mutateJob(jobId: string, mutate: (job: VoiceJobRecord) => VoiceJobRecord): void {
    for (const [index, job] of this.jobs.entries()) {
      if (job.id !== jobId) continue;
      this.jobs[index] = mutate(job);
      return;
    }
    throw new Error('VOICE_JOB_NOT_FOUND');
  }

  private mutateCandidate(
    candidateId: string,
    mutate: (candidate: VoiceCandidateRecord) => VoiceCandidateRecord,
  ): void {
    for (const [index, row] of this.candidates.entries()) {
      if (row.id !== candidateId) continue;
      this.candidates[index] = mutate(row);
      return;
    }
    throw new Error('VOICE_CANDIDATE_NOT_FOUND');
  }
}
