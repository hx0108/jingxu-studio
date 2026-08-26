import { describe, expect, it, vi } from 'vitest';

import { VOICE_IPC_CHANNELS } from '@jingxu/contracts';
import type { AppResultDto, VoiceCandidateViewDto, VoiceMappingDto } from '@jingxu/contracts';
import type { VoiceIpcService } from './voice-ipc';
import { registerVoiceIpc } from './voice-ipc';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

/** 合法 64 位十六进制（契约 hashSchema 只认 [a-f0-9]{64}）。 */
const hash64 = (seed: string): string => String(seed.length % 10).repeat(64);
const NOW = '2026-08-27T00:00:00.000Z';
const PROJECT = 'project_12345678';

const mapping: VoiceMappingDto = {
  speakerId: 'narrator',
  updatedAt: NOW,
  voiceId: 'Neil',
};
const okMappings: AppResultDto<VoiceMappingDto[]> = { data: [mapping], ok: true };

const candidate: VoiceCandidateViewDto = {
  byteSize: null,
  createdAt: NOW,
  durationMs: null,
  errorCode: null,
  generationInputHash: hash64('gen'),
  id: 'vcand_12345678',
  indexInRound: 0,
  mediaUrl: null,
  modelId: 'qwen3-tts-instruct-flash',
  mimeType: null,
  roundNo: 1,
  selectedAt: null,
  shotId: 'shot_12345678',
  shotVersionId: 'scv_12345678',
  speakerId: 'narrator',
  spokenTextSha256: hash64('spoken'),
  status: 'PENDING',
  voiceId: 'Neil',
};
const okCandidates: AppResultDto<VoiceCandidateViewDto[]> = { data: [candidate], ok: true };
const okDelete: AppResultDto<{ candidateId: string }> = {
  data: { candidateId: 'vcand_12345678' },
  ok: true,
};

const okBatch = {
  ok: true as const,
  data: {
    batchId: 'vjob_12345678',
    createdAt: NOW,
    skippedShots: [{ reason: 'NOT_VOICE_TARGET' as const, shotId: 'shot_87654321' }],
    targetShotIds: ['shot_12345678'],
  },
};

const createHarness = (ready = true) => {
  const handlers = new Map<
    string,
    (event: ReturnType<typeof trustedEvent>, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const service: VoiceIpcService = {
    getMappings: vi.fn(() => Promise.resolve(okMappings)),
    saveMapping: vi.fn(() => Promise.resolve(okMappings)),
    generateForEpisode: vi.fn(() => Promise.resolve(okBatch)),
    getGenerations: vi.fn(() => Promise.resolve(okCandidates)),
    selectCandidate: vi.fn(() => Promise.resolve(okCandidates)),
    deleteCandidate: vi.fn(() => Promise.resolve(okDelete)),
  };
  registerVoiceIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    { isWriteReady: () => ready },
    'jingxu://app/index.html',
    { newTraceId: () => 'trace_voice_12345678' },
  );
  return { handlers, service };
};

