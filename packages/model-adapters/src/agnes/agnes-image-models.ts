/**
 * Agnes AI 图片模型的冻结注册表；不接受调用方传入任意模型或 API 域名。
 *
 * 事实源为 2026-09-21 官方 wiki 快照与同日受控真实探针：
 * - 端点 `POST /v1/images/generations`，**同步**单响应（无任务轮询）。
 * - `size` 为档位枚举（"1K".."4K"）+ `ratio`（8 种）；精确 WxH 非原生。
 * - 参考图走 `extra_body.image`（data URI 直接可用）；`response_format` 必须
 *   嵌在 `extra_body` 内（顶层会被服务端拒绝）。
 * - 实测响应：`{created, task_id, data:[{url, b64_json:"", revised_prompt:""}]}`；
 *   结果域名 `platform-outputs.agnes-ai.space`（与视频输出同域族）。
 * - 双模型请求形状一致（2.1/2.5 仅 `model` 字段不同），适配器按请求分发。
 */
export const AGNES_IMAGE_MODEL_IDS = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash'] as const;
export type AgnesImageModelId = (typeof AGNES_IMAGE_MODEL_IDS)[number];

export const DEFAULT_AGNES_IMAGE_MODEL_ID = 'agnes-image-2.5-flash' as const;
export const AGNES_IMAGE_2_1_FLASH_MODEL_ID = 'agnes-image-2.1-flash' as const;
export const AGNES_IMAGE_PROFILE_ID = 'profile-image-agnes-primary' as const;
export const AGNES_IMAGE_SNAPSHOT_DATE = '2026-09-21' as const;

/** API 域为固定常量（无 Workspace 拼接，SSRF 面收敛）。 */
export const AGNES_IMAGE_GENERATIONS_URL = 'https://apihub.agnes-ai.com/v1/images/generations' as const;

/** 官方建议客户端超时 60–360s（4K/复杂提示词取上限）。 */
export const AGNES_IMAGE_INVOCATION_TIMEOUT_MS = 360_000;

/**
 * 结果下载域按 Agnes 注册域后缀匹配（2026-09-21 实测图片输出域
 * `platform-outputs.agnes-ai.space`，与视频侧 09-19 实测同域族；CDN 桶随
 * 任务变化，固定单域清单不成立）。HTTPS、无 userinfo、禁重定向守卫在
 * Adapter 层另行执行。
 */
export const AGNES_IMAGE_DOWNLOAD_DOMAIN_SUFFIXES = ['agnes-ai.cn', 'agnes-ai.space'] as const;

/** 官方支持的 8 种画幅比（宽:高约分形态）。 */
export const AGNES_IMAGE_RATIOS: readonly string[] = [
  '1:1',
  '3:4',
  '4:3',
  '16:9',
  '9:16',
  '2:3',
  '3:2',
  '21:9',
];

/**
 * 档位按总像素分桶（各 ratio 官方矩阵点全部正确落桶，含 3136×1344=4.21MP
 * 边界归 2K）；超出最大桶按 4K 收口。
 */
const TIER_PIXEL_BUCKETS: readonly Readonly<{ label: string; maxPixels: number }>[] = [
  { label: '1K', maxPixels: 1_100_000 },
  { label: '2K', maxPixels: 4_300_000 },
  { label: '3K', maxPixels: 9_600_000 },
];

export const isAgnesImageModelId = (value: string): value is AgnesImageModelId =>
  (AGNES_IMAGE_MODEL_IDS as readonly string[]).includes(value);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** WxH → {档位, 画幅比}：先约分精确匹配 ratio，无命中取对数空间最近邻。 */
export const deriveAgnesImageSize = (
  size: Readonly<{ height: number; width: number }>,
): Readonly<{ ratio: string; size: string }> => {
  const pixels = size.width * size.height;
  const bucket = TIER_PIXEL_BUCKETS.find((entry) => pixels <= entry.maxPixels);
  const tier = bucket?.label ?? '4K';
  const divisor = gcd(size.width, size.height);
  const reduced = `${String(Math.round(size.width / divisor))}:${String(Math.round(size.height / divisor))}`;
  if (AGNES_IMAGE_RATIOS.includes(reduced)) return { ratio: reduced, size: tier };
  const target = Math.log(size.width / size.height);
  let nearest = '1:1';
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of AGNES_IMAGE_RATIOS) {
    const [rw, rh] = ratio.split(':');
    if (rw === undefined || rh === undefined) continue;
    const distance = Math.abs(target - Math.log(Number(rw) / Number(rh)));
    if (distance < nearestDistance) {
      nearest = ratio;
      nearestDistance = distance;
    }
  }
  return { ratio: nearest, size: tier };
};
