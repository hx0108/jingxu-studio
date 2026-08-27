import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  InMemoryMediaInvocationRepository,
  InMemoryMediaRepository,
  InMemoryVideoMediaRepository,
  InMemoryVoiceGenerationRepository,
} from '@jingxu/application';
import type { MediaRepositories } from '@jingxu/application';
import { createContentAddressedStore } from '@jingxu/persistence';
import { VOICE_IPC_CHANNELS } from '@jingxu/contracts';
import { NARRATOR_DEFAULT_VOICE_ID } from '@jingxu/model-adapters';
import type { IpcEvent } from '../ipc/ipc-boundary';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createVoiceFeatureRegistration } from './register-voice-features';

const NOW = '2026-08-16T00:00:00.000Z';
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);
const PROJECT = 'project_00000001';

/** 真实 ffprobe（与 voice-audio-registrar.test 同源）：Mock TTS 的 PCM WAV 需实测时长。 */
const ffprobePath = path.resolve(import.meta.dirname, '../../../resources/ffmpeg/ffprobe.exe');

/** 台词字段齐备的镜头文档（extractVoiceShotFields 输入面，narrator 免映射缺口）。 */
const voiceShotDocument = JSON.stringify({
  content: { action: '旁白铺陈雨巷', spoken_text: '雨巷深处传来缓慢的脚步声。' },
  dialogue: { audio_required: true, speaker_id: 'narrator' },
});

/** 无台词镜头：audio_required=false，建批按 NOT_VOICE_TARGET 跳过。 */
const silentShotDocument = JSON.stringify({
  content: { action: '空镜转场', spoken_text: null },
  dialogue: { audio_required: false, speaker_id: null },
});

