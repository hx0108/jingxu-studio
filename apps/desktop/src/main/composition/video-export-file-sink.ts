import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BrowserWindow, dialog } from 'electron';

export interface VideoExportFileSink {
  saveMp4(input: { readonly exportJobId: string; readonly sourcePath: string }): Promise<void>;
}

export interface VideoExportFileSinkOptions {
  /** Electron E2E 受控注入；生产环境始终由 Main Save Dialog 决定目标。 */
  readonly exportDirectory?: string | undefined;
}

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * 用户可见 MP4 的唯一落盘边界。路径只在 Main 进程短暂存在，先复制到同目录临时文件、
 * fsync 后 rename；取消或失败绝不回传路径，也不留下半成品。
 */
export const createVideoExportFileSink = (
  options: VideoExportFileSinkOptions = {},
): VideoExportFileSink => ({
  saveMp4: async ({ exportJobId, sourcePath }) => {
    const suggestedName = `jingxu-video-${exportJobId}.mp4`;
    let targetPath: string;
    if (options.exportDirectory !== undefined) {
      await mkdir(options.exportDirectory, { recursive: true });
      targetPath = path.join(options.exportDirectory, suggestedName);
    } else {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const result =
        window === null
          ? await dialog.showSaveDialog({
              defaultPath: suggestedName,
              filters: [{ extensions: ['mp4'], name: 'MP4 视频' }],
            })
          : await dialog.showSaveDialog(window, {
              defaultPath: suggestedName,
              filters: [{ extensions: ['mp4'], name: 'MP4 视频' }],
            });
      if (result.canceled) {
        throw new Error('VIDEO_EXPORT_CANCELLED');
      }
      targetPath = result.filePath;
    }

    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, temporaryPath);
      await syncFile(temporaryPath);
      await rename(temporaryPath, targetPath);
    } catch (_error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error('VIDEO_EXPORT_WRITE_FAILED');
    }
  },
});
