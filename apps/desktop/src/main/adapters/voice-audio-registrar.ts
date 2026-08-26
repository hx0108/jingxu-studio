import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TtsAudioPayload, VoiceCandidateFileRegistration } from '@jingxu/application';
import type { ContentAddressedStore } from '@jingxu/persistence';

const execFileAsync = promisify(execFile);

/** 候选登记 mime 白名单（0020 voice_candidates.mime_type CHECK 同源）。 */
const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set(['audio/mpeg', 'audio/wav', 'audio/mp4']);

const bundledProbe = (): string => {
  const electronResourcesPath = Reflect.get(process, 'resourcesPath');
  const resourcesPath =
    typeof electronResourcesPath === 'string'
      ? electronResourcesPath
      : path.resolve(import.meta.dirname, '../../../resources');
  return process.env.JINGXU_FFPROBE_PATH ?? path.join(resourcesPath, 'ffmpeg', 'ffprobe.exe');
};

export interface VoiceAudioRegistrarOptions {
  readonly ffprobePath?: string | undefined;
  readonly store: ContentAddressedStore;
}

export interface VoiceAudioRegistrar {
  /**
   * 合成音频登记（tasks 4.3）：CAS `audio` 命名空间写入（同 hash 天然去重）后
   * ffprobe 实测时长——durationMs>0 且存在音频流才放行；mime 白名单外直接拒绝
   * （不落盘）。任何失败抛稳定 Error code，由调度器收敛为候选 FAILED。
   */
  register(payload: TtsAudioPayload, projectId: string): Promise<VoiceCandidateFileRegistration>;
}

export const createVoiceAudioRegistrar = ({
  ffprobePath,
  store,
}: VoiceAudioRegistrarOptions): VoiceAudioRegistrar => ({
  register: async (payload, projectId) => {
    if (!ALLOWED_MIME_TYPES.has(payload.mimeType)) {
      throw new Error('VOICE_AUDIO_MIME_INVALID');
    }
    // CAS 先落盘（temp+rename 原子；同内容同 relPath，天然同 hash 去重）。
    const stored = await store.write({
      bytes: payload.bytes,
      mimeType: payload.mimeType,
      namespace: 'audio',
      projectId,
    });
    const sourcePath = await store.resolvePathWithinProjects(stored.storageRelPath);
    try {
      const { stdout } = await execFileAsync(
        ffprobePath ?? bundledProbe(),
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath],
        { maxBuffer: 512 * 1024, windowsHide: true },
      );
      const parsed = JSON.parse(stdout) as {
        format?: { duration?: unknown };
        streams?: readonly unknown[];
      };
      const hasAudioStream =
        parsed.streams?.some(
          (stream) =>
            typeof stream === 'object' &&
            stream !== null &&
            (stream as { codec_type?: unknown }).codec_type === 'audio',
        ) === true;
      const durationMs = Math.round(Number(parsed.format?.duration) * 1_000);
      if (!hasAudioStream || !Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('VOICE_AUDIO_INVALID');
      }
      return {
        byteSize: stored.byteSize,
        durationMs,
        fileSha256: stored.sha256,
        mimeType: payload.mimeType as VoiceCandidateFileRegistration['mimeType'],
        storageRelPath: stored.storageRelPath,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'VOICE_AUDIO_INVALID') throw error;
      // ffprobe 不可执行/输出不可解析：与无效音频同口径（登记失败，候选 FAILED）。
      throw new Error('VOICE_AUDIO_INVALID');
    }
  },
});
