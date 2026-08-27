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

/** BGM 默认音量：与 0020 迁移列默认一致（= 旧硬编码现状等效）。 */
export const DEFAULT_BACKGROUND_MUSIC_VOLUME = 0.2;

export const buildBackgroundMusicFilter = (
  sourceHasAudio: boolean,
  expectedDurationSec: number,
  volume: number = DEFAULT_BACKGROUND_MUSIC_VOLUME,
): string => {
  const filters = `[1:a]volume=${volume.toFixed(2)},afade=t=out:st=${Math.max(0, expectedDurationSec - 2).toFixed(3)}:d=2,atrim=duration=${expectedDurationSec.toFixed(3)}`;
  return sourceHasAudio
    ? `[0:a]aresample=async=1[source];${filters}[music];[source][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    : `${filters}[aout]`;
};

/** amix 要求同构输入：混音各链统一头部（采样率/样本格式/声道布局）。 */
const MIX_INPUT_HEAD = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

export interface AudioGraphVoiceSpec {
  readonly inputIndex: number;
  readonly offsetMs: number;
  readonly trimInMs: number;
  readonly trimOutMs: number;
  readonly volume: number;
}

/**
 * 滤镜图路径的混音段（v2 §6.1）：源音轨按镜头起点定位 + N 路配音（adelay 偏移）
 * + BGM（音量/结尾淡出数据化）→ amix(normalize=0)。防削波上限与总时长封顶在
 * 图内确定性表达（alimiter + atrim），不依赖隐式归一。
 */
export const buildAudioFilterGraph = ({
  backgroundMusic,
  durationSec,
  fadeOutSec = 2,
  sourceAudios,
  voices,
}: {
  readonly backgroundMusic: Readonly<{ inputIndex: number; volume: number }> | null;
  readonly durationSec: number;
  readonly fadeOutSec?: number | undefined;
  readonly sourceAudios: readonly Readonly<{ inputIndex: number; startMs: number }>[];
  readonly voices: readonly AudioGraphVoiceSpec[];
}): string => {
  const labels: string[] = [];
  const chains: string[] = [];
  let next = 0;
  const mixLabel = (): [string, string] => {
    const name = `mixsrc${String(next)}`;
    next += 1;
    return [name, `[${name}]`];
  };
  for (const source of sourceAudios) {
    const [name, label] = mixLabel();
    chains.push(
      `[${String(source.inputIndex)}:a]${MIX_INPUT_HEAD},adelay=${String(Math.max(0, Math.round(source.startMs)))}:all=1[${name}]`,
    );
    labels.push(label);
  }
  for (const voice of voices) {
    const [name, label] = mixLabel();
    chains.push(
      `[${String(voice.inputIndex)}:a]${MIX_INPUT_HEAD},atrim=start=${seconds(voice.trimInMs)}:end=${seconds(voice.trimOutMs)},asetpts=PTS-STARTPTS,volume=${voice.volume.toFixed(3)},adelay=${String(Math.max(0, Math.round(voice.offsetMs)))}:all=1[${name}]`,
    );
    labels.push(label);
  }
  if (backgroundMusic !== null) {
    const [name, label] = mixLabel();
    chains.push(
      `[${String(backgroundMusic.inputIndex)}:a]${MIX_INPUT_HEAD},volume=${backgroundMusic.volume.toFixed(2)},afade=t=out:st=${Math.max(0, durationSec - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)},atrim=duration=${durationSec.toFixed(3)}[${name}]`,
    );
    labels.push(label);
  }
  if (labels.length === 0) return '';
  chains.push(
    `${labels.join('')}amix=inputs=${String(labels.length)}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${durationSec.toFixed(3)},atrim=duration=${durationSec.toFixed(3)},alimiter=limit=0.980:level=disabled[aout]`,
  );
  return chains.join(';');
};

export interface FilterGraphClipSpec {
  readonly extendedMs: number;
  readonly trimInMs: number;
  readonly trimOutMs: number;
}

/** 滤镜图路径的视频段：逐片段 trim + tpad 冻末帧延展 → 统一规格链 → concat 滤镜。 */
export const buildExtendedVideoFilterGraph = ({
  clips,
  fps,
  height,
  width,
}: {
  readonly clips: readonly FilterGraphClipSpec[];
  readonly fps: number;
  readonly height: number;
  readonly width: number;
}): string => {
  // tpad 置于 fps 归一之后：静帧延展在输出帧率网格上克隆，帧数与 extendedMs 对齐
  // （tpad 在异构输入帧率上先运行会被 fps 重采样吃掉大部分克隆帧）。
  const chains = clips.map((clip, index) => {
    const tpad =
      clip.extendedMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${seconds(clip.extendedMs)}` : '';
    return `[${String(index)}:v]trim=start=${seconds(clip.trimInMs)}:end=${seconds(clip.trimOutMs)},setpts=PTS-STARTPTS,${buildVideoCompositionFilter(width, height, fps)}${tpad},format=yuv420p,settb=1/${String(fps)}[v${String(index)}]`;
  });
  return `${chains.join(';')};${clips.map((_, index) => `[v${String(index)}]`).join('')}concat=n=${String(clips.length)}:v=1:a=0[vout]`;
};

