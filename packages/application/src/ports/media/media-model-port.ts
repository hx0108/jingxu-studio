import type { ImageModelPort } from '../image-model/image-model-port';
import type { ImageTaskSubmission } from '../image-model/image-model-types';

/**
 * 调度器媒体模型结构契约（shot-video-generation design A2）。
 *
 * 图片（Seedream/Mock）与视频（Seedance/Mock）适配器共用 ImageModelPort 的
 * 方法集与判别联合形态（submit SYNC/ASYNC、poll PENDING|SUCCEEDED|FAILED、
 * download、normalizeError、evidenceOf），仅请求载荷 R 按媒体域定义——
 * 图片 ImageModelPort 即 MediaModelPort<ImageGenerationRequest> 的结构实例。
 */
export type MediaModelPort<R> = Omit<ImageModelPort, 'submit'> & {
  submit(request: R, signal: AbortSignal): Promise<ImageTaskSubmission>;
};
