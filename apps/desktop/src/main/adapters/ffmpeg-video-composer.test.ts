import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MOCK_VIDEO_MP4_BYTES } from '@jingxu/model-adapters';
import { createContentAddressedStore } from '@jingxu/persistence';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildAudioFilterGraph,
  buildBackgroundMusicFilter,
  buildExtendedVideoFilterGraph,
  buildVideoCompositionFilter,
  createFfmpegVideoComposer,
  createFfmpegVideoMetadataProbe,
  isValidVideoCompositionProbe,
  usesFilterGraphPath,
} from './ffmpeg-video-composer';

const execFileAsync = promisify(execFile);
const resourceDirectory = path.resolve(import.meta.dirname, '../../../resources/ffmpeg');
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-ffmpeg-composer-'));
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('FfmpegVideoComposer', () => {
  it('参数与质量规则—冻结规格、BGM 混音、淡出、时长和单视频流约束', () => {
    expect(buildVideoCompositionFilter(1080, 1920, 24)).toBe(
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24',
    );
    expect(buildBackgroundMusicFilter(false, 10)).toContain(
      'volume=0.20,afade=t=out:st=8.000:d=2,atrim=duration=10.000[aout]',
    );
    expect(buildBackgroundMusicFilter(true, 10)).toContain(
      '[source][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
    );
    // BGM 音量数据化（§6.1）：缺省=旧硬编码现状，显式传入即按数据生成。
    expect(buildBackgroundMusicFilter(false, 10, 0.35)).toContain('volume=0.35');
    const valid = {
      format: { duration: '1.000' },
      streams: [
        {
          avg_frame_rate: '24/1',
          codec_type: 'video',
          duration: '1.000',
          height: 1920,
          width: 1080,
        },
      ],
    };
    expect(isValidVideoCompositionProbe(valid, 1080, 1920, 24, 1)).toBe(true);
    expect(isValidVideoCompositionProbe({ ...valid, streams: [] }, 1080, 1920, 24, 1)).toBe(false);
    expect(isValidVideoCompositionProbe(valid, 720, 1280, 24, 1)).toBe(false);
    expect(isValidVideoCompositionProbe(valid, 1080, 1920, 30, 1)).toBe(false);
    expect(isValidVideoCompositionProbe(valid, 1080, 1920, 24, 3)).toBe(false);
  });

  it('Metadata Probe—只接受内容寻址引用并返回标准化媒体摘要', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000000',
    });
    const metadata = await createFfmpegVideoMetadataProbe({
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      store,
    }).probe({ storageRelPath: source.storageRelPath });
    expect(metadata).toMatchObject({ hasAudio: false, height: 48, width: 48 });
    expect(metadata.durationMs).toBeGreaterThan(0);
  });

  it('真实 FFmpeg—可解码候选合成后—通过规格探测、内容寻址与 Main 原子落盘', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000001',
    });
    const saved: string[] = [];
    const composer = createFfmpegVideoComposer({
      exportFileSink: {
        saveMp4: async ({ sourcePath }) => {
          saved.push(await readFile(sourcePath, 'base64'));
        },
      },
      ffmpegPath: path.join(resourceDirectory, 'ffmpeg.exe'),
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      managedRoot: root,
      store,
    });

    const result = await composer.compose({
      audioStorageRelPath: null,
      clips: [{ storageRelPath: source.storageRelPath, trimInMs: 0, trimOutMs: 1_000 }],
      exportJobId: 'export_00000001',
      fps: 6,
      height: 48,
      projectId: 'project_00000001',
      signal: new AbortController().signal,
      width: 48,
    });

    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(saved).toHaveLength(1);
    const outputPath = await store.resolvePathWithinProjects(result.storageRelPath);
    const { stdout } = await execFileAsync(path.join(resourceDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height,avg_frame_rate',
      '-of',
      'json',
      outputPath,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      streams: [expect.objectContaining({ codec_type: 'video', height: 48, width: 48 })],
    });
  }, 30_000);

  it('真实 BGM—按整集时长混入并输出一个可解码音轨', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000003',
    });
    const wavPath = path.join(root, 'background-unit.wav');
    await execFileAsync(path.join(resourceDirectory, 'ffmpeg.exe'), [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);
    const audio = await store.write({
      bytes: await readFile(wavPath),
      mimeType: 'audio/wav',
      namespace: 'audio',
      projectId: 'project_00000003',
    });
    const composer = createFfmpegVideoComposer({
      ffmpegPath: path.join(resourceDirectory, 'ffmpeg.exe'),
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      managedRoot: root,
      store,
    });
    const result = await composer.compose({
      audioStorageRelPath: audio.storageRelPath,
      clips: [{ storageRelPath: source.storageRelPath, trimInMs: 0, trimOutMs: 1_000 }],
      exportJobId: 'export_00000003',
      fps: 6,
      height: 48,
      projectId: 'project_00000003',
      signal: new AbortController().signal,
      width: 48,
    });
    const outputPath = await store.resolvePathWithinProjects(result.storageRelPath);
    const { stdout } = await execFileAsync(path.join(resourceDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      outputPath,
    ]);
    expect((JSON.parse(stdout) as { streams: unknown[] }).streams).toHaveLength(1);
  }, 30_000);

  it('滤镜图路径判据与数据驱动构建（§6.1）', () => {
    // 回归锁判据：无配音且零延展 → 现状 concat 路径。
    expect(usesFilterGraphPath([], 0)).toBe(false);
    expect(usesFilterGraphPath([{ extendedMs: 0 }], 0)).toBe(false);
    expect(usesFilterGraphPath([{ extendedMs: undefined }], 0)).toBe(false);
    expect(usesFilterGraphPath([{ extendedMs: 1 }], 0)).toBe(true);
    expect(usesFilterGraphPath([], 1)).toBe(true);

    const audio = buildAudioFilterGraph({
      backgroundMusic: { inputIndex: 3, volume: 0.35 },
      durationSec: 4,
      sourceAudios: [{ inputIndex: 0, startMs: 1_500 }],
      voices: [
        { inputIndex: 1, offsetMs: 250, trimInMs: 0, trimOutMs: 1_200, volume: 0.9 },
        { inputIndex: 2, offsetMs: 2_000, trimInMs: 100, trimOutMs: 1_600, volume: 0.5 },
      ],
    });
    expect(audio).toContain(
      '[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=1500:all=1[mixsrc0]',
    );
    expect(audio).toContain(
      '[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=0.000:end=1.200,asetpts=PTS-STARTPTS,volume=0.900,adelay=250:all=1[mixsrc1]',
    );
    expect(audio).toContain(
      '[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=0.100:end=1.600,asetpts=PTS-STARTPTS,volume=0.500,adelay=2000:all=1[mixsrc2]',
    );
    expect(audio).toContain(
      '[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.35,afade=t=out:st=2.000:d=2.000,atrim=duration=4.000[mixsrc3]',
    );
    expect(audio).toContain(
      'amix=inputs=4:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=4.000,atrim=duration=4.000,alimiter=limit=0.980:level=disabled[aout]',
    );

    const video = buildExtendedVideoFilterGraph({
      clips: [
        { extendedMs: 800, trimInMs: 0, trimOutMs: 500 },
        { extendedMs: 0, trimInMs: 200, trimOutMs: 700 },
      ],
      fps: 24,
      height: 1920,
      width: 1080,
    });
    expect(video).toContain(
      '[0:v]trim=start=0.000:end=0.500,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24,tpad=stop_mode=clone:stop_duration=0.800,',
    );
    expect(video).toContain('[1:v]trim=start=0.200:end=0.700,setpts=PTS-STARTPTS,scale=');
    expect(video.endsWith(';[v0][v1]concat=n=2:v=1:a=0[vout]')).toBe(true);

    // 纯延展无任何音频输入时，混音段为空字符串（调用方省略 [aout] 映射）。
    expect(
      buildAudioFilterGraph({
        backgroundMusic: null,
        durationSec: 2,
        sourceAudios: [],
        voices: [],
      }),
    ).toBe('');
  });

  it('真实滤镜图导出—配音 adelay 混音 + tpad 静帧延展按时长校验通过且无临时残留', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000004',
    });
    const voiceWav = path.join(root, 'voice-unit.wav');
    await execFileAsync(path.join(resourceDirectory, 'ffmpeg.exe'), [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000',
      '-t',
      '1.2',
      '-c:a',
      'pcm_s16le',
      voiceWav,
    ]);
    const voice = await store.write({
      bytes: await readFile(voiceWav),
      mimeType: 'audio/wav',
      namespace: 'audio',
      projectId: 'project_00000004',
    });
    const composer = createFfmpegVideoComposer({
      ffmpegPath: path.join(resourceDirectory, 'ffmpeg.exe'),
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      managedRoot: root,
      store,
    });
    // 期望时长 = (500ms + 延展 800ms) + 500ms = 1.8s；配音偏移 250ms。
    const result = await composer.compose({
      audioStorageRelPath: null,
      clips: [
        { extendedMs: 800, storageRelPath: source.storageRelPath, trimInMs: 0, trimOutMs: 500 },
        { storageRelPath: source.storageRelPath, trimInMs: 200, trimOutMs: 700 },
      ],
      exportJobId: 'export_00000004',
      fps: 6,
      height: 48,
      projectId: 'project_00000004',
      signal: new AbortController().signal,
      voices: [
        {
          offsetMs: 250,
          storageRelPath: voice.storageRelPath,
          trimInMs: 0,
          trimOutMs: 1_200,
          volume: 0.9,
        },
      ],
      width: 48,
    });
    expect(result.byteSize).toBeGreaterThan(0);
    const outputPath = await store.resolvePathWithinProjects(result.storageRelPath);
    const { stdout } = await execFileAsync(path.join(resourceDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      outputPath,
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    expect(parsed.streams?.filter((stream) => stream.codec_type === 'video')).toHaveLength(1);
    expect(parsed.streams?.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1);
    // compose 内部已按期望时长 1.8s 过规格探测；此处仅二次确认事实维度。
    expect(Number(parsed.format?.duration)).toBeGreaterThan(1.55);
    expect(Number(parsed.format?.duration)).toBeLessThan(2.05);
    await expect(readdir(path.join(root, 'tmp'))).resolves.toHaveLength(0);
  }, 30_000);

  it('纯静帧延展无音频输入—输出无声视频并省略音频映射', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000005',
    });
    const composer = createFfmpegVideoComposer({
      ffmpegPath: path.join(resourceDirectory, 'ffmpeg.exe'),
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      managedRoot: root,
      store,
    });
    const result = await composer.compose({
      audioStorageRelPath: null,
      clips: [
        { extendedMs: 400, storageRelPath: source.storageRelPath, trimInMs: 0, trimOutMs: 600 },
      ],
      exportJobId: 'export_00000005',
      fps: 6,
      height: 48,
      projectId: 'project_00000005',
      signal: new AbortController().signal,
      width: 48,
    });
    const outputPath = await store.resolvePathWithinProjects(result.storageRelPath);
    const { stdout } = await execFileAsync(path.join(resourceDirectory, 'ffprobe.exe'), [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      outputPath,
    ]);
    expect((JSON.parse(stdout) as { streams: unknown[] }).streams).toHaveLength(0);
  }, 30_000);

  it('源视频哈希复检失败—阻断 FFmpeg 且不写出成功产物', async () => {
    const store = createContentAddressedStore(root);
    const source = await store.write({
      bytes: MOCK_VIDEO_MP4_BYTES,
      mimeType: 'video/mp4',
      namespace: 'videos',
      projectId: 'project_00000002',
    });
    await writeFile(
      await store.resolvePathWithinProjects(source.storageRelPath),
      Uint8Array.from([0, 1, 2, 3]),
    );
    const saveMp4 = vi.fn();
    const composer = createFfmpegVideoComposer({
      exportFileSink: { saveMp4 },
      ffmpegPath: path.join(resourceDirectory, 'ffmpeg.exe'),
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      managedRoot: root,
      store,
    });

    await expect(
      composer.compose({
        audioStorageRelPath: null,
        clips: [{ storageRelPath: source.storageRelPath, trimInMs: 0, trimOutMs: 1_000 }],
        exportJobId: 'export_00000002',
        fps: 6,
        height: 48,
        projectId: 'project_00000002',
        signal: new AbortController().signal,
        width: 48,
      }),
    ).rejects.toThrow('VIDEO_SOURCE_CORRUPTED');
    expect(saveMp4).not.toHaveBeenCalled();
  });
});
