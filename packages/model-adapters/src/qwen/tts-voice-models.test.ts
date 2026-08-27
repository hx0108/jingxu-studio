import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QWEN_TTS_MODEL_ID,
  NARRATOR_DEFAULT_VOICE_ID,
  QWEN_TTS_MODELS,
  QWEN_TTS_VOICES,
  getQwenTtsModel,
  getQwenTtsVoice,
  isQwenTtsModelId,
  isQwenTtsVoiceId,
} from './tts-voice-models';

describe('tts-voice-models 受限注册表', () => {
  it('2.2 探测后全部条目 VERIFIED 且可选—真实合成链路开放', () => {
    for (const model of QWEN_TTS_MODELS) {
      expect(model.probeStatus).toBe('VERIFIED');
      expect(model.selectable).toBe(true);
      expect(model.snapshotDate).not.toBe('pending-probe');
    }
    for (const voice of QWEN_TTS_VOICES) {
      expect(voice.probeStatus).toBe('VERIFIED');
      expect(voice.selectable).toBe(true);
      expect(voice.snapshotDate).not.toBe('pending-probe');
    }
  });

  it('id 全局唯一—注册表查询单值命中', () => {
    expect(new Set(QWEN_TTS_MODELS.map((model) => model.id)).size).toBe(QWEN_TTS_MODELS.length);
    expect(new Set(QWEN_TTS_VOICES.map((voice) => voice.id)).size).toBe(QWEN_TTS_VOICES.length);
  });

  it('默认模型与 narrator 旁白音色—均在注册表内且类型守卫通过', () => {
    expect(isQwenTtsModelId(DEFAULT_QWEN_TTS_MODEL_ID)).toBe(true);
    expect(getQwenTtsModel(DEFAULT_QWEN_TTS_MODEL_ID)?.id).toBe(DEFAULT_QWEN_TTS_MODEL_ID);
    expect(isQwenTtsVoiceId(NARRATOR_DEFAULT_VOICE_ID)).toBe(true);
    expect(getQwenTtsVoice(NARRATOR_DEFAULT_VOICE_ID)?.id).toBe(NARRATOR_DEFAULT_VOICE_ID);
  });

  it('未登记 id—类型守卫 false 且 getter 返回 null', () => {
    expect(isQwenTtsModelId('qwen3-tts-fake')).toBe(false);
    expect(getQwenTtsModel('qwen3-tts-fake')).toBeNull();
    expect(isQwenTtsVoiceId('probe-voice-fake')).toBe(false);
    expect(getQwenTtsVoice('probe-voice-fake')).toBeNull();
  });

  it('探测证伪的音色不得回流—Dylan/Lenn 表列仅 realtime 系实测被拒', () => {
    expect(isQwenTtsVoiceId('Dylan')).toBe(false);
    expect(isQwenTtsVoiceId('Lenn')).toBe(false);
  });

  it('语速上限与输出格式—重生成档位约束在合法区间、输出 mime 为实测 WAV', () => {
    for (const model of QWEN_TTS_MODELS) {
      expect(model.maxSpeechRate).toBeGreaterThan(1);
      expect(model.maxSpeechRate).toBeLessThanOrEqual(2);
      expect(model.outputMimeTypes).toContain('audio/wav');
    }
  });
});
