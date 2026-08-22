import { describe, expect, it, vi } from 'vitest';

import { EVALUATION_IPC_CHANNELS } from '@jingxu/contracts';
import type {
  AppResultDto,
  EvaluationAddAnnotationResultDto,
  EvaluationCreateFromEpisodeResultDto,
  EvaluationImportBatchResultDto,
  EvaluationListSamplesResultDto,
  EvaluationSampleDetailDto,
  EvaluationSampleSummaryDto,
} from '@jingxu/contracts';
import type { EvaluationIpcService } from './evaluation-ipc';
import { registerEvaluationIpc } from './evaluation-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const summary: EvaluationSampleSummaryDto = {
  acceptable: true,
  authorization: 'SYNTHETIC',
  createdAt: '2026-08-22T00:00:00.000Z',
  datasetSplit: 'TRAIN',
  dedupKey: 'ut-shot-0001',
  hitCodes: [],
  latestAnnotation: null,
  projectId: null,
  sampleId: 'eval_ut00000001',
  sampleType: 'SHOT_CONTRACT',
};

const detail: EvaluationSampleDetailDto = {
  ...summary,
  annotations: [],
  expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
  hits: [],
  input: {
    candidate: { document: {}, kind: 'SHOT_CONTRACT' },
    context: {},
  },
  ruleVersion: 'jingxu-producibility-rules/1',
};

const okList: AppResultDto<EvaluationListSamplesResultDto> = {
  data: { samples: [] },
  ok: true,
};
const okDetail: AppResultDto<EvaluationSampleDetailDto> = { data: detail, ok: true };
const okCreate: AppResultDto<EvaluationSampleSummaryDto> = { data: summary, ok: true };
const okDerive: AppResultDto<EvaluationCreateFromEpisodeResultDto> = {
  data: { samples: [] },
  ok: true,
};
const okImport: AppResultDto<EvaluationImportBatchResultDto> = { data: { items: [] }, ok: true };
const okDelete: AppResultDto<{ deletedAnnotations: number; sampleId: string }> = {
  data: { deletedAnnotations: 2, sampleId: 'eval_ut00000001' },
  ok: true,
};
const okAnnotate: AppResultDto<EvaluationAddAnnotationResultDto> = {
  data: { annotations: [] },
  ok: true,
};

const inputs = {
  listSamples: { scope: 'ALL' },
  getSample: { sampleId: 'eval_ut00000001' },
  createSample: {
    authorization: 'SYNTHETIC',
    datasetSplit: 'TRAIN',
    dedupKey: 'ut-shot-0001',
    expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
    input: {
      candidate: { document: {}, kind: 'SHOT_CONTRACT' },
      context: {},
    },
    projectId: null,
  },
  createFromEpisode: {
    authorization: 'SYNTHETIC',
    datasetSplit: 'TRAIN',
    expectedVersionId: 'ev_1234567890',
    projectId: 'project_12345678',
    requestId: 'request_derive_1',
    shotIndexes: null,
  },
  importBatch: { requestId: 'request_import_1' },
  deleteSample: { requestId: 'request_delete_1', sampleId: 'eval_ut00000001' },
  addAnnotation: {
    annotator: '贺星',
    guidelineVersion: 'jingxu-annotation-guideline/1',
    label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
    rationale: '符合指南 v1 的可接受样本',
    requestId: 'request_anno_1',
    sampleId: 'eval_ut00000001',
  },
} as const;

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: EvaluationIpcService = {
    addAnnotation: vi.fn(() => Promise.resolve(okAnnotate)),
    createFromEpisode: vi.fn(() => Promise.resolve(okDerive)),
    createSample: vi.fn(() => Promise.resolve(okCreate)),
    deleteSample: vi.fn(() => Promise.resolve(okDelete)),
    getSample: vi.fn(() => Promise.resolve(okDetail)),
    importBatch: vi.fn(() => Promise.resolve(okImport)),
    listSamples: vi.fn(() => Promise.resolve(okList)),
  };
  registerEvaluationIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    () => 'trace_eval_1234',
  );
  return { handlers, service };
};

