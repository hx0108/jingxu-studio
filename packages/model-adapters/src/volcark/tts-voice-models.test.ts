import { describe, expect, it } from 'vitest';

import {
  ARK_TTS_MODELS,
  ARK_TTS_VOICES,
  DEFAULT_ARK_TTS_MODEL_ID,
  NARRATOR_DEFAULT_VOICE_ID,
  getArkTtsModel,
  getArkTtsVoice,
  isArkTtsModelId,
  isArkTtsVoiceId,
} from './tts-voice-models';

describe('tts-voice-models 受限注册表', () => {
  it('探测前全部条目 PENDING 且不可选—未核验模型音色不得进入真实生成', () => {
    for (const model of ARK_TTS_MODELS) {
      expect(model.probeStatus).toBe('PENDING');
      expect(model.selectable).toBe(false);
      expect(model.snapshotDate).toBe('pending-probe');
    }
    for (const voice of ARK_TTS_VOICES) {
      expect(voice.probeStatus).toBe('PENDING');
      expect(voice.selectable).toBe(false);
      expect(voice.snapshotDate).toBe('pending-probe');
    }
  });

  it('id 全局唯一—注册表查询单值命中', () => {
    expect(new Set(ARK_TTS_MODELS.map((model) => model.id)).size).toBe(ARK_TTS_MODELS.length);
    expect(new Set(ARK_TTS_VOICES.map((voice) => voice.id)).size).toBe(ARK_TTS_VOICES.length);
  });

  it('默认模型与 narrator 旁白音色—均在注册表内且类型守卫通过', () => {
    expect(isArkTtsModelId(DEFAULT_ARK_TTS_MODEL_ID)).toBe(true);
    expect(getArkTtsModel(DEFAULT_ARK_TTS_MODEL_ID)?.id).toBe(DEFAULT_ARK_TTS_MODEL_ID);
    expect(isArkTtsVoiceId(NARRATOR_DEFAULT_VOICE_ID)).toBe(true);
    expect(getArkTtsVoice(NARRATOR_DEFAULT_VOICE_ID)?.id).toBe(NARRATOR_DEFAULT_VOICE_ID);
  });

  it('未登记 id—类型守卫 false 且 getter 返回 null', () => {
    expect(isArkTtsModelId('doubao-seed-tts-fake')).toBe(false);
    expect(getArkTtsModel('doubao-seed-tts-fake')).toBeNull();
    expect(isArkTtsVoiceId('zh_male_nonexistent')).toBe(false);
    expect(getArkTtsVoice('zh_male_nonexistent')).toBeNull();
  });

  it('语速上限与输出格式—重生成档位约束在合法区间', () => {
    for (const model of ARK_TTS_MODELS) {
      expect(model.maxSpeechRate).toBeGreaterThan(1);
      expect(model.maxSpeechRate).toBeLessThanOrEqual(2);
      expect(model.outputMimeTypes.length).toBeGreaterThan(0);
    }
  });
});