describe('Voice Main IPC Contract（tasks 4.2，design D6）', () => {
  it('注册边界—固定六方法—可信 sender 与 strict DTO 后委托 Application', async () => {
    const { handlers, service } = createHarness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(VOICE_IPC_CHANNELS).sort());

    await expect(
      handlers.get(VOICE_IPC_CHANNELS.getMappings)?.(trustedEvent(), { projectId: PROJECT }),
    ).resolves.toEqual(okMappings);
    await expect(
      handlers.get(VOICE_IPC_CHANNELS.getGenerations)?.(trustedEvent(), {
        projectId: PROJECT,
        shotId: 'shot_12345678',
      }),
    ).resolves.toEqual(okCandidates);
    await expect(
      handlers.get(VOICE_IPC_CHANNELS.generateForEpisode)?.(trustedEvent(), {
        episodeId: 'episode_12345678',
        projectId: PROJECT,
        requestId: 'request_voice_0001',
        shotIds: ['shot_12345678'],
      }),
    ).resolves.toEqual(okBatch);
    await expect(
      handlers.get(VOICE_IPC_CHANNELS.selectCandidate)?.(trustedEvent(), {
        candidateId: 'vcand_12345678',
        projectId: PROJECT,
        requestId: 'request_select_1',
      }),
    ).resolves.toEqual(okCandidates);
    await expect(
      handlers.get(VOICE_IPC_CHANNELS.deleteCandidate)?.(trustedEvent(), {
        candidateId: 'vcand_12345678',
        projectId: PROJECT,
        requestId: 'request_delete_1',
      }),
    ).resolves.toEqual({ data: { candidateId: 'vcand_12345678' }, ok: true });
    await expect(
      handlers.get(VOICE_IPC_CHANNELS.saveMapping)?.(trustedEvent(), {
        mappings: [{ speakerId: 'narrator', voiceId: 'Neil' }],
        projectId: PROJECT,
        requestId: 'request_mapping_1',
      }),
    ).resolves.toEqual(okMappings);
    expect(service.getMappings).toHaveBeenCalledWith(
      { projectId: PROJECT },
      'trace_voice_12345678',
    );
    expect(service.generateForEpisode).toHaveBeenCalledWith(
      {
        episodeId: 'episode_12345678',
        projectId: PROJECT,
        requestId: 'request_voice_0001',
        shotIds: ['shot_12345678'],
      },
      'trace_voice_12345678',
    );
  });

  it('非 READY—六方法（含只读查询）统一阻断—Service 零调用', async () => {
    const { handlers, service } = createHarness(false);
    const inputs: readonly [string, unknown][] = [
      [VOICE_IPC_CHANNELS.getMappings, { projectId: PROJECT }],
      [VOICE_IPC_CHANNELS.getGenerations, { projectId: PROJECT, shotId: 'shot_12345678' }],
      [
        VOICE_IPC_CHANNELS.saveMapping,
        {
          mappings: [{ speakerId: 'narrator', voiceId: 'Neil' }],
          projectId: PROJECT,
          requestId: 'request_mapping_1',
        },
      ],
      [
        VOICE_IPC_CHANNELS.generateForEpisode,
        {
          episodeId: 'episode_12345678',
          projectId: PROJECT,
          requestId: 'request_voice_0001',
          shotIds: ['shot_12345678'],
        },
      ],
      [
        VOICE_IPC_CHANNELS.selectCandidate,
        { candidateId: 'vcand_12345678', projectId: PROJECT, requestId: 'request_select_1' },
      ],
      [
        VOICE_IPC_CHANNELS.deleteCandidate,
        { candidateId: 'vcand_12345678', projectId: PROJECT, requestId: 'request_delete_1' },
      ],
    ];
    for (const [channel, input] of inputs) {
      await expect(handlers.get(channel)?.(trustedEvent(), input)).resolves.toMatchObject({
        error: { code: 'STARTUP_WRITE_BLOCKED' },
        ok: false,
      });
    }
    expect(service.getMappings).not.toHaveBeenCalled();
    expect(service.getGenerations).not.toHaveBeenCalled();
    expect(service.saveMapping).not.toHaveBeenCalled();
    expect(service.generateForEpisode).not.toHaveBeenCalled();
  });

  it('未知字段与重复 shotIds—输入拒绝—Service 零调用', async () => {
    const { handlers, service } = createHarness();
    const handle = handlers.get(VOICE_IPC_CHANNELS.generateForEpisode);
    await expect(
      handle?.(trustedEvent(), {
        episodeId: 'episode_12345678',
        projectId: PROJECT,
        requestId: 'request_voice_0001',
        shotIds: ['shot_12345678', 'shot_12345678'],
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    await expect(
      handle?.(trustedEvent(), {
        episodeId: 'episode_12345678',
        projectId: PROJECT,
        requestId: 'request_voice_0001',
        shotIds: ['shot_12345678'],
        spokenText: '台词不入请求',
      }),
    ).resolves.toMatchObject({ error: { code: 'IPC_INVALID_REQUEST' } });
    expect(service.generateForEpisode).not.toHaveBeenCalled();
  });

  it('不可信 frame—边界直接拒绝—Service 零调用', () => {
    const { handlers, service } = createHarness();
    const event = trustedEvent();
    expect(() =>
      handlers.get(VOICE_IPC_CHANNELS.getGenerations)?.(
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        { projectId: PROJECT, shotId: 'shot_12345678' },
      ),
    ).toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(service.getGenerations).not.toHaveBeenCalled();
  });

  it('同 requestId 并发同命令—singleflight 同结果—Application 只调用一次', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<VoiceCandidateViewDto[]>) => void) | undefined;
    vi.mocked(service.selectCandidate).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(VOICE_IPC_CHANNELS.selectCandidate);
    const input = {
      candidateId: 'vcand_12345678',
      projectId: PROJECT,
      requestId: 'request_select_1',
    };
    const first = handle?.(trustedEvent(), input);
    const second = handle?.(trustedEvent(), input);
    await vi.waitFor(() => {
      expect(service.selectCandidate).toHaveBeenCalledOnce();
    });
    finish?.(okCandidates);
    await expect(Promise.all([first, second])).resolves.toEqual([okCandidates, okCandidates]);
    expect(service.selectCandidate).toHaveBeenCalledOnce();
  });

  it('同 requestId 并发异命令—REQUEST_ID_REUSED 拒绝', async () => {
    const { handlers, service } = createHarness();
    let finish: ((value: AppResultDto<VoiceCandidateViewDto[]>) => void) | undefined;
    vi.mocked(service.selectCandidate).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const handle = handlers.get(VOICE_IPC_CHANNELS.selectCandidate);
    const first = handle?.(trustedEvent(), {
      candidateId: 'vcand_12345678',
      projectId: PROJECT,
      requestId: 'request_select_1',
    });
    const second = handle?.(trustedEvent(), {
      candidateId: 'vcand_87654321',
      projectId: PROJECT,
      requestId: 'request_select_1',
    });
    await vi.waitFor(() => {
      expect(service.selectCandidate).toHaveBeenCalledOnce();
    });
    finish?.(okCandidates);
    await expect(first).resolves.toEqual(okCandidates);
    await expect(second).resolves.toMatchObject({ error: { code: 'REQUEST_ID_REUSED' } });
  });
});
