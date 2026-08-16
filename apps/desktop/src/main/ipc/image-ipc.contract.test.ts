import { describe, expect, it, vi } from 'vitest';

import { IMAGE_IPC_CHANNELS } from '@jingxu/contracts';
import type {
  AppResultDto,
  AssetVersionViewDto,
  AssetViewDto,
  ImageCandidateViewDto,
  MediaTaskViewDto,
  UploadAssetReferenceResultDto,
} from '@jingxu/contracts';
import type { ImageIpcService } from './image-ipc';
import { registerImageIpc } from './image-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

/** 合法 64 位十六进制（契约 hashSchema 只认 [a-f0-9]{64}）。 */
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);
const NOW = '2026-08-16T00:00:00.000Z';

const task: MediaTaskViewDto = {
  candidateCount: 4,
  createdAt: NOW,
  errorCode: null,
  generationInputHash: hash64('gen'),
  id: 'task_12345678',
  phase: 'SUBMITTED',
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  updatedAt: NOW,
};

const candidate: ImageCandidateViewDto = {
  byteSize: null,
  createdAt: NOW,
  errorCode: null,
  generationInputHash: hash64('gen'),
  height: null,
  id: 'cand_12345678',
  indexInRound: 0,
  mediaUrl: null,
  mimeType: null,
  roundNo: 1,
  selectedAt: null,
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  status: 'PENDING',
  width: null,
};

const assetVersion: AssetVersionViewDto = {
  assetId: 'asset_12345678',
  byteSize: 3,
  createdAt: NOW,
  description: '定妆参考',
  height: null,
  id: 'assetv_12345678',
  mediaUrl: 'jingxu://media/asset-version/assetv_12345678',
  mimeType: 'image/png',
  provenance: 'UPLOADED',
  versionNo: 1,
  width: null,
};

const asset: AssetViewDto = {
  assetType: 'CHARACTER',
  bibleRefId: 'char_12345678',
  createdAt: NOW,
  currentVersion: assetVersion,
  displayName: '少女',
  id: 'asset_12345678',
  projectId: 'project_12345678',
  updatedAt: NOW,
  versions: [assetVersion],
};

const okTask: AppResultDto<MediaTaskViewDto> = { data: task, ok: true };
const okCandidates: AppResultDto<ImageCandidateViewDto[]> = { data: [candidate], ok: true };
const okAssets: AppResultDto<AssetViewDto[]> = { data: [asset], ok: true };
const okUpload: AppResultDto<UploadAssetReferenceResultDto> = {
  data: { affectedShots: [{ candidateCount: 1, shotId: 'shot_12345678' }], version: assetVersion },
  ok: true,
};

const generateInput = {
  projectId: 'project_12345678',
  requestId: 'request_generate_1',
  shotId: 'shot_12345678',
};
const selectInput = {
  candidateId: 'cand_12345678',
  projectId: 'project_12345678',
  requestId: 'request_select_1',
};
const uploadInput = {
  assetType: 'CHARACTER' as const,
  bibleRefId: 'char_12345678',
  byteSize: 3,
  bytes: Uint8Array.from([1, 2, 3]),
  description: '定妆参考',
  displayName: '少女',
  mimeType: 'image/png' as const,
  projectId: 'project_12345678',
  requestId: 'request_upload_1',
};

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: ImageIpcService = {
    generateCandidates: vi.fn(() => Promise.resolve(okTask)),
    getMediaTask: vi.fn(() => Promise.resolve(okTask)),
    listAssets: vi.fn(() => Promise.resolve(okAssets)),
    listCandidates: vi.fn(() => Promise.resolve(okCandidates)),
    selectCandidate: vi.fn(() => Promise.resolve(okCandidates)),
    uploadAssetReference: vi.fn(() => Promise.resolve(okUpload)),
  };
  registerImageIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    { newTraceId: () => 'trace_image_12345678' },
  );
  return { handlers, service };
};

