/**
 * VoiceGenerationService（v2-voice-audio-timeline tasks 4.2，spec R2/R3）。
 *
 * 配音生成 IPC 用例编排：整集批量建档（目标=audio_required 且 spoken_text 非空
 * 且当前世代无 SUCCEEDED 候选；其余入跳过清单如实回告）、requestId 幂等重放、
 * 映射缺口整批阻断（VOICE_MAPPING_MISSING 清单）、候选读取（镜头改文后旧候选
 * 惰性标记 STALE_INPUT 且不再可被选入时间线）、人工选择与登记删除。
 * Provider 调用与两段式证据属调度器（voice-generation-scheduler）；本层零 Provider I/O。
 */

import type {
  AppResultDto,
  DeleteVoiceCandidateInputDto,
  GenerateVoiceForEpisodeInputDto,
  GetVoiceGenerationsInputDto,
  ProjectErrorCode,
  SelectVoiceCandidateInputDto,
  VoiceCandidateViewDto,
  VoiceEpisodeBatchViewDto,
} from '@jingxu/contracts';
import { voiceCandidateMediaUrl } from '@jingxu/contracts';

import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type {
  VoiceCandidateRecord,
  VoiceGenerationRepositoryPort,
  VoiceJobSkipEntry,
} from '../ports/voice/voice-generation-repository';
import {
  collectMappingGaps,
  voiceMappingGapFailure,
  type VoiceMappingService,
} from './voice-mapping-service';
import { computeVoiceGenerationInputHash, extractVoiceShotFields } from './voice-generation-input';

const failure = <T>(
  code: ProjectErrorCode,
  message: string,
  traceId: string,
  retryable = false,
  userAction: string | null = null,
): AppResultDto<T> => ({
  error: { code, fieldErrors: null, message, retryable, traceId, userAction },
  ok: false,
});

const persistenceFailure = <T>(traceId: string): AppResultDto<T> =>
  failure<T>('MEDIA_PERSISTENCE_FAILED', '配音数据暂时无法保存，请重试', traceId, true);

