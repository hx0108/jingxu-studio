import type {
  MediaInvocationRepository,
  MediaInvocationStartInput,
  MediaInvocationTerminalEvidence,
  MediaModelInvocationRecord,
} from '../ports/media/media-invocation-repository';

const NOW = '2026-08-19T00:00:00.000Z';

/**
 * 内存版 MediaInvocationRepository（沿 InMemoryMediaRepository 模式）：只为驱动
 * 应用层语义。守卫与 SqliteMediaInvocationRepository 对齐——重复 id 抛
 * MEDIA_INVOCATION_PERSISTENCE_FAILED、非 STARTED 收尾返回 false。
 */
export class InMemoryMediaInvocationRepository implements MediaInvocationRepository {
  public readonly invocations: MediaModelInvocationRecord[] = [];

  public insert(input: MediaInvocationStartInput): Promise<void> {
    if (this.invocations.some((row) => row.id === input.id)) {
      throw new Error('MEDIA_INVOCATION_PERSISTENCE_FAILED');
    }
    this.invocations.push({
      candidateId: input.candidateId,
      createdAt: NOW,
      errorCode: null,
      finishedAt: null,
      id: input.id,
      mediaTaskId: input.mediaTaskId,
      modelId: input.modelId,
      providerRequestId: null,
      providerReportedGeneratedImages: null,
      providerReportedOutputTokens: null,
      rawResponseBlob: null,
      rawResponseSha256: null,
      rawResponseTruncated: false,
      requestSha256: input.requestSha256,
      requestSnapshotJson: input.requestSnapshotJson,
      responseHttpStatus: null,
      segmentKind: input.segmentKind,
      status: 'STARTED',
      updatedAt: NOW,
    });
    return Promise.resolve();
  }

  public finishTerminal(id: string, evidence: MediaInvocationTerminalEvidence): Promise<boolean> {
    const row = this.invocations.find((entry) => entry.id === id);
    if (row === undefined || row.status !== 'STARTED') return Promise.resolve(false);
    Object.assign(row, {
      errorCode: evidence.errorCode ?? null,
      finishedAt: evidence.finishedAt,
      providerRequestId: evidence.providerRequestId ?? null,
      providerReportedGeneratedImages: evidence.providerReportedGeneratedImages ?? null,
      providerReportedOutputTokens: evidence.providerReportedOutputTokens ?? null,
      rawResponseBlob: evidence.rawResponseBlob ?? null,
      rawResponseSha256: evidence.rawResponseSha256 ?? null,
      rawResponseTruncated: evidence.rawResponseTruncated === true,
      responseHttpStatus: evidence.responseHttpStatus ?? null,
      status: evidence.status,
      updatedAt: NOW,
    });
    return Promise.resolve(true);
  }

  public findById(id: string): Promise<MediaModelInvocationRecord | null> {
    return Promise.resolve(this.invocations.find((row) => row.id === id) ?? null);
  }

  public listByTaskId(mediaTaskId: string): Promise<readonly MediaModelInvocationRecord[]> {
    return Promise.resolve(this.invocations.filter((row) => row.mediaTaskId === mediaTaskId));
  }
}
