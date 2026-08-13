import { describe, expect, it, vi } from 'vitest';

import type { ScriptStageJob } from '../ports/persistence/job/index';
import { createScriptJobRequestBuilder } from './script-job-request';

const job = {
  id: 'job-00000001',
  promptTemplateId: 'concept/v1',
  stage: 'CONCEPT',
} as ScriptStageJob;

describe('Script job request builder', () => {
  it('条件—冻结版本可按 ID 解析—在 Provider 调用前构造正式 request', async () => {
    const loadPromptSnapshot = vi.fn(() =>
      Promise.resolve({
        candidateSchemaId: 'candidate/concept/v1',
        promptTemplateId: 'concept/v1',
        systemPrompt: '只返回 JSON',
        userPayload: { material: 'frozen-input' },
      }),
    );
    const build = createScriptJobRequestBuilder({
      finalSchemaId: 'script-stage-output/1.0.0',
      loadPromptSnapshot,
      parameters: { temperature: 0.2 },
    });

    await expect(build(job, 'invocation-0001')).resolves.toMatchObject({
      invocationId: 'invocation-0001',
      promptTemplateVersion: 'concept/v1',
      stage: 'CONCEPT',
      userPayload: { material: 'frozen-input' },
    });
    expect(loadPromptSnapshot).toHaveBeenCalledWith(job);
  });

  it('条件—Prompt 版本与 Job 冻结值漂移—Provider 调用前返回 STALE_INPUT', async () => {
    const build = createScriptJobRequestBuilder({
      finalSchemaId: 'script-stage-output/1.0.0',
      loadPromptSnapshot: () =>
        Promise.resolve({
          candidateSchemaId: 'candidate/concept/v2',
          promptTemplateId: 'concept/v2',
          systemPrompt: 'new',
          userPayload: {},
        }),
      parameters: {},
    });

    await expect(build(job, 'invocation-0001')).rejects.toThrow('STALE_INPUT');
  });
});
