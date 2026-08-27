import type {
  AppErrorDto,
  ImageApi,
  ScriptApi,
  StoryboardApi,
  VideoApi,
  VoiceApi,
} from '@jingxu/contracts';

export const getScriptClient = (): ScriptApi => window.jingxu.script;
export const getStoryboardClient = (): StoryboardApi => window.jingxu.storyboard;
export const getJobClient = () => window.jingxu.job;
export const getProviderClient = () => window.jingxu.provider;
export const getImageClient = (): ImageApi => window.jingxu.image;
/** 视频候选只经冻结的 video IPC 白名单访问；Renderer 不接触本地媒体路径。 */
export const getVideoClient = (): VideoApi => window.jingxu.video;
/** 配音候选只经冻结的 voice IPC 白名单访问；Renderer 不接触本地媒体路径。 */
export const getVoiceClient = (): VoiceApi => window.jingxu.voice;
export const createScriptRequestId = (operation: string): string =>
  `${operation}_${globalThis.crypto.randomUUID()}`;

export const rendererTransportError = (): AppErrorDto => ({
  code: 'PROJECT_PERSISTENCE_FAILED',
  fieldErrors: null,
  message: '主进程未返回可验证的结果',
  retryable: true,
  traceId: 'renderer_transport_failure',
  userAction: '请保留当前输入并重试',
});
