import { describe, expect, it } from 'vitest';

import {
  VOICE_IPC_CHANNELS,
  generateVoiceForEpisodeInputSchema,
  saveVoiceMappingInputSchema,
  voiceCandidateMediaUrl,
  voiceCandidateViewSchema,
  voiceEpisodeBatchViewSchema,
} from './voice-api';

const candidateId = 'vcand_00000001';
const shotId = 'shot_00000001';
const projectId = 'proj_00000001';
const episodeId = 'epis_00000001';
const requestId = 'req_000000001';
const batchId = 'vbat_00000001';
const hash = 'a'.repeat(64);
const iso = '2026-08-25T00:00:00.000Z';

const succeededCandidate = {
  byteSize: 2048,
  createdAt: iso,
  durationMs: 3200,
  errorCode: null,
  generationInputHash: hash,
  id: candidateId,
  indexInRound: 0,
  mediaUrl: voiceCandidateMediaUrl(candidateId),
  modelId: 'doubao-seed-tts-1-0-pending-probe',
  mimeType: 'audio/mpeg',
  roundNo: 1,
  selectedAt: null,
  shotId,
  shotVersionId: 'shver_0000001',
  speakerId: 'narrator',
  spokenTextSha256: hash,
  status: 'SUCCEEDED',
  voiceId: 'ark-tts-voice-pending-01',
} as const;

describe('voice-api contracts', () => {
  it('SUCCEEDED 配音候选—受限协议 URL 与时长口径必带', () => {
    expect(voiceCandidateViewSchema.safeParse(succeededCandidate).success).toBe(true);
    expect(
      voiceCandidateViewSchema.safeParse({ ...succeededCandidate, durationMs: null }).success,
    ).toBe(false);
    expect(
      voiceCandidateViewSchema.safeParse({ ...succeededCandidate, mediaUrl: '/abs/path.mp3' })
        .success,
    ).toBe(false);
  });

  it('非 SUCCEEDED 候选—不得携带 mediaUrl、errorCode 仅 FAILED', () => {
    const pending = {
      ...succeededCandidate,
      mediaUrl: null,
      byteSize: null,
      mimeType: null,
      durationMs: null,
      status: 'PENDING' as const,
    };
    expect(voiceCandidateViewSchema.safeParse(pending).success).toBe(true);
    expect(
      voiceCandidateViewSchema.safeParse({ ...pending, errorCode: 'VOICE_TTS_FAILED' }).success,
    ).toBe(false);
    const failed = { ...pending, status: 'FAILED' as const, errorCode: 'MODEL_TIMEOUT' };
    expect(voiceCandidateViewSchema.safeParse(failed).success).toBe(true);
  });

  it('非法 speakerId— narrator 或 char_* 之外拒绝', () => {
    expect(
      voiceCandidateViewSchema.safeParse({ ...succeededCandidate, speakerId: 'hero' }).success,
    ).toBe(false);
    expect(
      voiceCandidateViewSchema.safeParse({ ...succeededCandidate, speakerId: 'char_hero' }).success,
    ).toBe(true);
  });

  it('音色映射保存—speakerId 重复拒绝', () => {
    const input = {
      mappings: [
        { speakerId: 'char_hero', voiceId: 'ark-tts-voice-pending-03' },
        { speakerId: 'char_hero', voiceId: 'ark-tts-voice-pending-04' },
      ],
      projectId,
      requestId,
    };
    expect(saveVoiceMappingInputSchema.safeParse(input).success).toBe(false);
    expect(
      saveVoiceMappingInputSchema.safeParse({
        ...input,
        mappings: [input.mappings[0]],
      }).success,
    ).toBe(true);
  });

  it('整集生成输入—shotIds 重复拒绝且上限 20', () => {
    const input = { episodeId, projectId, requestId, shotIds: [shotId] };
    expect(generateVoiceForEpisodeInputSchema.safeParse(input).success).toBe(true);
    expect(
      generateVoiceForEpisodeInputSchema.safeParse({
        ...input,
        shotIds: [shotId, shotId],
      }).success,
    ).toBe(false);
    expect(
      generateVoiceForEpisodeInputSchema.safeParse({
        ...input,
        shotIds: Array.from({ length: 21 }, (_, index) => `shot_${String(index).padStart(8, '0')}`),
      }).success,
    ).toBe(false);
  });

  it('批次视图—target 与 skipped 不得重叠', () => {
    const view = {
      batchId,
      createdAt: iso,
      skippedShots: [{ reason: 'NOT_VOICE_TARGET' as const, shotId: 'shot_00000002' }],
      targetShotIds: [shotId],
    };
    expect(voiceEpisodeBatchViewSchema.safeParse(view).success).toBe(true);
    expect(
      voiceEpisodeBatchViewSchema.safeParse({
        ...view,
        skippedShots: [{ reason: 'NOT_VOICE_TARGET', shotId }],
      }).success,
    ).toBe(false);
  });

  it('IPC 通道—全部位于 voice.* 命名空间', () => {
    for (const channel of Object.values(VOICE_IPC_CHANNELS)) {
      expect(channel.startsWith('voice.')).toBe(true);
    }
    expect(Object.keys(VOICE_IPC_CHANNELS)).toHaveLength(6);
  });
});
