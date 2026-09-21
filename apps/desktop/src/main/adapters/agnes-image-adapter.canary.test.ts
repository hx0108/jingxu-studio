import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { CredentialPort } from '@jingxu/application';

import {
  AGNES_IMAGE_2_1_FLASH_MODEL_ID,
  AgnesImageModelAdapter,
  DEFAULT_AGNES_IMAGE_MODEL_ID,
} from '@jingxu/model-adapters';

/**
 * 受控真实 Canary（2026-09-21 图片档切换 Agnes Image）：
 * 仅在同时提供 `JINGXU_REAL_AGNES_IMAGE_PROBE=1` 与 `JINGXU_AGNES_API_KEY` 时对
 * 两个冻结模型各运行一次 1K/9:16/单候选同步生成 + img2img 参考图任务；其余环境
 * 一律跳过、零网络。当前全线 $0/图（2026-09-21 促销事实，wiki pricing 快照）。
 * 免费档限流口径未文档化：两模型顺序执行，第二次提交前强制 20 秒间隔；
 * 可重试错误（限流/网络抖动）与调度器同语义退避重试。
 * 放在 desktop 侧：model-adapters 为无 Node 类型的纯净区，探针需要 env/Buffer。
 */
const gated = process.env.JINGXU_REAL_AGNES_IMAGE_PROBE === '1';
const apiKey = process.env.JINGXU_AGNES_API_KEY ?? '';

/** 512×512 纯色 PNG（img2img 参考图占位），zlib 压缩后约 1.9 KiB。 */
const REFERENCE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIElEQVR4nO3VMQ0AMAzAsKEbnGEq1MHoEUsGkC/nvgEg6KwXALDCAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAGCaPqfBT7EgPK29AAAAAElFTkSuQmCC';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const runRealGeneration = async (modelId: string, invocationId: string): Promise<void> => {
  const credentials: CredentialPort = {
    deleteCredential: vi.fn(),
    isAvailable: () => true,
    loadCredential: () => Promise.resolve(apiKey),
    saveCredential: vi.fn(),
  };
  const adapter = new AgnesImageModelAdapter({
    credentialId: 'profile-image-agnes-primary',
    credentialPort: credentials,
  });
  const reference = Uint8Array.from(Buffer.from(REFERENCE_PNG_BASE64, 'base64'));
  // 同步端点单次调用即可重试容错（与调度器任务级重试同语义）：限流/瞬时网络
  // 归一可重试码；失败不判死，20 秒间隔最多重试 6 次（官方建议超时 60–360s）。
  let submission;
  for (let submitAttempt = 1; ; submitAttempt += 1) {
    try {
      submission = await adapter.submit(
        {
          invocationId,
          modelId,
          prompt:
            'keep the flat teal background, add a white paper lantern, vertical cinematic poster',
          referenceImages: [{ bytes: reference, mimeType: 'image/png' }],
          size: { height: 1920, width: 1080 },
        },
        new AbortController().signal,
      );
      break;
    } catch (caught) {
      const code = adapter.normalizeError(caught).code;
      if (
        (code === 'MODEL_PROVIDER_ERROR' ||
          code === 'MODEL_NETWORK_ERROR' ||
          code === 'MODEL_RATE_LIMITED' ||
          code === 'MODEL_TIMEOUT') &&
        submitAttempt < 6
      ) {
        console.info(
          `[agnes-image-canary] ${modelId} submit retryable ${code} · attempt=${String(submitAttempt)} · wait 20s`,
        );
        await sleep(20_000);
        continue;
      }
      throw caught;
    }
  }
  expect(submission.kind).toBe('SYNC');
  if (submission.kind !== 'SYNC') return;
  // 脱敏证据：只留任务 ID 前缀，不含 Key、结果 URL 或原始响应。
  console.info(
    `[agnes-image-canary] ${modelId} submit ok · task=${submission.result.providerRequestId?.slice(0, 8) ?? 'n/a'}…`,
  );

  const download = await adapter.download(submission.result, new AbortController().signal);
  expect(['image/png', 'image/jpeg', 'image/webp']).toContain(download.mimeType);
  expect(download.bytes.byteLength).toBeGreaterThan(1024);
  console.info(
    `[agnes-image-canary] ${modelId} DONE · mime=${download.mimeType} · bytes=${String(download.bytes.byteLength)} · sha256=${createHash('sha256').update(download.bytes).digest('hex').slice(0, 16)}…`,
  );
};

describe.skipIf(!gated || apiKey === '')('AgnesImageModelAdapter 真实 Canary', () => {
  it('2.5 Flash（默认档）9:16 img2img 参考图经真实端点同步出图', { timeout: 600_000 }, async () => {
    await runRealGeneration(DEFAULT_AGNES_IMAGE_MODEL_ID, 'agnes-image-canary-25f-0001');
  });

  it('2.1 Flash 20 秒间隔后同链验证（双模型请求形状一致）', { timeout: 600_000 }, async () => {
    await sleep(20_000);
    await runRealGeneration(AGNES_IMAGE_2_1_FLASH_MODEL_ID, 'agnes-image-canary-21f-0001');
  });
});