/**
 * 路径判据（“无配音导出与现状一致”回归锁）：无配音且零延展 → concat demuxer
 * 现状路径不动；否则走滤镜图路径（配音混音/静帧延展无法用 demuxer 表达）。
 */
export const usesFilterGraphPath = (
  clips: readonly Readonly<{ extendedMs?: number | undefined }>[],
  voiceCount: number,
): boolean => voiceCount > 0 || clips.some((clip) => (clip.extendedMs ?? 0) > 0);
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
    backgroundMusicVolume: backgroundMusicVolumeInput,
    clips,
    exportJobId,
    fps,
    height,
    projectId,
    signal,
    voices = [],
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
        (total, clip) => total + (clip.trimOutMs - clip.trimInMs + (clip.extendedMs ?? 0)) / 1_000,
        0,
      );
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
      const sourceHasAudio = probes.some(({ stdout }) => stdout.trim().length > 0);
      const backgroundMusicVolume = backgroundMusicVolumeInput ?? DEFAULT_BACKGROUND_MUSIC_VOLUME;
      // 两条路径共享的尾程：编码执行 → 规格探测校验 → CAS 落盘与命名导出。
      const runFfmpegAndValidate = async (
        args: readonly string[],
      ): Promise<Readonly<{ byteSize: number; fileSha256: string; storageRelPath: string }>> => {
        await execFileAsync(ffmpegPath, [...args], {
          maxBuffer: 512 * 1024,
          signal,
          windowsHide: true,
        });
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
      };
      if (!usesFilterGraphPath(clips, voices.length)) {
        // 现状路径（回归锁）：无配音无延展时保持 concat demuxer 行为不变。
        await writeFile(listPath, `${concatLines.join('\n')}\n`, 'utf8');
        const args = [
          '-hide_banner',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          ...(audioStorageRelPath === null
            ? []
            : ['-stream_loop', '-1', '-i', await resolve(audioStorageRelPath)]),
          '-map',
          '0:v:0',
          ...(audioStorageRelPath === null ? ['-map', '0:a?'] : ['-map', '[aout]']),
          ...(audioStorageRelPath === null
            ? []
            : ['-filter_complex', buildBackgroundMusicFilter(sourceHasAudio, expectedDurationSec)]),
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
        return await runFfmpegAndValidate(args);
      }
      // 滤镜图路径（v2 §6.1）：逐片段 trim+tpad 延展 → concat 滤镜；混音层含
      // 定位源音轨、N 路配音 adelay 与数据化 BGM。输入序：clips → voices → BGM。
      const voicePaths: string[] = [];
      for (const voice of voices) {
        voicePaths.push(await resolve(voice.storageRelPath));
      }
      const resolvedAudio =
        audioStorageRelPath === null ? null : await resolve(audioStorageRelPath);
      const inputSection: string[] = [];
      for (const clipPath of resolvedClips) inputSection.push('-i', clipPath);
      for (const voicePath of voicePaths) inputSection.push('-i', voicePath);
      if (resolvedAudio !== null) inputSection.push('-stream_loop', '-1', '-i', resolvedAudio);
      const graphClips = clips.map((clip) => ({
        extendedMs: clip.extendedMs ?? 0,
        trimInMs: clip.trimInMs,
        trimOutMs: clip.trimOutMs,
      }));
      const clipStartsMs: number[] = [];
      let cursorMs = 0;
      for (const clip of graphClips) {
        clipStartsMs.push(cursorMs);
        cursorMs += clip.trimOutMs - clip.trimInMs + clip.extendedMs;
      }
      const videoFilters = buildExtendedVideoFilterGraph({
        clips: graphClips,
        fps,
        height,
        width,
      });
      const audioFilters = buildAudioFilterGraph({
        backgroundMusic:
          resolvedAudio === null
            ? null
            : { inputIndex: clips.length + voices.length, volume: backgroundMusicVolume },
        durationSec: expectedDurationSec,
        sourceAudios: probes.flatMap(({ stdout }, index) =>
          stdout.trim().length > 0
            ? [{ inputIndex: index, startMs: clipStartsMs[index] ?? 0 }]
            : [],
        ),
        voices: voices.map((voice, index) => ({
          inputIndex: clips.length + index,
          offsetMs: voice.offsetMs,
          trimInMs: voice.trimInMs,
          trimOutMs: voice.trimOutMs,
          volume: voice.volume,
        })),
      });
      const filterComplex =
        audioFilters.length > 0 ? `${videoFilters};${audioFilters}` : videoFilters;
      const args = [
        '-hide_banner',
        '-y',
        ...inputSection,
        '-filter_complex',
        filterComplex,
        '-map',
        '[vout]',
        ...(audioFilters.length > 0 ? ['-map', '[aout]'] : []),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-shortest',
        outputPath,
      ];
      return await runFfmpegAndValidate(args);
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
