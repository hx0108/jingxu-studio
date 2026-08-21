import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TransferFilePort } from '@jingxu/application';
import { BrowserWindow, dialog } from 'electron';

export interface TransferFileSinkOptions {
  readonly exportDirectory?: string | undefined;
  readonly importFile?: string | undefined;
}

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const createTransferFileSink = (options: TransferFileSinkOptions): TransferFilePort => ({
  readSelectedJson: async () => {
    let selectedPath = options.importFile;
    if (selectedPath === undefined) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const result =
        window === null
          ? await dialog.showOpenDialog({
              filters: [{ extensions: ['json'], name: 'JSON' }],
              properties: ['openFile'],
            })
          : await dialog.showOpenDialog(window, {
              filters: [{ extensions: ['json'], name: 'JSON' }],
              properties: ['openFile'],
            });
      if (result.canceled || result.filePaths[0] === undefined) return null;
      selectedPath = result.filePaths[0];
    }
    const bytes = await readFile(selectedPath);
    return { bytes, sha256: hashBytes(bytes) };
  },
  writeJsonAtomically: async (defaultFileName, bytes, overwriteConfirmed) => {
    let selectedPath: string | undefined;
    if (options.exportDirectory !== undefined) {
      await mkdir(options.exportDirectory, { recursive: true });
      selectedPath = path.join(options.exportDirectory, defaultFileName);
    } else {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const result =
        window === null
          ? await dialog.showSaveDialog({
              defaultPath: defaultFileName,
              filters: [{ extensions: ['json'], name: 'JSON' }],
            })
          : await dialog.showSaveDialog(window, {
              defaultPath: defaultFileName,
              filters: [{ extensions: ['json'], name: 'JSON' }],
            });
      if (result.canceled)
        return { byteSize: 0, outcome: 'cancelled', sha256: '' };
      selectedPath = result.filePath;
    }
    if (!overwriteConfirmed) {
      try {
        const existing = await open(selectedPath, 'r');
        await existing.close();
        return { byteSize: 0, outcome: 'failed', sha256: '' };
      } catch {
        // The target does not exist; continue with an atomic write.
      }
    }
    const temporaryPath = `${selectedPath}.${String(process.pid)}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      const handle = await open(temporaryPath, 'r+');
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, selectedPath);
      return { byteSize: bytes.byteLength, outcome: 'written', sha256: hashBytes(bytes) };
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      return { byteSize: 0, outcome: 'failed', sha256: '' };
    }
  },
});
