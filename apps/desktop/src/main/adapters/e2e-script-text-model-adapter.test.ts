import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TextGenerationRequest } from '@jingxu/application';
import { V1_SCHEMA_LOCKS } from '@jingxu/validation';
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
});
