import { afterEach, describe, expect, it } from 'vitest';

import { parseE2eVideoSteps, VIDEO_CANDIDATE_COUNT } from './register-video-features';

const setSteps = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.JINGXU_E2E_VIDEO_STEPS;
  } else {
    process.env.JINGXU_E2E_VIDEO_STEPS = value;
  }
};

describe('parseE2eVideoSteps', () => {
  afterEach(() => {
    setSteps(undefined);
  });

  it('缺省预算熔断—2 候选 × 单批 20 镜头全 ASYNC 即成', () => {
    setSteps(undefined);
    const steps = parseE2eVideoSteps();
    expect(steps).toHaveLength(VIDEO_CANDIDATE_COUNT * 20);
    expect(steps.every((step) => step.kind === 'ASYNC')).toBe(true);
    setSteps('   ');
    expect(parseE2eVideoSteps()).toHaveLength(40);
  });

  it('令牌矩阵—A/P 轮询窗口/D 慢异步/组合/E 失败/T 超时', () => {
    setSteps('A, A:P3 ,A:D800,A:D800:P2,E:MODEL_RATE_LIMITED,T:1500');
    const steps = parseE2eVideoSteps();
    expect(steps.slice(0, 4)).toEqual([
      { kind: 'ASYNC' },
      { kind: 'ASYNC', pendingPolls: 3 },
      { afterMs: 800, kind: 'ASYNC' },
      { afterMs: 800, kind: 'ASYNC', pendingPolls: 2 },
    ]);
    expect(steps[4]?.kind).toBe('ERROR');
    expect(steps[4]?.kind === 'ERROR' && steps[4].error.code).toBe('MODEL_RATE_LIMITED');
    expect(steps[5]).toEqual({ afterMs: 1500, kind: 'TIMEOUT' });
  });

  it('非法令牌启动期即抛—失败要响不带病运行', () => {
    for (const invalid of ['S', 'A:X3', 'A:P', 'E:lower_case', 'T', 'A::P1', 'X:1']) {
      setSteps(invalid);
      expect(() => parseE2eVideoSteps()).toThrow(
        'JINGXU_E2E_VIDEO_STEPS_INVALID_TOKEN',
      );
    }
  });
});
