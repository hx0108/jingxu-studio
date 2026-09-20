import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort, VideoResultRef } from '@jingxu/application';

import {
  AGNES_VIDEO_2_5_FLASH_MODEL_ID,
  AgnesVideoModelAdapter,
  DEFAULT_AGNES_VIDEO_MODEL_ID,
} from '@jingxu/model-adapters';

/**
 * 受控真实 Canary（low-cost-video-provider-integration design D8 / tasks 7.5）：
 * 仅在同时提供 `JINGXU_REAL_AGNES_VIDEO_PROBE=1` 与 `JINGXU_AGNES_API_KEY` 时对
 * 两个冻结模型各运行一次 5 秒/720P/单候选 data URL 首帧任务；其余环境一律跳过、
 * 零网络。当前档位 $0/秒（2026-09-19 促销事实，见该 Change design.md Context）。
 * 免费档任务创建约 1 RPM：两模型顺序执行，第二次提交前强制 65 秒间隔。
 * 放在 desktop 侧：model-adapters 为无 Node 类型的纯净区，探针需要 env/Buffer。
 */
const gated = process.env.JINGXU_REAL_AGNES_VIDEO_PROBE === '1';
const apiKey = process.env.JINGXU_AGNES_API_KEY ?? '';

/** 512×512 纯色 PNG（满足服务端 256–5760 边长约束），zlib 压缩后约 1.9 KiB。 */
const FIRST_FRAME_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIElEQVR4nO3VMQ0AMAzAsKEbnGEq1MHoEUsGkC/nvgEg6KwXALDCAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAGCaPqfBT7EgPK29AAAAAElFTkSuQmCC';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const runRealGeneration = async (modelId: string, invocationId: string): Promise<void> => {
  const credentials: CredentialPort = {
    deleteCredential: vi.fn(),
    isAvailable: () => true,
    loadCredential: () => Promise.resolve(apiKey),
    saveCredential: vi.fn(),
  };
  const adapter = new AgnesVideoModelAdapter({
    credentialId: 'profile-video-agnes-primary',
    credentialPort: credentials,
    modelId: modelId as 'agnes-video-v2.0',
  });
  const firstFrame = Uint8Array.from(Buffer.from(FIRST_FRAME_PNG_BASE64, 'base64'));
  // submit 可重试容错（与调度器任务级重试同语义）：免费档队列满载（503
  // video_queue_full，D5b 实测可持续 10+ 分钟）归一 MODEL_PROVIDER_ERROR；
  // 失败提交不占 RPM，45 秒间隔最多重试 4 次。
  let submission;
  for (let submitAttempt = 1; ; submitAttempt += 1) {
    try {
      submission = await adapter.submit(
        {
          durationSec: 5,
          firstFrame: { bytes: firstFrame, mimeType: 'image/png' },
          invocationId,
          modelId,
          prompt: 'A calm ocean at dawn, gentle waves, soft light, cinematic wide shot',
          resolution: { height: 1280, width: 720 },
        },
        new AbortController().signal,
      );
      break;
    } catch (caught) {
      const code = adapter.normalizeError(caught).code;
      if (
        (code === 'MODEL_PROVIDER_ERROR' || code === 'MODEL_NETWORK_ERROR' ||
          code === 'MODEL_RATE_LIMITED' || code === 'MODEL_TIMEOUT') &&
        submitAttempt < 12
      ) {
        console.info(
          `[agnes-canary] ${modelId} submit retryable ${code} · attempt=${String(submitAttempt)} · wait 60s`,
        );
        await sleep(60_000);
        continue;
      }
      throw caught;
    }
  }
  expect(submission.kind).toBe('ASYNC');
  if (submission.kind !== 'ASYNC') return;
  // 脱敏证据：只留任务 ID 前缀，不含 Key、结果 URL 或原始响应。
  console.info(
    `[agnes-canary] ${modelId} submit ok · task=${submission.providerTaskId.slice(0, 8)}…`,
  );

  let succeeded = false;
  let polls = 0;
  let consecutiveRetryable = 0;
  for (let attempt = 0; attempt < 90 && !succeeded; attempt += 1) {
    // 7 秒间隔轮询：与组合根 AGNES_VIDEO_POLL_INTERVAL_MS 同口径（429 频控实测
    // 4 秒触发、5 秒不触发，7 秒留安全余量；调度器对轮询错误无退避）。
    await sleep(7_000);
    // 瞬时可重试错误（SSL EOF/网络抖动/限流）与生产调度器同语义继续退避；
    // 连续 5 次仍失败才判定链路故障（2026-09-19 实录：路由偶发 SSL 握手 EOF）。
    let status;
    try {
      status = await adapter.poll(submission.providerTaskId, new AbortController().signal);
      consecutiveRetryable = 0;
    } catch (caught) {
      const code = adapter.normalizeError(caught).code;
      if (
        (code === 'MODEL_NETWORK_ERROR' || code === 'MODEL_RATE_LIMITED' ||
          code === 'MODEL_PROVIDER_ERROR' || code === 'MODEL_TIMEOUT') &&
        consecutiveRetryable < 5
      ) {
        consecutiveRetryable += 1;
        console.info(`[agnes-canary] ${modelId} poll retryable ${code} · streak=${String(consecutiveRetryable)}`);
        continue;
      }
      throw caught;
    }
    polls += 1;
    if (status.state === 'SUCCEEDED') {
      // VideoTaskStatus 的 SUCCEEDED 结果类型按图片域同构收窄，视频专属
      // actualDurationSec 运行时由适配器回报，此处以 VideoResultRef 视角下载。
      const result = status.result as VideoResultRef;
      const download = await adapter.download(result, new AbortController().signal);
      expect(download.mimeType).toBe('video/mp4');
      expect(download.bytes.byteLength).toBeGreaterThan(1024);
      expect(download.bytes[4]).toBe(0x66);
      expect(download.bytes[5]).toBe(0x74);
      expect(download.bytes[6]).toBe(0x79);
      expect(download.bytes[7]).toBe(0x70);
      succeeded = true;
      console.info(
        `[agnes-canary] ${modelId} DONE · polls=${String(polls)} · bytes=${String(download.bytes.byteLength)} · mp4Sha256=${createHash('sha256').update(download.bytes).digest('hex').slice(0, 16)}… · actualDurationSec=${String(result.actualDurationSec ?? 'unreported')}`,
      );
    } else if (status.state === 'FAILED') {
      throw new Error(`AGNES_CANARY_FAILED_${status.errorCode}`);
    }
  }
  expect(succeeded).toBe(true);
};

describe.skipIf(!gated || apiKey === '')('AgnesVideoModelAdapter 真实 Canary', () => {
  it(
    'V2.0（image+ti2vid）5 秒 data URL 首帧经真实端点完成并下载 MP4',
    { timeout: 600_000 },
    async () => {
      await runRealGeneration(DEFAULT_AGNES_VIDEO_MODEL_ID, 'agnes-canary-v20-0001');
    },
  );

  it(
    '2.5 Flash（keyframe+first_frame，720P 硬校验）65 秒 RPM 间隔后同链验证',
    { timeout: 1_500_000 },
    async () => {
      // 免费档创建约 1 RPM：等上一任务创建满 65 秒再提交。
      await sleep(65_000);
      await runRealGeneration(AGNES_VIDEO_2_5_FLASH_MODEL_ID, 'agnes-canary-25f-0001');
    },
  );
});
