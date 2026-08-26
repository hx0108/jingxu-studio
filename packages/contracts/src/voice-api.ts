import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { MEDIA_BATCH_MAX_SHOTS } from './image-api';
import { projectIdSchema, requestIdSchema } from './project-dto';

/**
 * 语音 IPC 公共契约（v2-voice-audio-timeline design D6）。
 * 本切片仅落 DTO/通道定义；`voice` 命名空间挂入 JingxuApi 与 preload
 * 白名单随 IPC 桥接切片（tasks 3.1/4.2）同步扩展，避免中间态破坏
 * preload apiKeys 断言。
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const shotIdSchema = idSchema;
const candidateIdSchema = idSchema;
const batchIdSchema = idSchema;

/** 与 shot 契约 SPEAKER_ID_PATTERN 对齐：narrator 或 char_* 角色 ID。 */
export const voiceSpeakerIdSchema = z.string().regex(/^(narrator|char_[A-Za-z0-9_-]{1,64})$/u);

/** 注册表外的任意音色/模型字符串在服务层按白名单拒绝；契约只锁形状。 */
export const voiceIdSchema = z.string().min(1).max(128);

export const voiceCandidateStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT']);

/** 配音候选的受限取流 URL；Renderer 不接触文件系统路径。 */
export const voiceCandidateMediaUrl = (candidateId: string): string =>
  `jingxu://media/voice-candidate/${candidateId}`;

export const voiceCandidateViewSchema = z
  .object({
    byteSize: z.number().int().nonnegative().nullable(),
    createdAt: isoDateTimeSchema,
    /** ffprobe 实测时长；SUCCEEDED 必带，不得以估算伪造。 */
    durationMs: z.number().int().positive().nullable(),
    errorCode: z.string().min(1).max(64).nullable(),
    generationInputHash: hashSchema,
    id: candidateIdSchema,
    indexInRound: z.number().int().nonnegative(),
    mediaUrl: z.string().startsWith('jingxu://media/voice-candidate/').nullable(),
    /** 冻结的 TTS 模型 ID（注册表内值）。 */
    modelId: voiceIdSchema,
    mimeType: z.enum(['audio/mpeg', 'audio/wav', 'audio/mp4']).nullable(),
    roundNo: z.number().int().positive(),
    selectedAt: isoDateTimeSchema.nullable(),
    shotId: shotIdSchema,
    shotVersionId: idSchema,
    speakerId: voiceSpeakerIdSchema,
    spokenTextSha256: hashSchema,
    status: voiceCandidateStatusSchema,
    /** 冻结的音色 ID（注册表内值）。 */
    voiceId: voiceIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'SUCCEEDED') {
      if (
        value.mediaUrl === null ||
        value.byteSize === null ||
        value.mimeType === null ||
        value.durationMs === null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'SUCCEEDED 配音候选必须携带 mediaUrl/byteSize/mimeType/durationMs。',
          path: ['status'],
        });
      }
    } else if (value.mediaUrl !== null) {
      context.addIssue({
        code: 'custom',
        message: '非 SUCCEEDED 配音候选不得携带 mediaUrl。',
        path: ['mediaUrl'],
      });
    }
    if (value.status !== 'FAILED' && value.errorCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'errorCode 只在 FAILED 状态携带。',
        path: ['errorCode'],
      });
    }
  });

export const voiceMappingSchema = z
  .object({
    speakerId: voiceSpeakerIdSchema,
    updatedAt: isoDateTimeSchema,
    voiceId: voiceIdSchema,
  })
  .strict();

/** 整集批量生成的镜头跳过原因（spec voice-audio-timeline R2 稳定枚举）。 */
export const voiceGenerationSkipReasonSchema = z.enum(['NOT_VOICE_TARGET', 'ALREADY_GENERATED']);

export const voiceEpisodeBatchViewSchema = z
  .object({
    batchId: batchIdSchema,
    createdAt: isoDateTimeSchema,
    skippedShots: z
      .array(
        z
          .object({
            reason: voiceGenerationSkipReasonSchema,
            shotId: shotIdSchema,
          })
          .strict(),
      )
      .max(MEDIA_BATCH_MAX_SHOTS),
    targetShotIds: z.array(shotIdSchema).min(1).max(MEDIA_BATCH_MAX_SHOTS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const shot of value.skippedShots) {
      if (seen.has(shot.shotId)) {
        context.addIssue({
          code: 'custom',
          message: 'skippedShots 的 shotId 不得重复。',
          path: ['skippedShots'],
        });
        break;
      }
      seen.add(shot.shotId);
    }
    for (const shotId of value.targetShotIds) {
      if (seen.has(shotId)) {
        context.addIssue({
          code: 'custom',
          message: 'targetShotIds 与 skippedShots 不得重叠。',
          path: ['targetShotIds'],
        });
        break;
      }
      seen.add(shotId);
    }
  });

