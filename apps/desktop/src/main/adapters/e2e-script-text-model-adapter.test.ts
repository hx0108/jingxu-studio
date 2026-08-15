import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TextGenerationRequest } from '@jingxu/application';
import { injectShotSystemFields, validateShotSetCollection } from '@jingxu/application';
import { V1_SCHEMA_IDS, V1_SCHEMA_LOCKS, validateModelShotSetCandidate } from '@jingxu/validation';
import { describe, expect, it } from 'vitest';

import { SchemaRegistryAdapter } from './schema-registry-adapter';
import { E2eScriptTextModelAdapter } from './e2e-script-text-model-adapter';

const schemaRoot = path.resolve(
  import.meta.dirname,
  '../../../../../packages/validation/resources/schemas/v1',
);
const schemaId = 'https://jingxu.studio/schemas/script-stage-output/1.0.0';
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;

describe('E2eScriptTextModelAdapter', () => {
  it.each(stages)(
    '条件—%s Mock 候选注入受信字段—通过正式 ScriptStageOutput Schema',
    async (stage) => {
      const registryAdapter = new SchemaRegistryAdapter();
      const resources = await Promise.all(
        V1_SCHEMA_LOCKS.map(async (lock) => ({
          bytes: Array.from(await readFile(path.join(schemaRoot, lock.resourceName))),
          resourceName: lock.resourceName,
        })),
      );
      const registry = await registryAdapter.verifyAndCompile(V1_SCHEMA_LOCKS, resources);
      const request: TextGenerationRequest = {
        candidateSchemaId: `candidate-${stage}`,
        finalSchemaId: schemaId,
        invocationId: 'invocation_e2e_1',
        parameters: {},
        promptTemplateVersion: `${stage.toLowerCase()}/v1`,
        stage,
        systemPrompt: 'system',
        userPayload: {},
      };
      const response = await new E2eScriptTextModelAdapter().generate(
        request,
        new AbortController().signal,
      );
      const candidate = JSON.parse(response.rawText) as Readonly<{ data: unknown }>;
      const result = registry.validate(schemaId, {
        data: candidate.data,
        episode_id: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : 'episode_e2e_1',
        project_id: 'project_e2e_1',
        schema_version: '1.0.0',
        source_invocation_id: request.invocationId,
        stage,
      });

      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it('条件—SHOT_CONTRACT Mock 可重复输出—候选契约→注入→逐镜头 ShotContract→集合校验全通过', async () => {
    const registryAdapter = new SchemaRegistryAdapter();
    const resources = await Promise.all(
      V1_SCHEMA_LOCKS.map(async (lock) => ({
        bytes: Array.from(await readFile(path.join(schemaRoot, lock.resourceName))),
        resourceName: lock.resourceName,
      })),
    );
    const registry = await registryAdapter.verifyAndCompile(V1_SCHEMA_LOCKS, resources);
    const request: TextGenerationRequest = {
      candidateSchemaId: 'candidate-shot-set',
      finalSchemaId: V1_SCHEMA_IDS.shotContract,
      invocationId: 'invocation_e2e_shot_1',
      parameters: {},
      promptTemplateVersion: 'shot-contract/v1',
      stage: 'SHOT_CONTRACT',
      systemPrompt: 'system',
      userPayload: {},
    };
    const adapter = new E2eScriptTextModelAdapter();
    const first = await adapter.generate(request, new AbortController().signal);
    const second = await adapter.generate(request, new AbortController().signal);
    // 可重复输出：同一请求两次调用逐字节一致（E2E 断言依赖确定性）。
    expect(second.rawText).toBe(first.rawText);

    const candidate: unknown = JSON.parse(first.rawText);
    expect(validateModelShotSetCandidate(candidate)).toEqual({ errorCode: null, ok: true });

    const injected = injectShotSystemFields(candidate, {
      formatProfileId: 'format_e2e_1',
      invocationId: request.invocationId,
      newShotId: (index) => `shot_e2e_${String(index + 1)}`,
      newVersionId: (index) => `scv_e2e_${String(index + 1)}_v1`,
    });
    expect(injected).toHaveLength(6);
    // 与 E2E EPISODE_OUTLINE 的 target_duration_sec=90 对齐（每镜 15s，1..20 内）。
    const durations = injected.map((shot) => shot.target_duration_sec);
    expect(durations.every((duration) => duration === 15)).toBe(true);
    for (const shot of injected) {
      const result = registry.validate(V1_SCHEMA_IDS.shotContract, shot);
      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    }
    // 集合校验：E2E STORY_BIBLE 的 char_/scene_ 键集合。
    expect(
      validateShotSetCollection(injected, {
        characterIds: ['char_lead'],
        sceneIds: ['scene_train'],
      }),
    ).toEqual({ valid: true });
  });
});
