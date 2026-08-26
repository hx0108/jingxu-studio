/**
 * VoiceGenerationScheduler（v2-voice-audio-timeline tasks 4.2，design D2）。
 *
 * 同步 TTS 端口的轻量调度器——复用既有调度语义，不引入 poll 循环：
 * - 同项目严格串行：kick 触发后台排空，链内逐 job 逐镜头推进；跨项目互不阻塞。
 * - 两段式证据：STARTED 证据先于 Provider 调用落库，TERMINAL 随终态追加——
 *   证据是恢复唯一可信边界（不含 spoken_text 与凭据）。
 * - 取消先落库：cancel 先写 CANCELLED 状态与证据，再中止在飞请求（AbortSignal
 *   归一化为 MODEL_CANCELLED）；已落库终态不被迟到路径覆盖。
 * - 恢复只信证据：无终态证据的 PENDING 候选标记中断失败（VOICE_INTERRUPTED）
 *   且不自动重发；剩余未开始镜头由 kick 续跑（resume = 重放目标差集）。
 * - 单镜头失败不阻断：FAILED 证据计数使 job 收尾为 PARTIAL_COMPLETED。
 */

import type { TtsSynthesisRequest, TtsSynthesisResult } from '../ports/tts-model/tts-model-types';
import type { NormalizedModelError } from '../ports/text-model/text-model-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type {
  VoiceCandidateFileRegistration,
  VoiceCandidateRecord,
  VoiceGenerationRepositoryPort,
  VoiceJobEvidenceEntry,
  VoiceJobRecord,
} from '../ports/voice/voice-generation-repository';
import type { VoiceMappingService } from './voice-mapping-service';
import { computeVoiceGenerationInputHash, extractVoiceShotFields } from './voice-generation-input';

/** 恢复时无终态证据候选的稳定中断码（Renderer 提示人工重试，不自动重发）。 */
export const VOICE_INTERRUPTED_ERROR_CODE = 'VOICE_INTERRUPTED';

