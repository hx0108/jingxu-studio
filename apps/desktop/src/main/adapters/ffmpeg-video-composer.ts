import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { VideoComposerPort, VideoMetadataProbePort } from '@jingxu/application';
import type { ContentAddressedStore } from '@jingxu/persistence';
import type { VideoExportFileSink } from '../composition/video-export-file-sink';

const execFileAsync = promisify(execFile);
export interface FfmpegVideoComposerOptions {
  readonly delayBeforeComposeMs?: number | undefined;
  readonly ffmpegPath?: string | undefined;
  readonly ffprobePath?: string | undefined;
  readonly exportFileSink?: VideoExportFileSink | undefined;
  readonly managedRoot: string;
  readonly store: ContentAddressedStore;
}

/** Main Adapter for the application metadata boundary; accepts only managed CAS references. */
export const createFfmpegVideoMetadataProbe = ({
  ffprobePath = bundledBinary('ffprobe'),
  store,
}: Pick<FfmpegVideoComposerOptions, 'ffprobePath' | 'store'>): VideoMetadataProbePort => ({
  probe: async ({ storageRelPath }) => {
    let sourcePath: string;
    try {
      await store.read(storageRelPath);
      sourcePath = await store.resolvePathWithinProjects(storageRelPath);
    } catch {
      throw new Error('VIDEO_SOURCE_CORRUPTED');
    }
    try {
      const { stdout } = await execFileAsync(
        ffprobePath,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath],
        { maxBuffer: 512 * 1024, windowsHide: true },
      );
      const value = JSON.parse(stdout) as { format?: { duration?: unknown }; streams?: unknown[] };
      const video = value.streams?.find(
        (stream): stream is { codec_type?: unknown; height?: unknown; width?: unknown } =>
          typeof stream === 'object' &&
          stream !== null &&
          (stream as { codec_type?: unknown }).codec_type === 'video',
      );
      const durationMs = Math.round(Number(value.format?.duration) * 1_000);
      if (
        video === undefined ||
        typeof video.width !== 'number' ||
        typeof video.height !== 'number' ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0
      )
        throw new Error('VIDEO_OUTPUT_INVALID');
      return {
        durationMs,
        hasAudio:
          value.streams?.some(
            (stream) =>
              typeof stream === 'object' &&
              stream !== null &&
              (stream as { codec_type?: unknown }).codec_type === 'audio',
          ) === true,
        height: video.height,
        width: video.width,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'VIDEO_OUTPUT_INVALID') throw error;
      throw new Error(
        error instanceof Error && error.message.includes('ENOENT')
          ? 'FFMPEG_NOT_AVAILABLE'
          : 'FFMPEG_FAILED',
      );
    }
  },
});

const bundledBinary = (name: string): string => {
  const electronResourcesPath = Reflect.get(process, 'resourcesPath');
  const resourcesPath =
    typeof electronResourcesPath === 'string'
      ? electronResourcesPath
      : path.resolve(import.meta.dirname, '../../../resources');
  return (
    process.env[`JINGXU_${name.toUpperCase()}_PATH`] ??
    path.join(resourcesPath, 'ffmpeg', `${name}.exe`)
  );
};

const quoteConcatPath = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const seconds = (milliseconds: number): string => (milliseconds / 1_000).toFixed(3);
export const buildVideoCompositionFilter = (width: number, height: number, fps: number): string =>
  `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2,fps=${String(fps)}`;