export const getVoiceMappingsInputSchema = z.object({ projectId: projectIdSchema }).strict();
export const saveVoiceMappingInputSchema = z
  .object({
    mappings: z
      .array(z.object({ speakerId: voiceSpeakerIdSchema, voiceId: voiceIdSchema }).strict())
      .min(1)
      .max(64),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const mapping of value.mappings) {
      if (seen.has(mapping.speakerId)) {
        context.addIssue({
          code: 'custom',
          message: 'mappings 的 speakerId 不得重复。',
          path: ['mappings'],
        });
        break;
      }
      seen.add(mapping.speakerId);
    }
  });
export const generateVoiceForEpisodeInputSchema = z
  .object({
    episodeId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotIds: z.array(shotIdSchema).min(1).max(MEDIA_BATCH_MAX_SHOTS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.shotIds).size !== value.shotIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'shotIds 不得重复。',
        path: ['shotIds'],
      });
    }
  });
export const getVoiceGenerationsInputSchema = z
  .object({ projectId: projectIdSchema, shotId: shotIdSchema })
  .strict();
export const selectVoiceCandidateInputSchema = z
  .object({
    candidateId: candidateIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const deleteVoiceCandidateInputSchema = z
  .object({
    candidateId: candidateIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const voiceCandidateDeleteResultSchema = z
  .object({ candidateId: candidateIdSchema })
  .strict();

export type VoiceCandidateViewDto = z.infer<typeof voiceCandidateViewSchema>;
export type VoiceMappingDto = z.infer<typeof voiceMappingSchema>;
export type VoiceGenerationSkipReason = z.infer<typeof voiceGenerationSkipReasonSchema>;
export type VoiceEpisodeBatchViewDto = z.infer<typeof voiceEpisodeBatchViewSchema>;
export type GetVoiceMappingsInputDto = z.infer<typeof getVoiceMappingsInputSchema>;
export type SaveVoiceMappingInputDto = z.infer<typeof saveVoiceMappingInputSchema>;
export type GenerateVoiceForEpisodeInputDto = z.infer<typeof generateVoiceForEpisodeInputSchema>;
export type GetVoiceGenerationsInputDto = z.infer<typeof getVoiceGenerationsInputSchema>;
export type SelectVoiceCandidateInputDto = z.infer<typeof selectVoiceCandidateInputSchema>;
export type DeleteVoiceCandidateInputDto = z.infer<typeof deleteVoiceCandidateInputSchema>;
export type VoiceCandidateDeleteResultDto = z.infer<typeof voiceCandidateDeleteResultSchema>;

export interface VoiceApi {
  /** 项目级角色音色映射（narrator 固定行始终在列）。 */
  getMappings(input: GetVoiceMappingsInputDto): Promise<AppResultDto<VoiceMappingDto[]>>;
  /** 保存映射集合；speakerId 去重、音色白名单校验在服务层执行。 */
  saveMapping(input: SaveVoiceMappingInputDto): Promise<AppResultDto<VoiceMappingDto[]>>;
  /**
   * 整集配音批量（显式用户动作）：目标=audio_required 且 spoken_text 非空、
   * 当前输入世代无 SUCCEEDED 候选的镜头；跳过镜头以稳定原因回告。
   */
  generateForEpisode(
    input: GenerateVoiceForEpisodeInputDto,
  ): Promise<AppResultDto<VoiceEpisodeBatchViewDto>>;
  /** 按镜头返回全部配音候选（含 STALE_INPUT 历史）。 */
  getGenerations(
    input: GetVoiceGenerationsInputDto,
  ): Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  /** 人工选择/切换当前配音候选；返回全量候选刷新选择态。 */
  selectCandidate(
    input: SelectVoiceCandidateInputDto,
  ): Promise<AppResultDto<VoiceCandidateViewDto[]>>;
  /** 删除候选登记行；共享 CAS 音频文件不受影响。 */
  deleteCandidate(
    input: DeleteVoiceCandidateInputDto,
  ): Promise<AppResultDto<VoiceCandidateDeleteResultDto>>;
}

export const VOICE_IPC_CHANNELS = {
  deleteCandidate: 'voice.deleteCandidate',
  generateForEpisode: 'voice.generateForEpisode',
  getGenerations: 'voice.getGenerations',
  getMappings: 'voice.getMappings',
  saveMapping: 'voice.saveMapping',
  selectCandidate: 'voice.selectCandidate',
} as const;