export interface VoiceGenerationSchedulerDependencies {
  readonly clock: () => string;
  /** canonical JSON sha256（组合根注入，与图片/视频侧同构）。 */
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (text: string) => string;
  readonly mappings: Pick<VoiceMappingService, 'resolveEffectiveMappings'>;
  readonly model: { readonly resolveModel: () => Promise<{ readonly modelId: string }> };
  readonly newId: () => string;
  /** 4.3 交付：CAS audio 写入 + ffprobe durationMs>0 + mime 白名单 + 同 hash 去重。 */
  readonly registerAudio: (
    payload: TtsSynthesisResult['audio'],
  ) => Promise<VoiceCandidateFileRegistration>;
  readonly repositories: VoiceGenerationRepositoryPort;
  readonly synthesize: (
    request: TtsSynthesisRequest,
    signal: AbortSignal,
  ) => Promise<TtsSynthesisResult>;
  readonly normalizeError: (error: unknown) => NormalizedModelError;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface VoiceGenerationScheduler {
  /** 建批/恢复后触发项目排空（幂等；链已在跑则标记续跑）。 */
  kick(projectId: string): void;
  /** 取消当前活跃 job：先落库 CANCELLED，再中止在飞请求。 */
  cancel(projectId: string): Promise<void>;
  /** 重启恢复：无终态证据的 PENDING 候选标记中断失败（不自动重发）。 */
  recover(projectId: string): Promise<void>;
  /** 测试/关停用：等待该项目排空链结束。 */
  whenSettled(projectId: string): Promise<void>;
}

/** 已有终态证据的镜头集合（SUCCEEDED/FAILED/SKIPPED 均视为完成，INTERRUPTED 除外）。 */
const terminalShotsOf = (job: VoiceJobRecord): ReadonlySet<string> => {
  const terminal = new Set<string>();
  for (const entry of job.evidence) {
    if (
      entry.outcome === 'SUCCEEDED' ||
      entry.outcome === 'FAILED' ||
      entry.outcome === 'SKIPPED'
    ) {
      terminal.add(entry.shotId);
    } else if (entry.outcome === 'INTERRUPTED') {
      // 中断失败也是终态（不重发）；CANCELLED 的全局行 shotId='*' 不参与镜头集合。
      terminal.add(entry.shotId);
    }
  }
  return terminal;
};

/** 失败成员计数（FAILED/INTERRUPTED 证据；SKIPPED 不算失败）。 */
const failedShotsOf = (job: VoiceJobRecord): number => {
  const failed = new Set<string>();
  for (const entry of job.evidence) {
    if (entry.outcome === 'FAILED' || entry.outcome === 'INTERRUPTED') failed.add(entry.shotId);
  }
  return failed.size;
};

export const createVoiceGenerationScheduler = (
  dependencies: VoiceGenerationSchedulerDependencies,
): VoiceGenerationScheduler => {
  const { repositories } = dependencies;
  /** 每项目一条排空链 + 续跑标记；kick 幂等。 */
  const chains = new Map<string, Promise<void>>();
  const rerunFlags = new Set<string>();
  /** 每项目在飞 AbortController（cancel 先落库再触发）。 */
  const aborts = new Map<string, AbortController>();

  const appendEvidence = async (
    jobId: string,
    shotId: string,
    candidateId: string | null,
    outcome: VoiceJobEvidenceEntry['outcome'],
  ): Promise<void> => {
    await repositories.appendJobEvidence(jobId, {
      at: dependencies.clock(),
      candidateId,
      outcome,
      shotId,
    });
  };

  /**
   * 单镜头执行：解析当前输入 → PENDING 候选 → STARTED 证据 → 同步调用 → 登记 →
   * 终态候选 + TERMINAL 证据。任何一步失败都收敛为候选 FAILED + 稳定错误码。
   */
  const runShot = async (job: VoiceJobRecord, shotId: string): Promise<void> => {
    const shot = await dependencies.workspaceQuery.getWorkspace(job.projectId);
    const snapshot = shot?.storyboard.currentShots.find((entry) => entry.shotId === shotId);
    const fields =
      snapshot === undefined ? null : extractVoiceShotFields(snapshot.version.document);
    // 镜头已不在 READY 集合或文档损坏：如实记 SKIPPED（非失败），证据即回执。
    if (snapshot === undefined || fields === null) {
      await appendEvidence(job.id, shotId, null, 'SKIPPED');
      return;
    }
    if (!fields.audioRequired || fields.spokenText === null || fields.speakerId === null) {
      // 建批后台词被清空/改为字幕镜头：记 SKIPPED（不产生失败记录）。
      await appendEvidence(job.id, shotId, null, 'SKIPPED');
      return;
    }
    const effective = await dependencies.mappings.resolveEffectiveMappings(job.projectId);
    const voiceId = effective.get(fields.speakerId);
    if (voiceId === undefined) {
      // 建批后映射被删：失败成员（缺口在建批闸拦截；此处为运行期漂移防御）。
      await appendEvidence(job.id, shotId, null, 'FAILED');
      return;
    }
    const { modelId } = await dependencies.model.resolveModel();
    const spokenTextSha256 = dependencies.hashText(fields.spokenText);
    const generationInputHash = computeVoiceGenerationInputHash(
      { modelId, shotVersionId: snapshot.version.id, spokenTextSha256, voiceId },
      dependencies.hashPayload,
    );
    const candidateId = dependencies.newId();
    const now = dependencies.clock();
    const candidate: VoiceCandidateRecord = {
      byteSize: null,
      createdAt: now,
      durationMs: null,
      errorCode: null,
      fileSha256: null,
      generationInputHash,
      id: candidateId,
      indexInRound: 0,
      jobId: job.id,
      mimeType: null,
      modelId,
      projectId: job.projectId,
      roundNo: await repositories.nextRoundNo(shotId),
      selectedAt: null,
      shotId,
      shotVersionId: snapshot.version.id,
      speakerId: fields.speakerId,
      spokenTextSha256,
      status: 'PENDING',
      storageRelPath: null,
      updatedAt: now,
      voiceId,
    };
    await repositories.insertCandidate(candidate);
    // STARTED 证据先于 Provider 调用落库——崩溃窗口由此界定。
    await appendEvidence(job.id, shotId, candidateId, 'STARTED');
    const controller = new AbortController();
    aborts.set(job.projectId, controller);
    try {
      const result = await dependencies.synthesize(
        { invocationId: candidateId, modelId, spokenText: fields.spokenText, voiceId },
        controller.signal,
      );
      const registration = await dependencies.registerAudio(result.audio);
      await repositories.finalizeCandidateSucceeded(
        candidateId,
        registration,
        dependencies.clock(),
      );
      await appendEvidence(job.id, shotId, candidateId, 'SUCCEEDED');
    } catch (caught: unknown) {
      const normalized = dependencies.normalizeError(caught);
      await repositories.finalizeCandidateFailed(
        candidateId,
        normalized.code,
        dependencies.clock(),
      );
      await appendEvidence(job.id, shotId, candidateId, 'FAILED');
    } finally {
      if (aborts.get(job.projectId) === controller) aborts.delete(job.projectId);
    }
  };

  const drain = async (projectId: string): Promise<void> => {
    for (;;) {
      try {
        const job = await repositories.findActiveJobByProject(projectId);
        if (job === null) {
          if (rerunFlags.delete(projectId)) continue;
          return;
        }
        if (job.status === 'QUEUED') {
          await repositories.markJobRunning(job.id, dependencies.clock());
        }
        const terminal = terminalShotsOf(job);
        const remaining = job.targetShotIds.filter((shotId) => !terminal.has(shotId));
        for (const shotId of remaining) {
          // 每镜头前重读状态：取消先落库后，此处立即停止消费剩余队列。
          const current = await repositories.findJobById(projectId, job.id);
          if (current?.status !== 'RUNNING') break;
          await runShot(current, shotId);
        }
        const finished = await repositories.findJobById(projectId, job.id);
        if (finished !== null && finished.status === 'RUNNING') {
          // 队列耗尽（或取消竞态下仍 RUNNING）：按失败成员计数收尾。
          await repositories.finalizeJob(
            job.id,
            failedShotsOf(finished) > 0 ? 'PARTIAL_COMPLETED' : 'COMPLETED',
            dependencies.clock(),
          );
        }
      } catch {
        // 持久层异常：终止本链（job 保持 RUNNING，由下次 kick/启动恢复续跑）——
        // 不静默重试也不无限循环，失败留给恢复边界如实暴露。
        return;
      }
    }
  };

  return {
    kick: (projectId) => {
      if (chains.has(projectId)) {
        rerunFlags.add(projectId);
        return;
      }
      const chain = drain(projectId).finally(() => {
        chains.delete(projectId);
      });
      chains.set(projectId, chain);
    },

    cancel: async (projectId) => {
      // 取消先落库：状态与 CANCELLED 证据写库后，再中止在飞请求。
      const job = await repositories.findActiveJobByProject(projectId);
      if (job === null) return;
      await repositories.cancelJob(job.id, dependencies.clock());
      aborts.get(projectId)?.abort();
    },

    recover: async (projectId) => {
      // 只信证据：STARTED 证据存在但无终态，或纯 PENDING（无任何证据）——一律
      // 中断失败，不自动重发；剩余镜头由 kick 按 evidence 差集续跑。
      const job = await repositories.findActiveJobByProject(projectId);
      if (job === null) return;
      const rows = await Promise.all(
        job.targetShotIds.map((shotId) => repositories.listCandidatesByShot(shotId)),
      );
      for (const shotCandidates of rows) {
        for (const row of shotCandidates) {
          if (row.status !== 'PENDING') continue;
          await repositories.interruptCandidate(
            row.id,
            VOICE_INTERRUPTED_ERROR_CODE,
            dependencies.clock(),
          );
          await appendEvidence(job.id, row.shotId, row.id, 'INTERRUPTED');
        }
      }
    },

    whenSettled: (projectId) => chains.get(projectId) ?? Promise.resolve(),
  };
};
