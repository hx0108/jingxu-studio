import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TransferFilePort } from '@jingxu/application';
import { BrowserWindow, dialog } from 'electron';

export interface TransferFileSinkOptions {
  readonly exportDirectory?: string | undefined;
  readonly importFile?: string | undefined;
}

/**
 * Main 侧 Transfer 文件 Port（design.md D3）：导入走系统 Open Dialog，导出走 Save Dialog
 * + 同目录临时文件 + fsync 后原子 rename，目标已存在且未确认覆盖时返回 refused。
 * 路径只在本实现内部存在；对外仅以 targetRef/sourceRef 不透明代称落库，绝不回传 Renderer。
 */
const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const createTransferFileSink = (options: TransferFileSinkOptions): TransferFilePort => ({
  readSelectedJson: async () => {
    let selectedPath = options.importFile;
    if (selectedPath === undefined) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const picked =
        window === null
          ? await dialog.showOpenDialog({
              filters: [{ extensions: ['json'], name: 'JSON' }],
              properties: ['openFile'],
            })
          : await dialog.showOpenDialog(window, {
              filters: [{ extensions: ['json'], name: 'JSON' }],
              properties: ['openFile'],
            });
      if (picked.canceled || picked.filePaths[0] === undefined) return null;
      selectedPath = picked.filePaths[0];
    }
    const bytes = await readFile(selectedPath);
    return { bytes, sha256: hashBytes(bytes), sourceRef: selectedPath };
  },
  writeJsonAtomically: async (defaultFileName, bytes, overwriteConfirmed) => {
    let selectedPath: string;
    if (options.exportDirectory !== undefined) {
      await mkdir(options.exportDirectory, { recursive: true });
      selectedPath = path.join(options.exportDirectory, defaultFileName);
    } else {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const picked =
        window === null
          ? await dialog.showSaveDialog({
              defaultPath: defaultFileName,
              filters: [{ extensions: ['json'], name: 'JSON' }],
            })
          : await dialog.showSaveDialog(window, {
              defaultPath: defaultFileName,
              filters: [{ extensions: ['json'], name: 'JSON' }],
            });
      if (picked.canceled) return { outcome: 'cancelled' };
      selectedPath = picked.filePath;
    }
    if (!overwriteConfirmed) {
      try {
        const existing = await open(selectedPath, 'r');
        await existing.close();
        return { outcome: 'refused' };
      } catch {
        // 目标不存在：继续原子写入。
      }
    }
    const temporaryPath = `${selectedPath}.${String(process.pid)}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      const handle = await open(temporaryPath, 'r+');
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, selectedPath);
      return {
        byteSize: bytes.byteLength,
        outcome: 'written',
        sha256: hashBytes(bytes),
        targetRef: selectedPath,
      };
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      return { outcome: 'failed' };
    }
  },
});