export const buildBackgroundMusicFilter = (
  sourceHasAudio: boolean,
  expectedDurationSec: number,
): string => {
  const filters = `[1:a]volume=0.20,afade=t=out:st=${Math.max(0, expectedDurationSec - 2).toFixed(3)}:d=2,atrim=duration=${expectedDurationSec.toFixed(3)}`;
  return sourceHasAudio
    ? `[0:a]aresample=async=1[source];${filters}[music];[source][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    : `${filters}[aout]`;
};
const ratio = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return null;
  return numerator / denominator;
};

export const createFfmpegVideoComposer = ({
  delayBeforeComposeMs = 0,
  ffmpegPath = bundledBinary('ffmpeg'),
  ffprobePath = bundledBinary('ffprobe'),
  exportFileSink,
  managedRoot,
  store,
}: FfmpegVideoComposerOptions): VideoComposerPort => ({
  compose: async ({
    audioStorageRelPath,
    clips,
    exportJobId,
    fps,
    height,
    projectId,
    signal,
    width,
  }) => {
    const temporaryRoot = path.join(managedRoot, 'tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const suffix = randomUUID();
    const listPath = path.join(temporaryRoot, `video-compose-${suffix}.txt`);
    const outputPath = path.join(temporaryRoot, `video-compose-${suffix}.mp4`);
    const resolve = async (storageRelPath: string): Promise<string> => {
      try {
        // 导出前重新读取并按内容寻址文件名复算哈希，防止磁盘替换后 FFmpeg
        // 把损坏片段编码为“成功”产物。
        await store.read(storageRelPath);
        return await store.resolvePathWithinProjects(storageRelPath);
      } catch {
        throw new Error('VIDEO_SOURCE_CORRUPTED');
      }
    };
    try {
      if (delayBeforeComposeMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayBeforeComposeMs));
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const concatLines: string[] = [];
      const resolvedClips: string[] = [];
      for (const clip of clips) {
        const resolved = await resolve(clip.storageRelPath);
        resolvedClips.push(resolved);
        concatLines.push(`file ${quoteConcatPath(resolved)}`);
        concatLines.push(`inpoint ${seconds(clip.trimInMs)}`);
        concatLines.push(`outpoint ${seconds(clip.trimOutMs)}`);
      }
      const expectedDurationSec = clips.reduce(
        (total, clip) => total + (clip.trimOutMs - clip.trimInMs) / 1_000,
        0,
      );
      const sourceHasAudio = await (async () => {
        const probes = await Promise.all(
          resolvedClips.map((clipPath) =>
            execFileAsync(
              ffprobePath,
              [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=index',
                '-of',
                'csv=p=0',
                clipPath,
              ],
              { maxBuffer: 128 * 1024, windowsHide: true },
            ),
          ),
        );
        return probes.some(({ stdout }) => stdout.trim().length > 0);
      })();
      await writeFile(listPath, `${concatLines.join('\n')}\n`, 'utf8');
      const audioInput =
        audioStorageRelPath === null
          ? []
          : ['-stream_loop', '-1', '-i', await resolve(audioStorageRelPath)];
      const audioFilters =
        audioStorageRelPath === null
          ? []
          : ['-filter_complex', buildBackgroundMusicFilter(sourceHasAudio, expectedDurationSec)];
      const args = [
        '-hide_banner',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        ...audioInput,
        '-map',
        '0:v:0',
        ...(audioStorageRelPath === null ? ['-map', '0:a?'] : ['-map', '[aout]']),
        ...audioFilters,
        '-vf',
        buildVideoCompositionFilter(width, height, fps),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-shortest',
        outputPath,
      ];
      await execFileAsync(ffmpegPath, args, { maxBuffer: 512 * 1024, signal, windowsHide: true });
      const probe = await execFileAsync(
        ffprobePath,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath],
        { maxBuffer: 512 * 1024, signal, windowsHide: true },
      );
      const parsed: unknown = JSON.parse(probe.stdout);
      if (!isValidVideoCompositionProbe(parsed, width, height, fps, expectedDurationSec))
        throw new Error('VIDEO_OUTPUT_INVALID');
      const bytes = await readFile(outputPath);
      if (bytes.byteLength === 0) throw new Error('VIDEO_OUTPUT_INVALID');
      const stored = await store.write({
        bytes,
        mimeType: 'video/mp4',
        namespace: 'exports',
        projectId,
      });
      if (exportFileSink !== undefined) {
        await exportFileSink.saveMp4({ exportJobId, sourcePath: outputPath });
      }
      return {
        byteSize: stored.byteSize,
        fileSha256: stored.sha256,
        storageRelPath: stored.storageRelPath,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'VIDEO_OUTPUT_INVALID' ||
          error.message === 'VIDEO_SOURCE_CORRUPTED' ||
          error.message === 'VIDEO_EXPORT_CANCELLED' ||
          error.message === 'VIDEO_EXPORT_WRITE_FAILED' ||
          error.name === 'AbortError')
      )
        throw error;
      const code =
        error instanceof Error && error.message.includes('ENOENT')
          ? 'FFMPEG_NOT_AVAILABLE'
          : 'FFMPEG_FAILED';
      throw new Error(code);
    } finally {
      await Promise.all([rm(listPath, { force: true }), rm(outputPath, { force: true })]);
    }
  },
});

export const isValidVideoCompositionProbe = (
  value: unknown,
  width: number,
  height: number,
  fps: number,
  expectedDurationSec: number,
): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const streams = (value as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return false;
  const videos = streams.filter(
    (stream) =>
      typeof stream === 'object' &&
      stream !== null &&
      (stream as { codec_type?: unknown }).codec_type === 'video',
  );
  if (videos.length !== 1) return false;
  const video = videos[0] as {
    avg_frame_rate?: unknown;
    duration?: unknown;
    height?: unknown;
    width?: unknown;
  };
  const duration = Number(
    video.duration ?? (value as { format?: { duration?: unknown } }).format?.duration,
  );
  const actualFps = ratio(video.avg_frame_rate);
  return (
    video.width === width &&
    video.height === height &&
    actualFps !== null &&
    Math.abs(actualFps - fps) < 0.01 &&
    Number.isFinite(duration) &&
    duration > 0 &&
    Math.abs(duration - expectedDurationSec) <= Math.max(0.25, expectedDurationSec * 0.05)
  );
};
