/**
 * Project 领域枚举与类型。
 *
 * 枚举字面量与 `0001_initial.sql` 的 projects 表 CHECK 对齐；V1 产品边界（如
 * 固定 LOCAL_DEMO、不可经 UI 切换部署模式）由 Application/Contract 在写入前
 * 进一步收窄。Project 领域类型不含文件路径：项目目录由 Main 从系统管理根与
 * projectId 派生，dataRootRel 仅属于持久化行映射，不进入领域聚合。
 */

export const CREATION_MODES = ['AI_ORIGINAL', 'AUTHORIZED_ADAPTATION', 'AI_OPTIMIZATION'] as const;
export type CreationMode = (typeof CREATION_MODES)[number];

export const DIALOGUE_RENDER_MODES = [
  'NARRATION_FIRST',
  'WEAK_LIP_SYNC',
  'PRECISE_LIP_SYNC',
  'SUBTITLE_ONLY',
] as const;
export type DialogueRenderMode = (typeof DIALOGUE_RENDER_MODES)[number];

export const DEPLOYMENT_MODES = ['LOCAL_DEMO', 'CONTROLLED_EXTERNAL_TEST'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/** V1 默认创作模式与对白模式（UI 未覆盖时使用）。 */
export const DEFAULT_CREATION_MODE: CreationMode = 'AI_ORIGINAL';
export const DEFAULT_DIALOGUE_RENDER_MODE: DialogueRenderMode = 'NARRATION_FIRST';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly genre: string | null;
  readonly style: string | null;
  readonly creationMode: CreationMode;
  readonly dialogueRenderMode: DialogueRenderMode;
  readonly deploymentMode: DeploymentMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}
