import type { ScriptStage } from '@jingxu/contracts';

export type CreatorStageStatus = 'MISSING' | 'DRAFT' | 'READY' | 'STALE_INPUT';

export interface CreatorGuideProjectRef {
  readonly id: string;
  readonly updatedAt: string;
}

export interface CreatorGuideProjectSnapshot {
  readonly consistencyBlocks: readonly ('CHARACTER_REFERENCE' | 'STYLE_REFERENCE')[];
  readonly exportReady: boolean;
  readonly imagesReady: boolean;
  readonly projectId: string;
  readonly sourceInputReady: boolean;
  readonly stages: Readonly<Record<ScriptStage, CreatorStageStatus>>;
  readonly videosReady: boolean;
  readonly voiceReady: boolean;
}

/** 首次创作引导只读投影；实现可组合多个 Repository，但不得向 Renderer 泄漏持久化对象。 */
export interface CreatorGuideQueryPort {
  getProjectSnapshot(projectId: string): Promise<CreatorGuideProjectSnapshot | null>;
  listActiveProjects(): Promise<readonly CreatorGuideProjectRef[]>;
}
