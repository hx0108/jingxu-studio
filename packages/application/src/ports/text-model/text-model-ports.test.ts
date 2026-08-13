import { describe, expectTypeOf, it } from 'vitest';

import type { TextModelPort } from './text-model-port';
import type {
  CredentialCheck,
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
} from './text-model-types';

describe('TextModel Application Ports', () => {
  it('公开边界—Port 签名屏蔽 Provider 专有结构（TECH_DESIGN v1.1 §6.1）', () => {
    expectTypeOf<TextModelPort>().toHaveProperty('validateCredential');
    expectTypeOf<TextModelPort>().toHaveProperty('generate');
    expectTypeOf<TextModelPort>().toHaveProperty('normalizeError');
  });

  it('生成请求/结果—只含归一化字段与可空用量', () => {
    expectTypeOf<TextGenerationRequest>().toHaveProperty('candidateSchemaId');
    expectTypeOf<TextGenerationRequest>().toHaveProperty('finalSchemaId');
    expectTypeOf<TextGenerationRequest>().toHaveProperty('stage');
    expectTypeOf<TextGenerationResult>().toHaveProperty('rawText');
    expectTypeOf<TextGenerationResult>().toHaveProperty('usage');
    expectTypeOf<TextGenerationResult>().toHaveProperty('providerRequestId');
  });

  it('归一化错误—稳定 code 与 retryable，不含 Key/Auth 字段', () => {
    expectTypeOf<NormalizedModelError>().toHaveProperty('code');
    expectTypeOf<NormalizedModelError>().toHaveProperty('retryable');
    expectTypeOf<NormalizedModelError>().not.toHaveProperty('authorization');
    expectTypeOf<NormalizedModelError>().not.toHaveProperty('apiKey');
  });

  it('凭据检查—判别联合 ok', () => {
    expectTypeOf<CredentialCheck>().toExtend<{ readonly ok: boolean }>();
  });
});
