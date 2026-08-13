import { describe, expect, it, vi } from 'vitest';

import type { ScriptStageJob } from '../ports/persistence/job/index';
import { buildScriptCandidateContract } from './script-job-contract';

describe('buildScriptCandidateContract', () => {
  it('条件—模型候选含伪造系统字段—只保留 data 并注入受信元数据', () => {
    const validateCandidate = vi.fn(() => ({ valid: true as const }));
    const validateFinal = vi.fn(() => ({ valid: true as const }));
    const job = {
      episodeId: 'episode-0001',
      projectId: 'project-0001',
      stage: 'SCENE_SCRIPT',
    } as ScriptStageJob;
    const contract = buildScriptCandidateContract(job, 'invocation-0001', {
      validateCandidate,
      validateFinal,
    });
    const candidate = {
      data: { scenes: [] },
      project_id: 'forged-project',
      schema_version: 'forged',
      source_invocation_id: 'forged-invocation',
    };

    expect(contract.validateCandidate(candidate)).toEqual({ valid: true });
    const finalValue = contract.injectSystemFields(candidate);
    expect(finalValue).toEqual({
      data: candidate.data,
      episode_id: 'episode-0001',
      project_id: 'project-0001',
      schema_version: '1.0.0',
      source_invocation_id: 'invocation-0001',
      stage: 'SCENE_SCRIPT',
    });
    expect(contract.validateFinal(finalValue)).toEqual({ valid: true });
    expect(validateCandidate).toHaveBeenCalledWith(candidate);
    expect(validateFinal).toHaveBeenCalledWith(finalValue);
  });

  it('条件—候选没有 data 根—系统字段注入稳定失败且不调用正式 validator', () => {
    const validateFinal = vi.fn(() => ({ valid: true as const }));
    const contract = buildScriptCandidateContract(
      { episodeId: null, projectId: 'project-0001', stage: 'CONCEPT' } as ScriptStageJob,
      'invocation-0001',
      { validateCandidate: () => ({ valid: true }), validateFinal },
    );

    expect(() => contract.injectSystemFields({ title: 'missing data' })).toThrow(
      'SYSTEM_FIELD_INJECTION_FAILED',
    );
    expect(validateFinal).not.toHaveBeenCalled();
  });
});
