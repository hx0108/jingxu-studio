import type { TransferWarningCode } from '@jingxu/contracts';

/**
 * Transfer 警告码的稳定中文文案（project-transfer-import-export 4.3）。
 * Record 穷举 TransferWarningCode：新增警告码未补文案会直接编译失败。
 */
export const TRANSFER_WARNING_LABELS: Readonly<Record<TransferWarningCode, string>> = {
  TRANSFER_CURRENT_ONLY: '快照只包含当前版本（不含历史版本链）',
  TRANSFER_MEDIA_NOT_PACKAGED: '媒体文件不随快照打包，仅保留结构引用',
  TRANSFER_MEDIA_REFERENCE_MISSING: '快照中存在缺失的媒体引用',
  TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE:
    '导入项目为 IMPORTED_SNAPSHOT：重新生成前需补充原始输入并确认数据处理说明',
};

export const formatTransferWarnings = (codes: readonly TransferWarningCode[]): string[] =>
  codes.map((code) => TRANSFER_WARNING_LABELS[code]);
