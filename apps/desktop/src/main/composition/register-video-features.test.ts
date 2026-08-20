import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  InMemoryMediaInvocationRepository,
  InMemoryMediaRepository,
  InMemoryVideoMediaRepository,
} from '@jingxu/application';
import type { MediaRepositories } from '@jingxu/application';
import { createContentAddressedStore } from '@jingxu/persistence';
import { VIDEO_IPC_CHANNELS } from '@jingxu/contracts';
import type { IpcEvent } from '../ipc/ipc-boundary';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import {
  createVideoFeatureRegistration,
  parseE2eVideoSteps,
  VIDEO_CANDIDATE_COUNT,
} from './register-video-features';

const NOW = '2026-08-16T00:00:00.000Z';
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);

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

  it('缺省预算熔断—2 候选 × 单批 20 镜头全 ASYNC 默认轮询窗口', () => {
    setSteps(undefined);
    const steps = parseE2eVideoSteps();
    expect(steps).toHaveLength(VIDEO_CANDIDATE_COUNT * 20);
    expect(steps.every((step) => step.kind === 'ASYNC' && step.pendingPolls === 2)).toBe(true);
    setSteps('   ');
    expect(parseE2eVideoSteps()).toHaveLength(40);
  });

  it('令牌矩阵—A 默认 2 轮询/P 覆盖/慢异步/组合/E 失败/T 超时', () => {
    setSteps('A, A:P0 ,A:P3,A:800,A:800:P3,E:MODEL_RATE_LIMITED,T:1500');
    const steps = parseE2eVideoSteps();
    expect(steps.slice(0, 5)).toEqual([
      { kind: 'ASYNC', pendingPolls: 2 },
      { kind: 'ASYNC', pendingPolls: 0 },
      { kind: 'ASYNC', pendingPolls: 3 },
      { afterMs: 800, kind: 'ASYNC', pendingPolls: 2 },
      { afterMs: 800, kind: 'ASYNC', pendingPolls: 3 },
    ]);
    expect(steps[5]?.kind).toBe('ERROR');
    expect(steps[5]?.kind === 'ERROR' && steps[5].error.code).toBe('MODEL_RATE_LIMITED');
    expect(steps[6]).toEqual({ afterMs: 1500, kind: 'TIMEOUT' });
  });

  it('非法令牌启动期即抛—失败要响不带病运行', () => {
    for (const invalid of ['S', 'A:X3', 'A:P', 'E:lower_case', 'T', 'A::P1', 'X:1']) {
      setSteps(invalid);
      expect(() => parseE2eVideoSteps()).toThrow('JINGXU_E2E_VIDEO_STEPS_INVALID_TOKEN');
    }
  });
});

/** 视频四字段齐备的镜头文档（extractVideoShotFields 输入面）。 */
const shotDocument = JSON.stringify({
  cinematography: { camera_angle: 'EYE_LEVEL', camera_motion: 'DOLLY', shot_size: 'MEDIUM' },
  content: { action: '少女撑伞走过雨巷', character_ids: [], emotion: '怅惘', scene_id: null },
  continuity: { continuity_mode: 'SCENE_CHANGE' },
  narrative_purpose: '建立雨巷氛围',
});

const shotOf = (index: number) => ({
  sequence: index,
  shotId: `shot_0000000${String(index)}`,
  version: {
    createdAt: NOW,
    dialogueRenderMode: 'NARRATION_FIRST' as const,
    document: shotDocument,
    documentSha256: hash64(`doc_${String(index)}`),
    externalParentVersionId: null,
    formatProfileId: 'fp_1',
    id: `scv_0000000${String(index)}`,
    lineageResolutionStatus: 'LOCAL_VERIFIED' as const,
    parentId: null,
    sequence: index,
    shotId: `shot_0000000${String(index)}`,
    sourceInvocationId: null,
    targetDurationSec: 8,
    versionNo: 1,
    versionStatus: 'READY' as const,
  },
});

