import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoryboardExportFileSink } from '@jingxu/application';
import { BrowserWindow, dialog } from 'electron';

/**
 * storyboard-export 落盘 sink（main 侧独占）：save dialog + 写文件 + sha256。
 * 路径红线：返回值只有哈希与计数，文件路径不回传 Renderer。
 * E2E 注入：JINGXU_E2E=1 且给定 exportDir 时跳过真实对话框按默认名定名落盘
 * （真实对话框行为由手工验收）。
 */
export interface DialogStoryboardExportSinkOptions {
  /** E2E 定名落盘目录；生产为 undefined（走真实 save dialog）。 */
  readonly exportDir?: string | undefined;
}

export const createDialogStoryboardExportSink = (
  options: DialogStoryboardExportSinkOptions,
): StoryboardExportFileSink => ({
  write: async (defaultFileName, content) => {
    let targetPath: string | undefined;
    if (process.env.JINGXU_E2E === '1' && options.exportDir !== undefined) {
      targetPath = join(options.exportDir, defaultFileName);
    } else {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const dialogOptions = {
        defaultPath: defaultFileName,
        filters: [{ extensions: ['json'], name: 'JSON' }],
      };
      const picked =
        window === null
          ? await dialog.showSaveDialog(dialogOptions)
          : await dialog.showSaveDialog(window, dialogOptions);
      targetPath = picked.canceled ? undefined : picked.filePath;
    }
    if (targetPath === undefined) return { outcome: 'cancelled' };
    try {
      await writeFile(targetPath, content, 'utf8');
    } catch {
      return { outcome: 'failed' };
    }
    return {
      byteSize: Buffer.byteLength(content, 'utf8'),
      fileSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      outcome: 'written',
    };
  },
});
