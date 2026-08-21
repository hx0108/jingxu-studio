import type { TransferWarningCode } from '@jingxu/contracts';

import type { TransferJson } from '../ports/transfer';

/** Bundle 组装输入：全部为已读快照事实（零 I/O、零时钟；时间戳由调用方注入）。 */
export interface TransferBundleAssemblyInput {
  readonly bundleId: string;
  readonly episodeStoryboard: TransferJson;
  readonly exportedAt: string;
  /** ProjectSnapshot 投影（ProjectTransferBundle 1.0.0 四字段，schema additionalProperties=false）。 */
  readonly projectSnapshot: {
    readonly creationMode: string;
    readonly dialogueRenderMode: string;
    readonly name: string;
    readonly projectId: string;
  };
  readonly scriptStageOutputs: readonly {
    readonly output: TransferJson;
    readonly versionId: string;
  }[];
  readonly storyBible: {
    readonly output: TransferJson;
    readonly versionId: string;
  };
}

export interface TransferBundleAssemblyResult {
  readonly bundle: TransferJson;
  readonly warningCodes: readonly TransferWarningCode[];
}

/** 递归键排序的稳定序列化：Bundle 字节哈希必须与对象键序无关（GPT 版 replacer 会丢嵌套键，已废弃）。 */
export const stableTransferJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableTransferJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableTransferJson(nested)}`).join(',')}}`;
};

const MEDIA_REFERENCE_KEYS = new Set(['asset_version_ids', 'assetVersionIds']);

const hasAssetReference = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasAssetReference);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      (MEDIA_REFERENCE_KEYS.has(key) && Array.isArray(nested) && nested.length > 0) ||
      hasAssetReference(nested),
  );
};

/**
 * ProjectTransferBundle 1.0.0 确定性组装纯函数（design.md D1）：
 * 顶层恒为 Schema 七键；project_snapshot 仅保留公开契约四字段（genre/style 等内部列不外泄）。
 * 媒体只保留结构引用（缺失→TRANSFER_MEDIA_NOT_PACKAGED 警告，不阻断导出）。
 */
export const assembleTransferBundle = (
  input: TransferBundleAssemblyInput,
): TransferBundleAssemblyResult => {
  const warningCodes: TransferWarningCode[] = ['TRANSFER_CURRENT_ONLY'];
  if (hasAssetReference(input.episodeStoryboard)) {
    warningCodes.push('TRANSFER_MEDIA_NOT_PACKAGED');
  }
  return {
    bundle: {
      bundle_id: input.bundleId,
      episode_storyboard: input.episodeStoryboard,
      exported_at: input.exportedAt,
      project_snapshot: {
        creation_mode: input.projectSnapshot.creationMode,
        dialogue_render_mode: input.projectSnapshot.dialogueRenderMode,
        name: input.projectSnapshot.name,
        project_id: input.projectSnapshot.projectId,
      },
      schema_version: '1.0.0',
      script_stage_outputs: input.scriptStageOutputs.map((stage) => ({
        output: stage.output,
        version_id: stage.versionId,
      })),
      story_bible: { output: input.storyBible.output, version_id: input.storyBible.versionId },
    },
    warningCodes,
  };
};
