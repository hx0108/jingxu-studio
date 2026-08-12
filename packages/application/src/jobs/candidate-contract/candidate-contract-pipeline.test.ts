import { describe, expect, it, vi } from 'vitest';

import { executeCandidateContract } from './candidate-contract-pipeline';

import type { CandidateContractDependencies } from './candidate-contract-pipeline';

const valid = Object.freeze({ valid: true as const });
const invalid = (code: string) => Object.freeze({ code, valid: false as const });

describe('executeCandidateContract', () => {
  it('固定执行候选 Schema、系统字段注入、正式 Schema、集合校验、提交', async () => {
    const order: string[] = [];
    const dependencies: CandidateContractDependencies = {
      validateCandidate: (value) => {
        order.push('candidate');
        expect(value).toEqual({ data: { title: 'candidate' } });
        return valid;
      },
      injectSystemFields: (value) => {
        order.push('inject');
        return { ...(value as object), project_id: 'project_1', source_invocation_id: 'inv_1' };
      },
      validateFinal: () => {
        order.push('final');
        return valid;
      },
      validateCollection: () => {
        order.push('collection');
        return valid;
      },
      commit: (value) => {
        order.push('commit');
        return Promise.resolve(value);
      },
    };

    await expect(
      executeCandidateContract('{"data":{"title":"candidate"}}', dependencies),
    ).resolves.toMatchObject({ status: 'SUCCEEDED', structureRepairAttempts: 0 });
    expect(order).toEqual(['candidate', 'inject', 'final', 'collection', 'commit']);
  });

  it('候选失败时最多修复一次，并在每次尝试重新生成系统字段', async () => {
    const generatedIds = ['version_fresh_1', 'version_fresh_2'];
    const injectSystemFields = vi.fn((value: unknown) => ({
      ...(value as object),
      version_id: generatedIds.shift() ?? 'version_fallback',
    }));
    const validateCandidate = vi
      .fn<(value: unknown) => ReturnType<typeof invalid> | typeof valid>()
      .mockReturnValueOnce(invalid('CANDIDATE_REQUIRED'))
      .mockReturnValueOnce(valid);
    const repair = vi.fn(() =>
      Promise.resolve('{"data":{"title":"repaired"},"version_id":"malicious"}'),
    );
    const commit = vi.fn((value: unknown) => Promise.resolve(value));

    const result = await executeCandidateContract('{"data":{}}', {
      commit,
      injectSystemFields,
      repair,
      validateCandidate,
      validateCollection: () => valid,
      validateFinal: () => valid,
    });

    expect(result).toMatchObject({ status: 'SUCCEEDED', structureRepairAttempts: 1 });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(injectSystemFields).toHaveBeenCalledTimes(1);
    expect(injectSystemFields).toHaveBeenCalledWith({
      data: { title: 'repaired' },
      version_id: 'malicious',
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ version_id: 'version_fresh_1' }));
  });

  it('第二次结构失败终态 FAILED，且不调用版本提交', async () => {
    const commit = vi.fn();
    const repair = vi.fn(() => Promise.resolve('{"data":{}}'));

    const result = await executeCandidateContract('{', {
      commit,
      injectSystemFields: vi.fn(),
      repair,
      validateCandidate: () => invalid('CANDIDATE_INVALID'),
      validateCollection: () => valid,
      validateFinal: () => valid,
    });

    expect(result).toMatchObject({
      errorCode: 'STRUCTURE_REPAIR_FAILED',
      failure: { code: 'CANDIDATE_INVALID', layer: 'CANDIDATE_SCHEMA' },
      status: 'FAILED',
      structureRepairAttempts: 1,
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['FINAL_SCHEMA', 'FINAL_INVALID'],
    ['COLLECTION', 'COLLECTION_INVALID'],
    ['PRE_COMMIT', 'STALE_INPUT'],
  ] as const)('%s 任一层失败都不提交版本', async (layer, code) => {
    const commit = vi.fn();
    const selectedValidator = () => invalid(code);
    const result = await executeCandidateContract('{"data":{}}', {
      commit,
      injectSystemFields: (value) => value,
      validateCandidate: () => valid,
      validateCollection: layer === 'COLLECTION' ? selectedValidator : () => valid,
      validateFinal: layer === 'FINAL_SCHEMA' ? selectedValidator : () => valid,
      ...(layer === 'PRE_COMMIT' ? { validatePreCommit: selectedValidator } : {}),
    });

    expect(result).toMatchObject({ failure: { layer }, status: 'FAILED' });
    expect(commit).not.toHaveBeenCalled();
  });
});
