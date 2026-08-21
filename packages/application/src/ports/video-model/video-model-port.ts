import type { MediaModelPort } from '../media/media-model-port';
import type { VideoGenerationRequest } from './video-model-types';

/**
 * 视频模型 Application Port（shot-video-generation design A3）。
 *
 * 结构对齐图片域（MediaModelPort 结构契约）：Adapter 只做单段 HTTP 与归一化
 * ——Seedance 为真异步（create task→poll→download mp4），submit 恒 ASYNC 形态，
 * 「先持久化 providerTaskId 再轮询」由调度器状态机保证。方舟响应结构、
 * Authorization、Provider 专有错误只允许存在于 SeedanceVideoModelAdapter /
 * MockVideoModelAdapter；重试与状态码路由属确定性代码，不属模型。
 */
export type VideoModelPort = MediaModelPort<VideoGenerationRequest>;