const workspaceOf = (shotCount: number) => ({
  episode: null,
  projectId: 'project_00000001',
  sourceInput: null,
  stages: [],
  storyboard: {
    current: {
      createdAt: NOW,
      episodeId: 'episode_1',
      formatProfileId: 'fp_1',
      id: 'ev_1',
      parentId: null,
      shotSetHash: hash64('set'),
      status: 'READY' as const,
      storyBibleVersionId: null,
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: Array.from({ length: shotCount }, (_, i) => shotOf(i + 1)),
    history: [],
    historyTruncated: false,
  },
});

const safeStorageFacade = {
  decryptString: (encrypted: Uint8Array) => String.fromCharCode(...encrypted),
  encryptString: (plaintext: string) => Uint8Array.from(plaintext, (char) => char.charCodeAt(0)),
  isEncryptionAvailable: () => true,
};

const trustedEvent = (): IpcEvent => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

interface Harness {
  readonly handlers: Map<
    string,
    (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >;
  readonly invocationRepository: InMemoryMediaInvocationRepository;
  readonly invoke: (channel: string, input: unknown) => Promise<unknown>;
  readonly mediaRepository: InMemoryMediaRepository;
  readonly registration: ReturnType<typeof createVideoFeatureRegistration>;
  readonly videoRepository: InMemoryVideoMediaRepository;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jingxu-video-features-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const buildHarness = (writeEnabled = true, shotCount = 1): Harness => {
  const handlers = new Map<
    string,
    (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const mediaRepository = new InMemoryMediaRepository();
  // 单例 video 仓：任务/批次行跨事务可见（镜像生产聚合 UnitOfWork 的生命周期）。
  const videoRepository = new InMemoryVideoMediaRepository(mediaRepository.candidates);
  const invocationRepository = new InMemoryMediaInvocationRepository();
  const workspaceQuery = {
    getWorkspace: vi.fn(() => Promise.resolve(workspaceOf(shotCount))),
    getVersionDocument: vi.fn(() => Promise.resolve(null)),
  };
  const repositories = {
    projects: {
      findActiveNameRefs: () =>
        Promise.resolve([{ name: '雾都来信', projectId: 'project_00000001' }]),
    },
  };
  const runtime = {
    getMediaUnitOfWork: () => ({
      run: <T>(work: (repos: MediaRepositories) => Promise<T>) =>
        work({ invocations: invocationRepository, media: mediaRepository, video: videoRepository }),
    }),
    getProjectUnitOfWork: () => ({
      run: <T>(work: (repos: typeof repositories) => Promise<T>) => work(repositories),
    }),
    getScriptWorkspaceQuery: () => workspaceQuery,
    startupService: { getStatus: () => ({ writeEnabled }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createVideoFeatureRegistration({
    clock: () => NOW,
    ipcRegistrar: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    managedRoot: root,
    persistenceRuntime: runtime,
    pollIntervalMs: 10,
    safeStorage: safeStorageFacade,
    trustedUrl: 'jingxu://app/index.html',
    useE2eMock: true,
  });
  return {
    handlers,
    invocationRepository,
    invoke: (channel, input) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`channel not registered: ${channel}`);
      return handler(trustedEvent(), input);
    },
    mediaRepository,
    registration,
    videoRepository,
  };
};

/** 已选首帧种子：字节真实落内容寻址盘（images 命名空间）+ 选中指针。 */
const seedFirstFrame = async (harness: Harness, index: number): Promise<void> => {
  const store = createContentAddressedStore(root);
  const stored = await store.write({
    bytes: Uint8Array.from([1, 2, 3, 4]),
    mimeType: 'image/png',
    namespace: 'images',
    projectId: 'project_00000001',
  });
  const shotId = `shot_0000000${String(index)}`;
  await harness.mediaRepository.insertCandidates({
    candidateIds: [`img_0000000${String(index)}`],
    generationInputHash: hash64(`igen_${String(index)}`),
    modelId: 'doubao-seedream-5-0-lite-260128',
    projectId: 'project_00000001',
    roundNo: 1,
    shotId,
    shotVersionId: `scv_0000000${String(index)}`,
  });
  await harness.mediaRepository.completeCandidateSucceeded(`img_0000000${String(index)}`, {
    byteSize: 4,
    fileSha256: stored.sha256,
    height: 2560,
    invocationEvidenceRef: `inv_img_${String(index)}`,
    mimeType: 'image/png',
    storageRelPath: stored.storageRelPath,
    width: 1440,
  });
  await harness.mediaRepository.selectCandidate(shotId, `img_0000000${String(index)}`);
};

describe('createVideoFeatureRegistration', () => {
  it('注册边界—固定七 video 频道—READY 前统一 STARTUP_WRITE_BLOCKED', () => {
    const harness = buildHarness(false);
    expect([...harness.handlers.keys()].sort()).toEqual(Object.values(VIDEO_IPC_CHANNELS).sort());
    expect(harness.handlers.size).toBe(7);
    expect(harness.registration.ensureRegistered()).toBe(false);
  });

  it(
    '激活后—已选首帧生成 2 视频候选全 SUCCEEDED—POLL 实录与受限 video-candidate URL',
    { timeout: 15_000 },
    async () => {
      const harness = buildHarness(true);
      await seedFirstFrame(harness, 1);
      // 激活前：写门阻断。
      await expect(
        harness.invoke(VIDEO_IPC_CHANNELS.generateVideoCandidates, {
          projectId: 'project_00000001',
          requestId: 'request_gen_0000001',
          shotId: 'shot_00000001',
        }),
      ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });

      expect(harness.registration.ensureRegistered()).toBe(true);
      expect(harness.registration.ensureRegistered()).toBe(false); // 幂等：只激活一次

      const generated = await harness.invoke(VIDEO_IPC_CHANNELS.generateVideoCandidates, {
        projectId: 'project_00000001',
        requestId: 'request_gen_0000002',
        shotId: 'shot_00000001',
      });
      expect(generated).toMatchObject({ data: { phase: 'SUBMITTED' }, ok: true });

      await vi.waitFor(
        () => {
          expect(harness.videoRepository.candidates.map((candidate) => candidate.status)).toEqual([
            'SUCCEEDED',
            'SUCCEEDED',
          ]);
          expect(harness.videoRepository.tasks[0]?.phase).toBe('COMPLETED');
        },
        { interval: 20, timeout: 10_000 },
      );
      // 视频域字段随成功候选落位（A6 实录口径）。
      expect(
        harness.videoRepository.candidates.every(
          (candidate) =>
            candidate.actualDurationSec !== null &&
            candidate.mimeType === 'video/mp4' &&
            candidate.storageRelPath?.includes('/videos/') === true,
        ),
      ).toBe(true);
      // 证据三段：2 SUBMIT + POLL 实录（默认 2 次 PENDING 后 SUCCEEDED = 3 轮询/候选）
      // + 2 DOWNLOAD，全部终态。
      const kindCount = (kind: string): number =>
        harness.invocationRepository.invocations.filter((row) => row.segmentKind === kind).length;
      expect(kindCount('SUBMIT')).toBe(2);
      expect(kindCount('POLL')).toBe(6);
      expect(kindCount('DOWNLOAD')).toBe(2);
      expect(
        harness.invocationRepository.invocations.every(
          (row) => row.status === 'SUCCEEDED' || row.status === 'STARTED',
        ),
      ).toBe(true);
      const listed = await harness.invoke(VIDEO_IPC_CHANNELS.listVideoCandidates, {
        projectId: 'project_00000001',
        shotId: 'shot_00000001',
      });
      expect(listed).toMatchObject({ ok: true });
      const candidates = (listed as { data: { mediaUrl: string | null }[] }).data;
      expect(candidates).toHaveLength(2);
      for (const candidate of candidates) {
        expect(candidate.mediaUrl).toMatch(/^jingxu:\/\/media\/video-candidate\//);
      }
      await harness.registration.stop();
    },
  );

  it(
    '批次集成—整集排队两镜头—惰性串行建档至全部 COMPLETED—聚合视图收尾派生',
    { timeout: 20_000 },
    async () => {
      const harness = buildHarness(true, 2);
      await seedFirstFrame(harness, 1);
      await seedFirstFrame(harness, 2);
      expect(harness.registration.ensureRegistered()).toBe(true);

      const created = (await harness.invoke(VIDEO_IPC_CHANNELS.generateVideosForShots, {
        projectId: 'project_00000001',
        requestId: 'request_batch_0001',
        shotIds: ['shot_00000001', 'shot_00000002'],
      })) as {
        data: { batchId: string; members: unknown[]; status: string };
        ok: boolean;
      };
      expect(created.ok).toBe(true);
      expect(created.data.status).toBe('RUNNING');
      expect(created.data.members.map((member) => (member as { shotId: string }).shotId)).toEqual([
        'shot_00000001',
        'shot_00000002',
      ]);

      // 排空钩子惰性建档：同批成员串行，最终批次收尾派生 COMPLETED。
      await vi.waitFor(
        () => {
          expect(harness.videoRepository.batches[0]?.status).toBe('COMPLETED');
          expect(harness.videoRepository.batches[0]?.pendingShotIds).toEqual([]);
        },
        { interval: 50, timeout: 15_000 },
      );
      // 两成员各 2 候选全部落 SUCCEEDED。
      expect(harness.videoRepository.tasks).toHaveLength(2);
      expect(harness.videoRepository.tasks.every((task) => task.phase === 'COMPLETED')).toBe(true);
      expect(harness.videoRepository.candidates).toHaveLength(4);
      expect(
        harness.videoRepository.candidates.every((candidate) => candidate.status === 'SUCCEEDED'),
      ).toBe(true);

      const states = (await harness.invoke(VIDEO_IPC_CHANNELS.listStoryboardVideoStates, {
        projectId: 'project_00000001',
      })) as {
        data: {
          batches: { members: { phase: string | null; taskId: string | null }[]; status: string }[];
          shots: { currentGenSucceededCount: number; shotId: string }[];
        };
        ok: boolean;
      };
      expect(states.ok).toBe(true);
      const view = states.data.batches[0];
      if (view === undefined) throw new Error('batch view missing');
      expect(view.status).toBe('COMPLETED');
      expect(view.members.every((member) => member.phase === 'COMPLETED' && member.taskId)).toBe(
        true,
      );
      const counts = new Map(states.data.shots.map((shot) => [shot.shotId, shot]));
      expect(counts.get('shot_00000001')?.currentGenSucceededCount).toBe(2);
      expect(counts.get('shot_00000002')?.currentGenSucceededCount).toBe(2);
      await harness.registration.stop();
    },
  );
});
