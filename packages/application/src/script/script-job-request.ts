import type { TextGenerationRequest } from '../ports/text-model/index';
import type { ScriptStageJob } from '../ports/persistence/job/index';
import type { JobStructureRepairRequest } from '../jobs/index';
import type { StagedScriptStage } from '../ports/script/index';

export interface ScriptPromptSnapshot {
  readonly candidateSchemaId: string;
  readonly promptTemplateId: string;
  readonly systemPrompt: string;
  readonly userPayload: unknown;
}

export interface ScriptJobRequestDependencies {
  readonly finalSchemaId: string;
  readonly loadPromptSnapshot: (job: ScriptStageJob) => Promise<ScriptPromptSnapshot>;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Resolves immutable input versions by id outside the Provider transaction and builds its request. */
export const createScriptJobRequestBuilder =
  (dependencies: ScriptJobRequestDependencies) =>
  async (
    job: ScriptStageJob,
    invocationId: string,
    repair?: JobStructureRepairRequest,
  ): Promise<TextGenerationRequest> => {
    if (job.stage === 'SHOT_CONTRACT') throw new Error('SCRIPT_STAGE_UNSUPPORTED');
    const prompt = await dependencies.loadPromptSnapshot(job);
    if (prompt.promptTemplateId !== job.promptTemplateId) throw new Error('STALE_INPUT');
    return {
      candidateSchemaId: prompt.candidateSchemaId,
      finalSchemaId: dependencies.finalSchemaId,
      invocationId,
      parameters:
        repair === undefined
          ? dependencies.parameters
          : Object.freeze({
              ...dependencies.parameters,
              repair: Object.freeze({
                failure: repair.failure,
                rawText: repair.rawText,
              }),
            }),
      promptTemplateVersion: prompt.promptTemplateId,
      stage: job.stage as StagedScriptStage,
      systemPrompt: prompt.systemPrompt,
      userPayload: prompt.userPayload,
    };
  };