const shotOf = (index: number, document: string) => ({
  sequence: index,
  shotId: `shot_0000000${String(index)}`,
  version: {
    createdAt: NOW,
    dialogueRenderMode: 'NARRATION_FIRST' as const,
    document,
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

const workspaceOf = () => ({
  episode: null,
  projectId: PROJECT,
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
    currentShots: [shotOf(1, voiceShotDocument), shotOf(2, silentShotDocument)],
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
  readonly invoke: (channel: string, input: unknown) => Promise<unknown>;
  readonly registration: ReturnType<typeof createVoiceFeatureRegistration>;
  readonly voiceRepository: InMemoryVoiceGenerationRepository;
}

let root: string;

beforeAll(async () => {
  process.env.JINGXU_FFPROBE_PATH = ffprobePath;
  root = await mkdtemp(path.join(tmpdir(), 'jingxu-voice-features-'));
});

afterAll(async () => {
  delete process.env.JINGXU_FFPROBE_PATH;
  await rm(root, { recursive: true, force: true });
});

const buildHarness = (writeEnabled = true): Harness => {
  const handlers = new Map<
    string,
    (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  // 单例 voice 仓：job/候选行跨事务可见（镜像生产聚合 UnitOfWork 的生命周期）。
  const voiceRepository = new InMemoryVoiceGenerationRepository();
  const mappingRows = new Map<
    string,
    { projectId: string; speakerId: string; updatedAt: string; voiceId: string }
  >();
  const repositories = {
    projects: {
      findActiveNameRefs: () => Promise.resolve([{ name: '雾都来信', projectId: PROJECT }]),
    },
  };
  const runtime = {
    getMediaUnitOfWork: () => ({
      run: <T>(work: (repos: MediaRepositories) => Promise<T>) =>
        work({
          invocations: new InMemoryMediaInvocationRepository(),
          media: new InMemoryMediaRepository(),
          video: new InMemoryVideoMediaRepository(),
          voice: {
            generation: voiceRepository,
            mapping: {
              listByProject: (projectId: string) =>
                Promise.resolve(
                  [...mappingRows.values()].filter((row) => row.projectId === projectId),
                ),
              replaceAll: (
                projectId: string,
                mappings: readonly { speakerId: string; updatedAt: string; voiceId: string }[],
              ) => {
                for (const [key, row] of mappingRows.entries()) {
                  if (row.projectId === projectId) mappingRows.delete(key);
                }
                for (const mapping of mappings) {
                  mappingRows.set(`${projectId}:${mapping.speakerId}`, {
                    projectId,
                    speakerId: mapping.speakerId,
                    updatedAt: mapping.updatedAt,
                    voiceId: mapping.voiceId,
                  });
                }
                return Promise.resolve([...mappingRows.values()]);
              },
            },
          },
        }),
    }),
    getProjectUnitOfWork: () => ({
      run: <T>(work: (repos: typeof repositories) => Promise<T>) => work(repositories),
    }),
    getProviderProfileRepository: () => ({
      findById: () => Promise.resolve(null),
    }),
    getScriptWorkspaceQuery: () => ({
      getWorkspace: vi.fn(() => Promise.resolve(workspaceOf())),
      getVersionDocument: vi.fn(() => Promise.resolve(null)),
    }),
    startupService: { getStatus: () => ({ writeEnabled }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createVoiceFeatureRegistration({
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
    registration,
    voiceRepository,
  };
};

describe('createVoiceFeatureRegistration（tasks 4.2 组合根）', () => {
  it('注册边界—固定六频道白名单—READY 前统一 STARTUP_WRITE_BLOCKED', async () => {
    const harness = buildHarness(false);
    expect([...harness.handlers.keys()].sort()).toEqual(Object.values(VOICE_IPC_CHANNELS).sort());
    expect(harness.handlers.size).toBe(6);
    expect(harness.registration.ensureRegistered()).toBe(false);
    await expect(
      harness.invoke(VOICE_IPC_CHANNELS.getMappings, { projectId: PROJECT }),
    ).resolves.toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
  });

  it(
    '激活后—整集配音批量—无台词镜头如实跳过—候选 SUCCEEDED 与受限 voice-candidate URL',
    { timeout: 15_000 },
    async () => {
      const harness = buildHarness(true);
      expect(harness.registration.ensureRegistered()).toBe(true);
      expect(harness.registration.ensureRegistered()).toBe(false); // 幂等：只激活一次

      // 音色映射查询：narrator 固定行在列（免配置即可整集生成）。
      const mappings = (await harness.invoke(VOICE_IPC_CHANNELS.getMappings, {
        projectId: PROJECT,
      })) as { data: { speakerId: string; voiceId: string }[]; ok: boolean };
      expect(mappings.ok).toBe(true);
      expect(mappings.data).toEqual([
        { speakerId: 'narrator', updatedAt: NOW, voiceId: NARRATOR_DEFAULT_VOICE_ID },
      ]);

      const batch = (await harness.invoke(VOICE_IPC_CHANNELS.generateForEpisode, {
        episodeId: 'episode_1',
        projectId: PROJECT,
        requestId: 'request_vbatch_0001',
        shotIds: ['shot_00000001', 'shot_00000002'],
      })) as {
        data: {
          batchId: string;
          skippedShots: { reason: string; shotId: string }[];
          targetShotIds: string[];
        };
        ok: boolean;
      };
      expect(batch.ok).toBe(true);
      expect(batch.data.targetShotIds).toEqual(['shot_00000001']);
      expect(batch.data.skippedShots).toEqual([
        { reason: 'NOT_VOICE_TARGET', shotId: 'shot_00000002' },
      ]);

      await vi.waitFor(
        () => {
          expect(harness.voiceRepository.jobs[0]?.status).toBe('COMPLETED');
        },
        { interval: 20, timeout: 10_000 },
      );
      const candidate = harness.voiceRepository.candidates[0];
      if (candidate === undefined) throw new Error('voice candidate missing');
      // Mock TTS 的 PCM WAV 经 ffprobe 实测：时长为正、四元组落位（A6 实录口径）。
      expect(candidate.status).toBe('SUCCEEDED');
      expect(candidate.durationMs).toBeGreaterThan(0);
      expect(candidate.mimeType).toBe('audio/wav');
      expect(candidate.fileSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(candidate.storageRelPath?.includes('/audio/')).toBe(true);

      const generations = (await harness.invoke(VOICE_IPC_CHANNELS.getGenerations, {
        projectId: PROJECT,
        shotId: 'shot_00000001',
      })) as { data: { mediaUrl: string | null; status: string }[]; ok: boolean };
      expect(generations.ok).toBe(true);
      expect(generations.data).toHaveLength(1);
      expect(generations.data[0]?.status).toBe('SUCCEEDED');
      expect(generations.data[0]?.mediaUrl).toMatch(/^jingxu:\/\/media\/voice-candidate\//);

      // CAS 落盘与候选登记一致：按 fileSha256 可反查内容寻址文件。
      const store = createContentAddressedStore(root);
      await expect(
        store.resolvePathWithinProjects(candidate.storageRelPath ?? ''),
      ).resolves.toContain('audio');
      await harness.registration.stop();
    },
  );

  it('关停语义—stop 后调度循环收敛—新批量进入即正常排空（stop 幂等）', async () => {
    const harness = buildHarness(true);
    expect(harness.registration.ensureRegistered()).toBe(true);
    await harness.registration.stop();
    await expect(harness.registration.stop()).resolves.toBeUndefined();
    const second = (await harness.invoke(VOICE_IPC_CHANNELS.generateForEpisode, {
      episodeId: 'episode_1',
      projectId: PROJECT,
      requestId: 'request_vbatch_0002',
      shotIds: ['shot_00000001'],
    })) as { ok: boolean };
    expect(second.ok).toBe(true);
    await vi.waitFor(() => {
      expect(harness.voiceRepository.jobs.at(-1)?.status).toBe('COMPLETED');
    });
    await harness.registration.stop();
  });
});
