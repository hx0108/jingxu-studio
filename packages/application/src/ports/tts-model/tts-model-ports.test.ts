import { describe, expectTypeOf, it } from 'vitest';

import type { TtsModelPort } from './tts-model-port';
import type { TtsSynthesisRequest, TtsSynthesisResult } from './tts-model-types';

describe('TtsModel Application Ports', () => {
  it('公开边界—同步单段原语 + 凭据与归一化（design D2）', () => {
    expectTypeOf<TtsModelPort>().toHaveProperty('validateCredential');
    expectTypeOf<TtsModelPort>().toHaveProperty('synthesize');
    expectTypeOf<TtsModelPort>().toHaveProperty('normalizeError');
    expectTypeOf<TtsModelPort>().toHaveProperty('evidenceOf');
    // 同步形态刻意不存在三段式原语：无 poll/download 即无伪造任务语义。
    expectTypeOf<TtsModelPort>().not.toHaveProperty('submit');
    expectTypeOf<TtsModelPort>().not.toHaveProperty('poll');
    expectTypeOf<TtsModelPort>().not.toHaveProperty('download');
  });

  it('合成请求—只含归一化字段，无 Provider 专有参数名', () => {
    expectTypeOf<TtsSynthesisRequest>().toHaveProperty('spokenText');
    expectTypeOf<TtsSynthesisRequest>().toHaveProperty('voiceId');
    expectTypeOf<TtsSynthesisRequest>().toHaveProperty('modelId');
    expectTypeOf<TtsSynthesisRequest>().not.toHaveProperty('voiceType');
    expectTypeOf<TtsSynthesisRequest>().not.toHaveProperty('encoding');
    expectTypeOf<TtsSynthesisRequest>().not.toHaveProperty('apiKey');
  });

  it('合成结果—不携带 Provider 自报时长（时长以落库段 ffprobe 实测为准）', () => {
    // 对齐记录（§5.2）的音频时长输入必须来自 ffprobe 实测；若此处出现
    // durationMs，业务层就可能绕过实测直取 Provider 自报——政策上禁止。
    expectTypeOf<TtsSynthesisResult>().not.toHaveProperty('durationMs');
    expectTypeOf<TtsSynthesisResult>().toHaveProperty('audio');
    expectTypeOf<TtsSynthesisResult>().toHaveProperty('httpStatus');
  });

  it('合成结果与音频载荷—不含凭据或文件系统路径字段', () => {
    expectTypeOf<TtsSynthesisResult>().not.toHaveProperty('apiKey');
    expectTypeOf<TtsSynthesisResult>().not.toHaveProperty('authorization');
    expectTypeOf<TtsSynthesisResult>().not.toHaveProperty('filePath');
  });
});
