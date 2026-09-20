import type { MediaModelPort } from '../media/media-model-port';
import type { VideoProviderProvenance } from '../media/media-repository';
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

/**
 * 按任务冻结事实解析视频 Adapter（low-cost design D4 / 任务 4.2）：输入建档事务
 * 冻结的溯源（Provider/Profile/model/快照/Mock），返回对应 VideoModelPort。
 * 组合根实现固定映射；调度器对每个任务用其冻结值解析——当前偏好变化不影响
 * 在途任务，恢复/迟到处理同源。
 */
export type VideoModelResolver = (provenance: VideoProviderProvenance) => VideoModelPort;
