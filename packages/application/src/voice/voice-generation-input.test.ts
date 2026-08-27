import { describe, expect, it } from 'vitest';

import { computeVoiceGenerationInputHash, extractVoiceShotFields } from './voice-generation-input';

const hashText = (text: string): string => {
  let low = 0;
  let high = 0;
  for (let index = 0; index < text.length; index += 1) {
    low = (low * 31 + text.charCodeAt(index)) % 1_000_000_007;
    high = (high * 37 + (text.charCodeAt(index) ^ index)) % 998_244_353;
  }
  return `${low.toString(16)}${high.toString(16)}`.padEnd(64, '0').slice(0, 64);
};
const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hashText(
    Object.keys(value)
      .sort()
      .map((key) => `${key}=${String(value[key])}`)
      .join('|'),
  );

const shotDocument = (overrides: {
  audioRequired?: boolean;
  speakerId?: string | null;
  spokenText?: string;
}): string =>
  JSON.stringify({
    content: { spoken_text: overrides.spokenText ?? '' },
    dialogue: {
      audio_required: overrides.audioRequired ?? false,
      dialogue_render_mode: 'NARRATION_FIRST',
      estimated_speech_duration_sec: 3,
      speaker_id: overrides.speakerId ?? null,
    },
  });

describe('voice-generation-input（tasks 4.2）', () => {
  it('台词字段提取—narrator 有台词镜头', () => {
    expect(
      extractVoiceShotFields(
        shotDocument({ audioRequired: true, speakerId: 'narrator', spokenText: '雨巷开场' }),
      ),
    ).toEqual({ audioRequired: true, speakerId: 'narrator', spokenText: '雨巷开场' });
  });

  it('台词字段提取—SUBTITLE_ONLY 与空台词如实返回', () => {
    expect(extractVoiceShotFields(shotDocument({ spokenText: '仅字幕' }))).toEqual({
      audioRequired: false,
      speakerId: null,
      spokenText: '仅字幕',
    });
    expect(
      extractVoiceShotFields(shotDocument({ audioRequired: true, speakerId: 'narrator' })),
    ).toEqual({ audioRequired: true, speakerId: 'narrator', spokenText: null });
  });

  it('文档损坏或缺节—返回 null（调用方按稳定路径处理）', () => {
    expect(extractVoiceShotFields('not-json')).toBeNull();
    expect(extractVoiceShotFields(JSON.stringify({ content: {} }))).toBeNull();
  });

  it('generationInputHash—确定性且四要素任一漂移即变化（版本行参与=改版本即 STALE）', () => {
    const base = {
      modelId: 'qwen3-tts-instruct-flash',
      shotVersionId: 'shotv_00000001',
      spokenTextSha256: 'a'.repeat(64),
      voiceId: 'Neil',
    };
    const first = computeVoiceGenerationInputHash(base, hashPayload);
    expect(computeVoiceGenerationInputHash(base, hashPayload)).toBe(first);
    expect(
      computeVoiceGenerationInputHash({ ...base, modelId: 'qwen3-tts-instruct' }, hashPayload),
    ).not.toBe(first);
    expect(
      computeVoiceGenerationInputHash({ ...base, shotVersionId: 'shotv_00000002' }, hashPayload),
    ).not.toBe(first);
    expect(
      computeVoiceGenerationInputHash({ ...base, spokenTextSha256: 'b'.repeat(64) }, hashPayload),
    ).not.toBe(first);
    expect(computeVoiceGenerationInputHash({ ...base, voiceId: 'Elias' }, hashPayload)).not.toBe(
      first,
    );
  });
});