describe('Image Main IPC Contract', () => {
  it('注册边界—固定六方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IMAGE_IPC_CHANNELS).sort());

    await expect(
      handlers.get(IMAGE_IPC_CHANNELS.generateCandidates)?.(trustedEvent(), generateInput),
    ).resolves.toEqual(okTask);
    await expect(
      handlers.get(IMAGE_IPC_CHANNELS.listCandidates)?.(trustedEvent(), {
        projectId: 'project_12345678',
        shotId: 'shot_12345678',
      }),
    ).resolves.toEqual(okCandidates);
    expect(service.generateCandidates).toHaveBeenCalledWith(generateInput, 'trace_image_12345678');
  });

  it('非 READY—六方法（含只读查询）统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    const inputs: readonly [string, unknown][] = [
      [IMAGE_IPC_CHANNELS.generateCandidates, generateInput],
      [IMAGE_IPC_CHANNELS.selectCandidate, selectInput],
      [IMAGE_IPC_CHANNELS.uploadAssetReference, uploadInput],
      [
        IMAGE_IPC_CHANNELS.listCandidates,
        { projectId: 'project_12345678', shotId: 'shot_12345678' },
      ],
      [IMAGE_IPC_CHANNELS.listAssets, { projectId: 'project_12345678' }],
      [IMAGE_IPC_CHANNELS.getTask, { projectId: 'project_12345678', taskId: 'task_12345678' }],
    ];
    for (const [channel, input] of inputs) {
      await expect(handlers.get(channel)?.(trustedEvent(), input)).resolves.toMatchObject({
        error: { code: 'STARTUP_WRITE_BLOCKED' },
        ok: false,
      });
    }
    expect(service.generateCandidates).not.toHaveBeenCalled();
    expect(service.listCandidates).not.toHaveBeenCalled();
    expect(service.getMediaTask).not.toHaveBeenCalled();
  });

  it('未知字段、额外参数与超限字节—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const handle = handlers.get(IMAGE_IPC_CHANNELS.uploadAssetReference);
    await expect(
      handle?.(trustedEvent(), { ...uploadInput, sql: 'SELECT secret' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(handle?.(trustedEvent(), uploadInput, 'extra')).resolves.toMatchObject({
      error: { code: 'IPC_INVALID_REQUEST' },
    });
    // 字节缓冲上限：byteSize 超 20MB 契约上限直接拒绝，不经由 Service。
    await expect(
      handle?.(trustedEvent(), { ...uploadInput, byteSize: 21 * 1024 * 1024 }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handle?.(trustedEvent(), { ...uploadInput, mimeType: 'image/bmp' }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.uploadAssetReference).not.toHaveBeenCalled();
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    expect(() =>
      handlers.get(IMAGE_IPC_CHANNELS.listAssets)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        { projectId: 'project_12345678' },
      ),
    ).toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.listAssets).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令（含上传字节）—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<UploadAssetReferenceResultDto>) => void) | undefined;
    vi.mocked(service.uploadAssetReference).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(IMAGE_IPC_CHANNELS.uploadAssetReference);
    const first = handle?.(trustedEvent(), uploadInput);
    const second = handle?.(trustedEvent(), uploadInput);
    await vi.waitFor(() => {
      expect(service.uploadAssetReference).toHaveBeenCalledOnce();
    });
    finish?.(okUpload);
    await expect(Promise.all([first, second])).resolves.toEqual([okUpload, okUpload]);
    expect(service.uploadAssetReference).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发不同命令—返回 REQUEST_ID_REUSED—不执行第二次写入', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<MediaTaskViewDto>) => void) | undefined;
    vi.mocked(service.generateCandidates).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = handlers.get(IMAGE_IPC_CHANNELS.generateCandidates)?.(
      trustedEvent(),
      generateInput,
    );
    await vi.waitFor(() => {
      expect(service.generateCandidates).toHaveBeenCalledOnce();
    });
    await expect(
      handlers.get(IMAGE_IPC_CHANNELS.selectCandidate)?.(trustedEvent(), {
        ...selectInput,
        requestId: generateInput.requestId,
      }),
    ).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    finish?.(okTask);
    await first;
    expect(service.selectCandidate).not.toHaveBeenCalled();
  });

  it('Service throw 或畸形输出—统一脱敏错误—零路径、SQL、原文、Key、响应泄漏', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.getMediaTask).mockRejectedValue(
      new Error('C:\\Users\\secret SELECT * apiKey=sk-secret raw response prompt 原文'),
    );
    const result = await handlers.get(IMAGE_IPC_CHANNELS.getTask)?.(trustedEvent(), {
      projectId: 'project_12345678',
      taskId: 'task_12345678',
    });
    expect(result).toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
    const serialized = JSON.stringify(result);
    for (const secret of ['C:\\', 'SELECT', 'sk-secret', 'raw response', '原文']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('输出越权字段（候选携带绝对路径/mediaUrl 越前缀）—schema 拒绝为脱敏失败', async () => {
    const { handlers, service } = createHarness();
    vi.mocked(service.listCandidates).mockResolvedValue({
      data: [
        {
          ...candidate,
          mediaUrl: 'file:///C:/Users/secret/leak.png',
          status: 'SUCCEEDED',
        },
      ],
      ok: true,
    });
    await expect(
      handlers.get(IMAGE_IPC_CHANNELS.listCandidates)?.(trustedEvent(), {
        projectId: 'project_12345678',
        shotId: 'shot_12345678',
      }),
    ).resolves.toMatchObject({ error: { code: 'PROJECT_PERSISTENCE_FAILED' }, ok: false });
  });
});
