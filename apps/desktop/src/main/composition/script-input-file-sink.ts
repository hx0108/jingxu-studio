import { readFile } from 'node:fs/promises';

import type { ScriptInputFilePort } from '@jingxu/application';
import { BrowserWindow, dialog } from 'electron';

export interface ScriptInputFileSinkOptions {
  /** Deterministic E2E path; production leaves this unset and opens the system dialog. */
  readonly importFile?: string | undefined;
}

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export const createScriptInputFileSink = (
  options: ScriptInputFileSinkOptions = {},
): ScriptInputFilePort => ({
  readSelectedText: async () => {
    let selectedPath = options.importFile;
    if (selectedPath === undefined) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const picked =
        window === null
          ? await dialog.showOpenDialog({
              filters: [{ extensions: ['txt', 'md'], name: '剧本文本' }],
              properties: ['openFile'],
            })
          : await dialog.showOpenDialog(window, {
              filters: [{ extensions: ['txt', 'md'], name: '剧本文本' }],
              properties: ['openFile'],
            });
      if (picked.canceled || picked.filePaths[0] === undefined) return null;
      selectedPath = picked.filePaths[0];
    }
    const lower = selectedPath.toLowerCase();
    const inputKind = lower.endsWith('.txt') ? 'TXT' : lower.endsWith('.md') ? 'MARKDOWN' : null;
    if (inputKind === null) throw new Error('SCRIPT_INPUT_FORMAT_INVALID');
    const content = decodeUtf8(await readFile(selectedPath));
    return {
      content,
      encoding: 'UTF-8',
      fileName: selectedPath.split(/[\\/]/u).pop() ?? selectedPath,
      inputKind,
    };
  },
});