describe('Evaluation Main IPC Contract（storyboard-evaluation-set 4.1）', () => {
  it('注册边界—固定七方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(EVALUATION_IPC_CHANNELS).sort());

    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.listSamples)?.(trustedEvent(), inputs.listSamples),
    ).resolves.toEqual(okList);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.getSample)?.(trustedEvent(), inputs.getSample),
    ).resolves.toEqual(okDetail);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.createSample)?.(trustedEvent(), inputs.createSample),
    ).resolves.toEqual(okCreate);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.createFromEpisode)?.(
        trustedEvent(),
        inputs.createFromEpisode,
      ),
    ).resolves.toEqual(okDerive);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.importBatch)?.(trustedEvent(), inputs.importBatch),
    ).resolves.toEqual(okImport);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.deleteSample)?.(trustedEvent(), inputs.deleteSample),
    ).resolves.toEqual(okDelete);
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.addAnnotation)?.(trustedEvent(), inputs.addAnnotation),
    ).resolves.toEqual(okAnnotate);
    for (const [method, input] of Object.entries(inputs)) {
      expect(service[method as keyof EvaluationIpcService]).toHaveBeenCalledWith(
        input,
        'trace_eval_1234',
      );
    }
  });

  it('非 READY—七个方法统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    for (const [method, input] of Object.entries(inputs)) {
      await expect(
        handlers.get(EVALUATION_IPC_CHANNELS[method as keyof typeof EVALUATION_IPC_CHANNELS])?.(
          trustedEvent(),
          input,
        ),
      ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
    }
    for (const spy of Object.values(service)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('未知字段、额外参数与非法枚举—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.listSamples)?.(trustedEvent(), {
        ...inputs.listSamples,
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.getSample)?.(trustedEvent(), inputs.getSample, 'extra'),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.listSamples)?.(trustedEvent(), {
        scope: 'HOLDOUT',
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.deleteSample)?.(trustedEvent(), {
        ...inputs.deleteSample,
        sampleId: '',
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    for (const spy of Object.values(service)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.listSamples)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        inputs.listSamples,
      ),
    ).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.listSamples).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish:
      ((value: AppResultDto<{ deletedAnnotations: number; sampleId: string }>) => void) | undefined;
    vi.mocked(service.deleteSample).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(EVALUATION_IPC_CHANNELS.deleteSample);
    const first = handle?.(trustedEvent(), inputs.deleteSample);
    const second = handle?.(trustedEvent(), inputs.deleteSample);
    await vi.waitFor(() => {
      expect(service.deleteSample).toHaveBeenCalledOnce();
    });
    finish?.(okDelete);
    await expect(Promise.all([first, second])).resolves.toEqual([okDelete, okDelete]);
    expect(service.deleteSample).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发不同命令—返回 REQUEST_ID_REUSED—不执行第二次写入', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<EvaluationImportBatchResultDto>) => void) | undefined;
    vi.mocked(service.importBatch).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = handlers.get(EVALUATION_IPC_CHANNELS.importBatch)?.(
      trustedEvent(),
      inputs.importBatch,
    );
    await vi.waitFor(() => {
      expect(service.importBatch).toHaveBeenCalledOnce();
    });
    const conflict = { ...inputs.deleteSample, requestId: inputs.importBatch.requestId };
    await expect(
      handlers.get(EVALUATION_IPC_CHANNELS.deleteSample)?.(trustedEvent(), conflict),
    ).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    finish?.(okImport);
    await first;
    expect(service.deleteSample).not.toHaveBeenCalled();
  });

  it('Service throw 或畸形输出—统一脱敏错误—零路径、SQL、原文泄漏', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.importBatch).mockRejectedValue(
      new Error('C:\\Users\\secret SELECT * evaluation_samples raw'),
    );
    vi.mocked(service.listSamples).mockResolvedValue({
      data: { samples: 'not-an-array' },
      ok: true,
    } as unknown as AppResultDto<EvaluationListSamplesResultDto>);
    const thrown = await handlers.get(EVALUATION_IPC_CHANNELS.importBatch)?.(
      trustedEvent(),
      inputs.importBatch,
    );
    expect(thrown).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const malformed = await handlers.get(EVALUATION_IPC_CHANNELS.listSamples)?.(
      trustedEvent(),
      inputs.listSamples,
    );
    expect(malformed).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const serialized = JSON.stringify([thrown, malformed]);
    for (const secret of ['C:\\', 'SELECT', 'evaluation_samples', 'not-an-array']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
