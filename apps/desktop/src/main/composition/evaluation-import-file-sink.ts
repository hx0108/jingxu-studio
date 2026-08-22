import { readFile } from 'node:fs/promises';

import type { EvaluationImportFilePort } from '@jingxu/application';
import { BrowserWindow, dialog } from 'electron';

export interface EvaluationImportFileSinkOptions {
  /** E2E 可定路径注入；生产走系统 Open Dialog。 */
  readonly importFile?: string | undefined;
}

/**
 * Main 侧 Evaluation 导入文件 Port（design.md 路径红线）：系统 Open Dialog 选 JSON、
 * Main 内受管理读取，仅向 Application 暴露字节——路径不进 Application、Renderer、
 * 回执或审计（与 transfer sink 的 sourceRef 不同，此处连代称都不需要）。
 */
export const createEvaluationImportFileSink = (
  options: EvaluationImportFileSinkOptions = {},
): EvaluationImportFilePort => ({
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
    return { bytes };
  },
});
