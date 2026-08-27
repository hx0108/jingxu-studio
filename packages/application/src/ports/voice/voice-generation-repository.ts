/**
 * 配音生成持久化 Port（v2-voice-audio-timeline tasks 4.2，design D3）。
 *
 * job 行即批次（同步 TtsModelPort 无成员任务表）：目标/跳过清单与两段式调用
 * 证据随 job 行持久化；候选行承载结果（四元组同生同灭由 0020 迁移 CHECK 保证）。
 * 证据边界沿用 media-invocation-evidence：不含 spoken_text、凭据或 Provider 原文。
 */

import type { VoiceGenerationSkipReason } from '@jingxu/contracts';

/** 同步调度器相位（0020 voice_generation_jobs.status CHECK 同源）。 */
export type VoiceJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL_COMPLETED' | 'CANCELLED';

/** 两段式调用证据条目（STARTED 在调用前落库；TERMINAL 为终态边界）。 */
export interface VoiceJobEvidenceEntry {
  readonly at: string;
  readonly candidateId: string | null;
  readonly outcome: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED' | 'CANCELLED';
  readonly shotId: string;
}

export interface VoiceJobSkipEntry {
  readonly reason: VoiceGenerationSkipReason;
  readonly shotId: string;
}

export interface VoiceJobRecord {
  readonly createdAt: string;
  readonly episodeId: string;
  readonly evidence: readonly VoiceJobEvidenceEntry[];
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  /** 建批回执：目标镜头（建档时判定）与跳过清单（含稳定原因）。 */
  readonly skippedShots: readonly VoiceJobSkipEntry[];
  readonly status: VoiceJobStatus;
  readonly targetShotIds: readonly string[];
  readonly updatedAt: string;
}

/** 0020 voice_candidates 行形态；SUCCEEDED 行四元组+时长必齐（迁移 CHECK 保证）。 */
export interface VoiceCandidateRecord {
  readonly byteSize: number | null;
  readonly createdAt: string;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly fileSha256: string | null;
  readonly generationInputHash: string;
  readonly id: string;
  readonly indexInRound: number;
  readonly jobId: string;
  readonly mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/mp4' | null;
  readonly modelId: string;
  readonly projectId: string;
  readonly roundNo: number;
  readonly selectedAt: string | null;
  readonly shotId: string;
  readonly shotVersionId: string;
  readonly speakerId: string;
  readonly spokenTextSha256: string;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STALE_INPUT';
  readonly storageRelPath: string | null;
  readonly updatedAt: string;
  readonly voiceId: string;
}

/** SUCCEEDED 终态落库所需的登记产物（4.3 CAS+ffprobe 交付形状）。 */
export interface VoiceCandidateFileRegistration {
  readonly byteSize: number;
  readonly durationMs: number;
  readonly fileSha256: string;
  readonly mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/mp4';
  readonly storageRelPath: string;
}

export interface VoiceGenerationRepositoryPort {
  insertJob(job: VoiceJobRecord): Promise<void>;
  findJobByRequest(projectId: string, requestId: string): Promise<VoiceJobRecord | null>;
  findJobById(projectId: string, jobId: string): Promise<VoiceJobRecord | null>;
  /** QUEUED 或 RUNNING（同项目至多一个——建批闸保证）。 */
  findActiveJobByProject(projectId: string): Promise<VoiceJobRecord | null>;
  markJobRunning(jobId: string, updatedAt: string): Promise<void>;
  /** 取消先落库：status→CANCELLED 并追加 CANCELLED 证据（在飞请求随后中止）。 */
  cancelJob(jobId: string, at: string): Promise<void>;
  /** 追加两段式证据（STARTED / TERMINAL）。 */
  appendJobEvidence(jobId: string, entry: VoiceJobEvidenceEntry): Promise<void>;
  /** 队列耗尽收尾：COMPLETED（零失败）或 PARTIAL_COMPLETED（存在失败成员）。 */
  finalizeJob(
    jobId: string,
    status: 'COMPLETED' | 'PARTIAL_COMPLETED',
    updatedAt: string,
  ): Promise<void>;

  insertCandidate(candidate: VoiceCandidateRecord): Promise<void>;
  findCandidate(projectId: string, candidateId: string): Promise<VoiceCandidateRecord | null>;
  listCandidatesByShot(shotId: string): Promise<VoiceCandidateRecord[]>;
  /** 下一轮次号 = 该镜头现有最大 round_no + 1（多候选保留不覆盖）。 */
  nextRoundNo(shotId: string): Promise<number>;
  finalizeCandidateSucceeded(
    candidateId: string,
    registration: VoiceCandidateFileRegistration,
    updatedAt: string,
  ): Promise<void>;
  finalizeCandidateFailed(candidateId: string, errorCode: string, updatedAt: string): Promise<void>;
  /** 恢复：无终态证据的未完结候选标记中断失败（不自动重发）。 */
  interruptCandidate(candidateId: string, errorCode: string, updatedAt: string): Promise<void>;
  /** 镜头改文后的旧候选失效标记（保留音频与证据，仅状态迁移）。 */
  markCandidatesStale(candidateIds: readonly string[], updatedAt: string): Promise<void>;
  /** 人工选择当前候选：清除同镜头旧 selected 指针后落位（partial unique 保证）。 */
  selectCandidate(candidateId: string, selectedAt: string): Promise<void>;
  /** 删除登记行（仅登记；共享 CAS 文件不受影响）。 */
  deleteCandidate(candidateId: string): Promise<void>;
  /** 建批过滤底座：SUCCEEDED 候选的 (shotId, generationInputHash) 全集。 */
  listSucceededShotHashes(
    projectId: string,
  ): Promise<readonly { readonly generationInputHash: string; readonly shotId: string }[]>;
}
