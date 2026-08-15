import type { TextGenerationRequest } from '../ports/text-model/index';
import type { ScriptStageJob } from '../ports/persistence/job/index';
import type { JobStructureRepairRequest } from '../jobs/index';

export interface ScriptPromptSnapshot {
  readonly candidateSchemaId: string;
  readonly promptTemplateId: string;
  readonly systemPrompt: string;
  readonly userPayload: unknown;
}

export interface ScriptJobRequestDependencies {
  /** 五阶段为 ScriptStageOutput；SHOT_CONTRACT 为逐镜头 ShotContract（组合根映射）。 */
  readonly finalSchemaId: (stage: ScriptStageJob['stage']) => string;
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
    const prompt = await dependencies.loadPromptSnapshot(job);
    if (prompt.promptTemplateId !== job.promptTemplateId) throw new Error('STALE_INPUT');
    return {
      candidateSchemaId: prompt.candidateSchemaId,
      finalSchemaId: dependencies.finalSchemaId(job.stage),
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
      stage: job.stage,
      systemPrompt: prompt.systemPrompt,
      // STRUCTURE_REPAIR 必须改变消息内容，否则修复重试等于原样重发。
      // 适配器只消费 systemPrompt + userPayload（parameters 仅采样参数），
      // 因此修复上下文在 builder 层进入 userPayload；parameters.repair 仅作审计留痕。
      userPayload:
        repair === undefined
          ? prompt.userPayload
          : Object.freeze({
              originalRequest: prompt.userPayload,
              repair: Object.freeze({
                previousFailure: repair.failure,
                previousOutput: repair.rawText,
                instruction:
                  '上一次输出未通过系统校验。请依据 system prompt 的原始要求与 originalRequest，' +
                  '针对 previousFailure 指出的失败原因重新生成完整结果；不要返回修补说明或差异，' +
                  '直接返回符合要求格式的完整 JSON 对象。',
              }),
            }),
    };
  };
