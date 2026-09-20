/**
 * Agnes AI 视频模型的冻结注册表；不接受调用方传入任意模型或 API 域名。
 *
 * 事实源为 2026-09-19 官方 wiki 快照与同日受控真实探针（design.md D5b）：
 * - `agnes-video-v2.0`：i2v 走 `image` + `mode:"ti2vid"`，服务端把输入归一到
 *   720P 级预设（实测默认 1088x832），`seconds` 省略时服务端默认 5.0。
 * - `agnes-video-2.5-flash`：i2v 走 `mode:"keyframe"` + `first_frame`（400 实测
 *   确认必需，`images` 数组不被该模式接受），`size` 仅接受 "720P"。
 * - 完成态结果 URL 在顶层 `url` 字段（官方文档写 `metadata.url`，与实测不符）。
 */
export const AGNES_VIDEO_MODEL_IDS = ['agnes-video-v2.0', 'agnes-video-2.5-flash'] as const;
export type AgnesVideoModelId = (typeof AGNES_VIDEO_MODEL_IDS)[number];

export const DEFAULT_AGNES_VIDEO_MODEL_ID = 'agnes-video-v2.0' as const;
export const AGNES_VIDEO_2_5_FLASH_MODEL_ID = 'agnes-video-2.5-flash' as const;
export const AGNES_VIDEO_PROFILE_ID = 'profile-video-agnes-primary' as const;
export const AGNES_VIDEO_SNAPSHOT_DATE = '2026-09-19' as const;

/** 免费档时长固定 5 秒；不开放时长参数（能力快照同源冻结）。 */
export const AGNES_VIDEO_DURATION_SEC = 5 as const;
/** 2.5 Flash 服务端硬校验仅接受 720P；V2.0 由服务端归一到 720P 级预设。 */
export const AGNES_VIDEO_SIZE = '720P' as const;

/** API 域为固定常量（无 Workspace 拼接，SSRF 面收敛）。 */
export const AGNES_VIDEO_CREATE_URL = 'https://apihub.agnes-ai.com/v1/videos' as const;
export const AGNES_VIDEO_POLL_BASE_URL = 'https://apihub.agnes-ai.com/agnesapi' as const;
/**
 * 结果下载域按 Agnes 注册域后缀匹配（2026-09-19 实测两个输出域：
 * `cos-platform-outputs.agnes-ai.cn` 与 `platform-outputs.agnes-ai.space`，
 * CDN 桶随任务变化，固定单域清单不成立）。HTTPS、无 userinfo、禁重定向
 * 守卫在 Adapter 层另行执行。
 */
export const AGNES_VIDEO_DOWNLOAD_DOMAIN_SUFFIXES = ['agnes-ai.cn', 'agnes-ai.space'] as const;

export const isAgnesVideoModelId = (value: string): value is AgnesVideoModelId =>
  (AGNES_VIDEO_MODEL_IDS as readonly string[]).includes(value);

export const isAgnesVideo25Flash = (modelId: string): boolean =>
  modelId === AGNES_VIDEO_2_5_FLASH_MODEL_ID;
