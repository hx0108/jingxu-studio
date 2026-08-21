import { describe, expect, it } from 'vitest';

import { transferWarningCodeSchema } from '@jingxu/contracts';

import { formatTransferWarnings, TRANSFER_WARNING_LABELS } from './transfer-copy';

describe('transfer UI copy（project-transfer-import-export 4.3）', () => {
  it('警告文案穷举 contracts 警告码——新增码未补文案时编译期即失败', () => {
    // Record<TransferWarningCode, string> 已保证编译穷举；运行时再对照 schema 枚举，
    // 防止文案表与契约枚举在重构中被解耦。
    for (const code of transferWarningCodeSchema.options) {
      expect(TRANSFER_WARNING_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  it('formatTransferWarnings 保持警告顺序并按码映射', () => {
    expect(
      formatTransferWarnings(['TRANSFER_CURRENT_ONLY', 'TRANSFER_MEDIA_NOT_PACKAGED']),
    ).toEqual(['快照只包含当前版本（不含历史版本链）', '媒体文件不随快照打包，仅保留结构引用']);
  });
});
