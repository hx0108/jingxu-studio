import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { BrowserWindow, dialog } from 'electron';

export interface VideoAudioFileSinkOptions {
  readonly importFile?: string | undefined;
  readonly ffprobePath?: string | undefined;
}

export interface SelectedVideoAudioFile {
  readonly bytes: Uint8Array;
  readonly mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/x-m4a' | 'audio/mp4';
  readonly originalFileName: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, SelectedVideoAudioFile['mimeType']>> = {
  '.m4a': 'audio/x-m4a',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const execFileAsync = promisify(execFile);
const bundledProbe = (): string =>
  process.env.JINGXU_FFPROBE_PATH ?? path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe');

export const createVideoAudioFileSink = (
  options: VideoAudioFileSinkOptions = {},
): { readonly readSelectedAudio: () => Promise<SelectedVideoAudioFile | null> } => ({
  readSelectedAudio: async () => {
    let selectedPath = options.importFile;
    if (selectedPath === undefined) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const picked =
        window === null
          ? await dialog.showOpenDialog({
              filters: [{ extensions: ['mp3', 'wav', 'm4a'], name: '背景音乐' }],
              properties: ['openFile'],
            })
          : await dialog.showOpenDialog(window, {
              filters: [{ extensions: ['mp3', 'wav', 'm4a'], name: '背景音乐' }],
              properties: ['openFile'],
            });
      if (picked.canceled || picked.filePaths[0] === undefined) return null;
      selectedPath = picked.filePaths[0];
    }
    const mimeType = MIME_BY_EXTENSION[path.extname(selectedPath).toLowerCase()];
    if (mimeType === undefined) throw new Error('VIDEO_AUDIO_INVALID');
    const bytes = await readFile(selectedPath);
    if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024)
      throw new Error('VIDEO_AUDIO_INVALID');
    const probe = await execFileAsync(
      options.ffprobePath ?? bundledProbe(),
      ['-v', 'error', '-show_streams', '-select_streams', 'a:0', '-of', 'json', selectedPath],
      { maxBuffer: 256 * 1024, windowsHide: true },
    );
    const parsed: unknown = JSON.parse(probe.stdout);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { streams?: unknown }).streams) ||
      (parsed as { streams: readonly unknown[] }).streams.length === 0
    ) {
      throw new Error('VIDEO_AUDIO_INVALID');
    }
    return { bytes, mimeType, originalFileName: path.basename(selectedPath) };
  },
});