export interface VoiceGenerationServiceDependencies {
  /** 建批前置凭据闸：未配置/不可解密先于建批稳定失败（组合根同源注入）。 */
  readonly assertCredentialReady?: (() => Promise<void>) | undefined;
  readonly clock: () => string;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (text: string) => string;
  readonly mappings: Pick<VoiceMappingService, 'resolveEffectiveMappings'>;
  readonly model: { readonly resolveModel: () => Promise<{ readonly modelId: string }> };
  readonly newId: () => string;
  readonly repositories: VoiceGenerationRepositoryPort;
  /** 建档成功后触发该项目后台排空（组合根以晚绑定引用注入，解开循环依赖）。 */
  readonly scheduler: { readonly kick: (projectId: string) => void };
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface VoiceGenerationService {
  generateForEpisode(
    input: GenerateVoiceForEpisodeInputDto,
    traceId: string,
  ): Promise<AppResultDto<VoiceEpisodeBatchViewDto>>;
  getGenerations(
    input: GetVoiceGenerationsInputDto,
    traceId: string,
  ): Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  selectCandidate(
    input: SelectVoiceCandidateInputDto,
    traceId: string,
  ): Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  deleteCandidate(
    input: DeleteVoiceCandidateInputDto,
    traceId: string,
  ): Promise<AppResultDto<{ candidateId: string }>>;
}

/** 候选行 → 契约视图（mediaUrl 仅 SUCCEEDED；STALE_INPUT 不可选也不可试听）。 */
const toCandidateView = (candidate: VoiceCandidateRecord): VoiceCandidateViewDto => ({
  byteSize: candidate.byteSize,
  createdAt: candidate.createdAt,
  durationMs: candidate.durationMs,
  errorCode: candidate.errorCode,
  generationInputHash: candidate.generationInputHash,
  id: candidate.id,
  indexInRound: candidate.indexInRound,
  mediaUrl: candidate.status === 'SUCCEEDED' ? voiceCandidateMediaUrl(candidate.id) : null,
  modelId: candidate.modelId,
  mimeType: candidate.mimeType,
  roundNo: candidate.roundNo,
  selectedAt: candidate.selectedAt,
  shotId: candidate.shotId,
  shotVersionId: candidate.shotVersionId,
  speakerId: candidate.speakerId,
  spokenTextSha256: candidate.spokenTextSha256,
  status: candidate.status,
  voiceId: candidate.voiceId,
});

export const createVoiceGenerationService = (
  dependencies: VoiceGenerationServiceDependencies,
): VoiceGenerationService => {
  const { repositories } = dependencies;

  return {
    generateForEpisode: async (input, traceId) => {
      try {
        // 前置凭据闸：未配置/不可解密先于一切建档稳定失败（spec R1 指向配音设置）。
        if (dependencies.assertCredentialReady !== undefined) {
          try {
            await dependencies.assertCredentialReady();
          } catch {
            return failure(
              'VOICE_PROVIDER_NOT_CONFIGURED',
              '配音 Provider 凭据未配置或密文不可解密。',
              traceId,
              false,
              '在剧本工作区「Provider 设置」的配音卡片中保存 DashScope API Key 后重试。',
            );
          }
        }
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return failure(
            'SCRIPT_WORKSPACE_NOT_INITIALIZED',
            '剧本工作区尚未初始化，无法批量生成配音',
            traceId,
          );
        }
        const storyboard = workspace.storyboard;
        if (storyboard.current?.status !== 'READY') {
          return failure(
            'MEDIA_STORYBOARD_NOT_READY',
            '分镜尚未确认 READY，无法批量生成配音',
            traceId,
          );
        }
        // requestId 幂等重放：同 requestId 直接回原回执；目标集合漂移视为复用。
        const replay = await repositories.findJobByRequest(input.projectId, input.requestId);
        if (replay !== null) {
          const replaySet = new Set([
            ...replay.targetShotIds,
            ...replay.skippedShots.map((skip) => skip.shotId),
          ]);
          const inputSet = new Set(input.shotIds);
          const sameShots =
            replaySet.size === inputSet.size && input.shotIds.every((id) => replaySet.has(id));
          if (!sameShots) {
            return failure('REQUEST_ID_REUSED', 'requestId 已用于不同批次', traceId);
          }
          return {
            data: {
              batchId: replay.id,
              createdAt: replay.createdAt,
              skippedShots: [...replay.skippedShots],
              targetShotIds: [...replay.targetShotIds],
            },
            ok: true,
          };
        }
        const { modelId } = await dependencies.model.resolveModel();
        const effective = await dependencies.mappings.resolveEffectiveMappings(input.projectId);
        // 逐镜头分类：先按台词判据筛目标（speaker 缺映射留到缺口闸整批阻断）。
        const succeededKeys = new Set(
          (await repositories.listSucceededShotHashes(input.projectId)).map(
            (entry) => `${entry.shotId}:${entry.generationInputHash}`,
          ),
        );
        const targets: string[] = [];
        const skipped: VoiceJobSkipEntry[] = [];
        const targetSpeakers = new Set<string>();
        for (const shotId of input.shotIds) {
          const snapshot = storyboard.currentShots.find((entry) => entry.shotId === shotId);
          if (snapshot === undefined) {
            return failure(
              'MEDIA_SHOT_NOT_IN_READY_SET',
              '镜头不在当前 READY 分镜集合中，请刷新后重试',
              traceId,
            );
          }
          const fields = extractVoiceShotFields(snapshot.version.document);
          // 文档损坏（行异常）按目标外跳过如实回告，不产生失败记录。
          if (
            fields === null ||
            !fields.audioRequired ||
            fields.spokenText === null ||
            fields.speakerId === null
          ) {
            skipped.push({ reason: 'NOT_VOICE_TARGET', shotId });
            continue;
          }
          const voiceId = effective.get(fields.speakerId);
          if (voiceId === undefined) {
            targetSpeakers.add(fields.speakerId);
            targets.push(shotId);
            continue;
          }
          const hash = computeVoiceGenerationInputHash(
            {
              modelId,
              shotVersionId: snapshot.version.id,
              spokenTextSha256: dependencies.hashText(fields.spokenText),
              voiceId,
            },
            dependencies.hashPayload,
          );
          if (succeededKeys.has(`${shotId}:${hash}`)) {
            skipped.push({ reason: 'ALREADY_GENERATED', shotId });
          } else {
            targetSpeakers.add(fields.speakerId);
            targets.push(shotId);
          }
        }
        // 映射缺口整批阻断（spec R3）：零 Provider 请求、零 job 行。
        const gaps = collectMappingGaps([...targetSpeakers], effective);
        if (gaps.length > 0) {
          return voiceMappingGapFailure(gaps, traceId);
        }
        if (targets.length === 0) {
          return failure(
            'MEDIA_BATCH_NO_PENDING_SHOTS',
            '所选镜头均无台词或当前世代已有配音，无需重新生成',
            traceId,
            false,
            '如需重新生成，请在配音面板中单独发起（已有候选不会被覆盖）。',
          );
        }
        const running = await repositories.findActiveJobByProject(input.projectId);
        if (running !== null) {
          return failure(
            'MEDIA_BATCH_ALREADY_RUNNING',
            '当前项目已有配音批量任务进行中，请等待完成',
            traceId,
          );
        }
        const now = dependencies.clock();
        const job = {
          createdAt: now,
          episodeId: input.episodeId,
          evidence: [],
          id: dependencies.newId(),
          projectId: input.projectId,
          requestId: input.requestId,
          skippedShots: skipped,
          status: 'QUEUED' as const,
          targetShotIds: targets,
          updatedAt: now,
        };
        await repositories.insertJob(job);
        dependencies.scheduler.kick(input.projectId);
        return {
          data: {
            batchId: job.id,
            createdAt: job.createdAt,
            skippedShots: skipped,
            targetShotIds: targets,
          },
          ok: true,
        };
      } catch {
        return persistenceFailure(traceId);
      }
    },

    getGenerations: async (input, traceId) => {
      try {
        const candidates = await repositories.listCandidatesByShot(input.shotId);
        // STALE 惰性标记：镜头当前世代哈希与候选冻结哈希漂移 → SUCCEEDED 旧候选
        // 迁移 STALE_INPUT（保留音频与证据；spec R2 改文失效场景）。
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        const snapshot = workspace?.storyboard.currentShots.find(
          (entry) => entry.shotId === input.shotId,
        );
        if (workspace !== null && snapshot !== undefined) {
          const fields = extractVoiceShotFields(snapshot.version.document);
          if (
            fields !== null &&
            fields.audioRequired &&
            fields.spokenText !== null &&
            fields.speakerId !== null
          ) {
            try {
              const { modelId } = await dependencies.model.resolveModel();
              const effective = await dependencies.mappings.resolveEffectiveMappings(
                input.projectId,
              );
              const voiceId = effective.get(fields.speakerId);
              if (voiceId !== undefined) {
                const currentHash = computeVoiceGenerationInputHash(
                  {
                    modelId,
                    shotVersionId: snapshot.version.id,
                    spokenTextSha256: dependencies.hashText(fields.spokenText),
                    voiceId,
                  },
                  dependencies.hashPayload,
                );
                const staleIds = candidates
                  .filter(
                    (row) => row.status === 'SUCCEEDED' && row.generationInputHash !== currentHash,
                  )
                  .map((row) => row.id);
                if (staleIds.length > 0) {
                  await repositories.markCandidatesStale(staleIds, dependencies.clock());
                  const refreshed = await repositories.listCandidatesByShot(input.shotId);
                  return { data: refreshed.map(toCandidateView), ok: true };
                }
              }
            } catch {
              // Provider 未配置等读路径异常：跳过 STALE 判定，按既有状态如实返回。
            }
          }
        }
        return { data: candidates.map(toCandidateView), ok: true };
      } catch {
        return persistenceFailure(traceId);
      }
    },

    selectCandidate: async (input, traceId) => {
      try {
        const candidate = await repositories.findCandidate(input.projectId, input.candidateId);
        if (candidate === null) {
          return failure('MEDIA_CANDIDATE_NOT_FOUND', '配音候选不存在或不在该项目中', traceId);
        }
        if (candidate.status === 'STALE_INPUT') {
          return failure(
            'VOICE_CANDIDATE_STALE',
            '该候选因镜头台词变更已失效，请重新选择当前候选',
            traceId,
            false,
            '请为该镜头重新生成配音后选择新候选。',
          );
        }
        if (candidate.status !== 'SUCCEEDED') {
          return failure('MEDIA_CANDIDATE_NOT_SELECTABLE', '仅成功候选可设为当前配音', traceId);
        }
        await repositories.selectCandidate(input.candidateId, dependencies.clock());
        const refreshed = await repositories.listCandidatesByShot(candidate.shotId);
        return { data: refreshed.map(toCandidateView), ok: true };
      } catch {
        return persistenceFailure(traceId);
      }
    },

    deleteCandidate: async (input, traceId) => {
      try {
        const candidate = await repositories.findCandidate(input.projectId, input.candidateId);
        if (candidate === null) {
          return failure('MEDIA_CANDIDATE_NOT_FOUND', '配音候选不存在或不在该项目中', traceId);
        }
        if (candidate.status === 'PENDING') {
          return failure('IPC_INVALID_REQUEST', '该候选正在生成中，无法删除', traceId);
        }
        // 仅删登记行：共享 CAS 音频文件由内容寻址存储管理（4.3），不受影响。
        await repositories.deleteCandidate(input.candidateId);
        return { data: { candidateId: input.candidateId }, ok: true };
      } catch {
        return persistenceFailure(traceId);
      }
    },
  };
};
