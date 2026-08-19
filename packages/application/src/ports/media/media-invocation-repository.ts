/**
 * 媒体调用证据仓储端口（media-invocation-evidence design D1/D4）。
 *
 * 每段真实 Provider 请求（SUBMIT/DOWNLOAD）一行：两段式留证——段前 insert
 * STARTED（含请求快照与 sha256，不含参考图字节与凭据），响应后在候选终态
 * 同一事务内 finishTerminal 收尾；中断残留的 STARTED 行如实保留（不参与
 * 恢复决策）。媒体域证据独立成表（model_invocations 的 job_id FK 不兼容，
 * 见 change proposal）。
 */

/** 段类型：POLL 枚举预留（Seedream 为 SYNC 形态恒不触发）。 */
export type MediaInvocationSegment = 'SUBMIT' | 'POLL' | 'DOWNLOAD';

export type MediaInvocationStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

/** insert 输入：时间戳由实现方 clock 填充；状态恒 STARTED（两段式第一段）。 */
export interface MediaInvocationStartInput {
  readonly id: string;
  readonly mediaTaskId: string;
  readonly candidateId: string;
  readonly segmentKind: MediaInvocationSegment;
  readonly modelId: string;
  readonly requestSnapshotJson: string;
  readonly requestSha256: string;
}

/** finishTerminal 输入：终态证据（成功含响应/usage；失败含归一 error_code 与原文）。 */
export interface MediaInvocationTerminalEvidence {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly finishedAt: string;
  readonly providerRequestId?: string | null;
  readonly responseHttpStatus?: number | null;
  readonly rawResponseBlob?: Uint8Array | null;
  readonly rawResponseTruncated?: boolean;
  readonly rawResponseSha256?: string | null;
  readonly providerReportedGeneratedImages?: number | null;
  readonly providerReportedOutputTokens?: number | null;
  readonly errorCode?: string | null;
}

/** 证据行读取形态（findById/listByTaskId 返回）。 */
export interface MediaModelInvocationRecord {
  readonly id: string;
  readonly mediaTaskId: string;
  readonly candidateId: string;
  readonly segmentKind: MediaInvocationSegment;
  readonly status: MediaInvocationStatus;
  readonly modelId: string;
  readonly requestSnapshotJson: string;
  readonly requestSha256: string;
  readonly providerRequestId: string | null;
  readonly responseHttpStatus: number | null;
  readonly rawResponseBlob: Uint8Array | null;
  readonly rawResponseTruncated: boolean;
  readonly rawResponseSha256: string | null;
  readonly providerReportedGeneratedImages: number | null;
  readonly providerReportedOutputTokens: number | null;
  readonly errorCode: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MediaInvocationRepository {
  /** 两段式第一段：插 STARTED 行（重复 id 由数据库 PK 拒绝，沿稳定标记约定）。 */
  insert(input: MediaInvocationStartInput): Promise<void>;
  /** 两段式第二段：STARTED → 终态（幂等拒绝：非 STARTED 行返回 false）。 */
  finishTerminal(id: string, evidence: MediaInvocationTerminalEvidence): Promise<boolean>;
  findById(id: string): Promise<MediaModelInvocationRecord | null>;
  listByTaskId(mediaTaskId: string): Promise<readonly MediaModelInvocationRecord[]>;
}
