import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MOCK_VIDEO_MP4_BYTES } from '@jingxu/model-adapters';
import { createContentAddressedStore } from '@jingxu/persistence';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildBackgroundMusicFilter,
  buildVideoCompositionFilter,
  createFfmpegVideoComposer,
  createFfmpegVideoMetadataProbe,
  isValidVideoCompositionProbe,
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
