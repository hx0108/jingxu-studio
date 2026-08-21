import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FormatProfile } from '@jingxu/domain';
import {
  InMemoryMediaInvocationRepository,
  InMemoryMediaRepository,
  InMemoryVideoMediaRepository,
} from '@jingxu/application';
import type { MediaRepositories } from '@jingxu/application';
import { IMAGE_IPC_CHANNELS } from '@jingxu/contracts';
import type { IpcEvent } from '../ipc/ipc-boundary';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createImageFeatureRegistration } from './register-image-features';

const NOW = '2026-08-16T00:00:00.000Z';
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);

const trustedEvent = (): IpcEvent => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const formatProfile: FormatProfile = {
  createdAt: NOW,
  id: 'fp_1',
  isCurrent: true,
  parentId: null,
  projectId: 'project_00000001',
  spec: {
    aspectRatio: '9:16',
    fps: 30,
    height: 2560,
    language: 'zh-CN',
    subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    width: 1440,
  },
  versionNo: 1,
};

const shotDocument = JSON.stringify({
  cinematography: { camera_angle: 'EYE_LEVEL', shot_size: 'MEDIUM' },
  content: { action: '走过雨巷', character_ids: [], scene_id: null },
  continuity: { continuity_mode: 'SCENE_CHANGE' },
  generation_constraints: { image_prompt: '雨巷中的少女' },
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

interface Harness {
  readonly handlers: Map<
    string,
    (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >;
  readonly invoke: (channel: string, input: unknown) => Promise<unknown>;
  readonly mediaRepository: InMemoryMediaRepository;
  readonly registration: ReturnType<typeof createImageFeatureRegistration>;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jingxu-image-features-'));
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
  const workspaceQuery = {
    getWorkspace: vi.fn(() => Promise.resolve(workspaceOf(shotCount))),
    getVersionDocument: vi.fn(() => Promise.resolve(null)),
  };
  const repositories = {
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    projects: {
      findActiveNameRefs: () =>
        Promise.resolve([{ name: '雾都来信', projectId: 'project_00000001' }]),
    },
  };
  const runtime = {
    getFormatProfileRepository: () => repositories.formatProfiles,
    getMediaUnitOfWork: () => ({
      run: <T>(work: (repos: MediaRepositories) => Promise<T>) =>
        work({
          invocations: new InMemoryMediaInvocationRepository(),
          media: mediaRepository,
          video: new InMemoryVideoMediaRepository(mediaRepository.candidates),
        }),
    }),
    getProjectUnitOfWork: () => ({
      run: <T>(work: (repos: typeof repositories) => Promise<T>) => work(repositories),
    }),
    getScriptWorkspaceQuery: () => workspaceQuery,
    startupService: { getStatus: () => ({ writeEnabled }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createImageFeatureRegistration({
    clock: () => NOW,
    ipcRegistrar: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    managedRoot: root,
    persistenceRuntime: runtime,
    safeStorage: safeStorageFacade,
    trustedUrl: 'jingxu://app/index.html',
    useE2eMock: true,
  });
  return {
    handlers,
    invoke: (channel, input) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`channel not registered: ${channel}`);
      return handler(trustedEvent(), input);
    },
    mediaRepository,
    registration,
  };
};

describe('createImageFeatureRegistration', () => {
  it('注册边界—固定九 image 频道—READY 前统一 STARTUP_WRITE_BLOCKED', () => {
    const harness = buildHarness(false);
    expect([...harness.handlers.keys()].sort()).toEqual(Object.values(IMAGE_IPC_CHANNELS).sort());
    expect(harness.handlers.size).toBe(9);
    expect(harness.registration.ensureRegistered()).toBe(false);
  });

  it(
    '激活后—上传参考图落内容寻址盘—生成 kick 驱动 4 候选全部 SUCCEEDED',
    { timeout: 15_000 },
    async () => {
      const harness = buildHarness(true);
      // 激活前：写门阻断。
      await expect(
        harness.invoke(IMAGE_IPC_CHANNELS.generateCandidates, {
          projectId: 'project_00000001',
          requestId: 'request_gen_0000001',
          shotId: 'shot_00000001',
        }),
      ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });

      expect(harness.registration.ensureRegistered()).toBe(true);
      expect(harness.registration.ensureRegistered()).toBe(false); // 幂等：只激活一次

      const upload = await harness.invoke(IMAGE_IPC_CHANNELS.uploadAssetReference, {
        assetType: 'SCENE',
        bibleRefId: 'scene_alley',
        byteSize: 3,
        bytes: Uint8Array.from([1, 2, 3]),
        description: '雨巷参考',
        displayName: '雨巷',
        mimeType: 'image/png',
        projectId: 'project_00000001',
        requestId: 'request_upload_0001',
      });
      const uploaded = (upload as { data: { version: { mediaUrl: string; versionNo: number } } })
        .data;
      expect(uploaded.version.versionNo).toBe(1);
      expect(uploaded.version.mediaUrl.startsWith('jingxu://media/asset-version/')).toBe(true);

      const generated = await harness.invoke(IMAGE_IPC_CHANNELS.generateCandidates, {
        projectId: 'project_00000001',
        requestId: 'request_gen_0000002',
        shotId: 'shot_00000001',
      });
      expect(generated).toMatchObject({ data: { phase: 'SUBMITTED' }, ok: true });

      void 0;
      await vi.waitFor(
        () => {
          expect(harness.mediaRepository.candidates.map((candidate) => candidate.status)).toEqual([
            'SUCCEEDED',
            'SUCCEEDED',
            'SUCCEEDED',
            'SUCCEEDED',
          ]);
        },
        { interval: 20, timeout: 10_000 },
      );
      const listed = await harness.invoke(IMAGE_IPC_CHANNELS.listCandidates, {
        projectId: 'project_00000001',
        shotId: 'shot_00000001',
      });
      expect(listed).toMatchObject({ ok: true });
      const candidates = (listed as { data: { mediaUrl: string | null }[] }).data;
      expect(candidates).toHaveLength(4);
      for (const candidate of candidates) {
        expect(candidate.mediaUrl).toMatch(/^jingxu:\/\/media\/candidate\//);
      }
      await harness.registration.stop();
    },
  );

  it('选择切换—selectCandidate 返回全量候选且指针唯一', { timeout: 15_000 }, async () => {
    const harness = buildHarness(true);
    expect(harness.registration.ensureRegistered()).toBe(true);
    await harness.invoke(IMAGE_IPC_CHANNELS.generateCandidates, {
      projectId: 'project_00000001',
      requestId: 'request_gen_0000003',
      shotId: 'shot_00000001',
    });
    await vi.waitFor(
      () => {
        expect(harness.mediaRepository.candidates).toHaveLength(4);
        expect(
          harness.mediaRepository.candidates.every((candidate) => candidate.status === 'SUCCEEDED'),
        ).toBe(true);
      },
      { interval: 20, timeout: 10_000 },
    );
    const first = harness.mediaRepository.candidates[0];
    if (first === undefined) throw new Error('candidates not driven');
    const selected = await harness.invoke(IMAGE_IPC_CHANNELS.selectCandidate, {
      candidateId: first.id,
      projectId: 'project_00000001',
      requestId: 'request_sel_00000001',
    });
    expect(selected).toMatchObject({ ok: true });
    const selectedCandidates = (
      selected as {
        data: { id: string; selectedAt: string | null }[];
      }
    ).data;
    expect(selectedCandidates.filter((candidate) => candidate.selectedAt !== null)).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
    await harness.registration.stop();
  });

  it(
    '批次集成—整集排队两镜头—惰性串行建档至全部 COMPLETED—聚合视图收尾派生',
    { timeout: 20_000 },
    async () => {
      const harness = buildHarness(true, 2);
      expect(harness.registration.ensureRegistered()).toBe(true);

      const created = (await harness.invoke(IMAGE_IPC_CHANNELS.generateCandidatesForShots, {
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
          expect(harness.mediaRepository.batches[0]?.status).toBe('COMPLETED');
          expect(harness.mediaRepository.batches[0]?.pendingShotIds).toEqual([]);
        },
        { interval: 50, timeout: 15_000 },
      );
      // 两成员各 4 候选全部落 SUCCEEDED（Mock 档 SYNC 即成）。
      expect(harness.mediaRepository.tasks).toHaveLength(2);
      expect(harness.mediaRepository.tasks.every((task) => task.phase === 'COMPLETED')).toBe(true);
      expect(harness.mediaRepository.candidates).toHaveLength(8);
      expect(
        harness.mediaRepository.candidates.every((candidate) => candidate.status === 'SUCCEEDED'),
      ).toBe(true);

      const states = (await harness.invoke(IMAGE_IPC_CHANNELS.listStoryboardImageStates, {
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
      expect(counts.get('shot_00000001')?.currentGenSucceededCount).toBe(4);
      expect(counts.get('shot_00000002')?.currentGenSucceededCount).toBe(4);
      await harness.registration.stop();
    },
  );
});
