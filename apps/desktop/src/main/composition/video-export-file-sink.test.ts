import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createVideoExportFileSink } from './video-export-file-sink';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('VideoExportFileSink', () => {
  it('受控导出目录—临时复制 fsync 后—只生成完整 MP4', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-export-sink-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.mp4');
    const outputDirectory = path.join(root, 'output');
    await writeFile(sourcePath, Uint8Array.from([1, 2, 3, 4]));

    await createVideoExportFileSink({ exportDirectory: outputDirectory }).saveMp4({
      exportJobId: 'export_00000001',
      sourcePath,
    });

    const outputPath = path.join(outputDirectory, 'jingxu-video-export_00000001.mp4');
    await expect(readFile(outputPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
