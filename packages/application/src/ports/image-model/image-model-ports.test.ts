import { describe, expectTypeOf, it } from 'vitest';

import type { ImageModelPort } from './image-model-port';
import type {
  ImageGenerationRequest,
  ImageGenerationUsage,
  ImageResultRef,
  ImageTaskStatus,
  ImageTaskSubmission,
} from './image-model-types';

describe('ImageModel Application Ports', () => {
  it('公开边界—Port 三段原语 + 凭据与归一化（design D2）', () => {
    expectTypeOf<ImageModelPort>().toHaveProperty('validateCredential');
    expectTypeOf<ImageModelPort>().toHaveProperty('submit');
    expectTypeOf<ImageModelPort>().toHaveProperty('poll');
    expectTypeOf<ImageModelPort>().toHaveProperty('download');
    expectTypeOf<ImageModelPort>().toHaveProperty('normalizeError');
  });

  it('submit 返回—容忍同步终态引用与异步任务句柄两种形态', () => {
    expectTypeOf<ImageTaskSubmission['kind']>().toEqualTypeOf<'SYNC' | 'ASYNC'>();
    expectTypeOf<Extract<ImageTaskSubmission, { kind: 'SYNC' }>>().toExtend<
      Readonly<{ result: ImageResultRef; usage: ImageGenerationUsage }>
    >();
    expectTypeOf<Extract<ImageTaskSubmission, { kind: 'ASYNC' }>>().toExtend<
      Readonly<{ providerTaskId: string }>
    >();
  });

  it('生成请求—只含归一化字段，无 Provider 专有参数名', () => {
    expectTypeOf<ImageGenerationRequest>().toHaveProperty('prompt');
    expectTypeOf<ImageGenerationRequest>().toHaveProperty('size');
    expectTypeOf<ImageGenerationRequest>().toHaveProperty('referenceImages');
    expectTypeOf<ImageGenerationRequest>().not.toHaveProperty('seed');
    expectTypeOf<ImageGenerationRequest>().not.toHaveProperty('guidanceScale');
    expectTypeOf<ImageGenerationRequest>().not.toHaveProperty('sequentialImageGeneration');
  });

  it('任务状态—PENDING/SUCCEEDED/FAILED 判别联合', () => {
    expectTypeOf<ImageTaskStatus['state']>().toEqualTypeOf<'PENDING' | 'SUCCEEDED' | 'FAILED'>();
    expectTypeOf<Extract<ImageTaskStatus, { state: 'SUCCEEDED' }>>().toExtend<
      Readonly<{ result: ImageResultRef; usage: ImageGenerationUsage }>
    >();
    expectTypeOf<Extract<ImageTaskStatus, { state: 'FAILED' }>>().toExtend<
      Readonly<{ detail: string | null; errorCode: string }>
    >();
  });

  it('结果引用—url 可持久化但不含凭据字段', () => {
    expectTypeOf<ImageResultRef>().toHaveProperty('url');
    expectTypeOf<ImageResultRef>().not.toHaveProperty('apiKey');
    expectTypeOf<ImageResultRef>().not.toHaveProperty('authorization');
  });
});
